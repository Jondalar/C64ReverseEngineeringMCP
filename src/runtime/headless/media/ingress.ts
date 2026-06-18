// Spec 709 — reproducible media ingress: ONE typed, byte/hash/event-based
// backend service for disk / PRG / CRT / eject. The single media authority:
// UI drag/drop, monitor commands and APIs all call ingestMedia(). Replaces the
// path-based media/mount.ts route as the live ingress contract (mount.ts stays
// only as a thin path→bytes adapter for callers that still pass a path).
//
// Binding rules (Spec 709 §2):
//   - drive8-only in v1; drive9 is REJECTED, not silently registered.
//   - .c64re is NOT media (it is the Spec 707 snapshot undump path).
//   - mid-session disk/cart change runs across RuntimeController boundaries with
//     checkpoint-before/after and stays PAUSED.
//   - a DIRTY writable disk cannot be swapped/ejected (no writable-delta
//     contract in v1) → hard error, no silent data loss.
//   - PRG load vs inject-run is EXPLICIT (no silent loadPrgIntoRam heuristic).
//   - CRT is a REAL live attach (c64Bus.attachCartridge + reset), never a
//     parse-only "success".

import type { RuntimeController } from "../debug/runtime-controller.js";
import { mountDiskMedia } from "./mount-disk-media.js";
import { persistCartridgeToFile } from "./persist-cartridge.js";
import { snapshotSha256, NATIVE_SNAPSHOT_MAGIC } from "../kernel/native-snapshot.js";
import { loadCartridgeMapperFromBytes } from "../cartridge.js";
import { addRecent } from "./recent-files.js";
import type { MediaType } from "./fs-browser.js";

export type MediaIngressRequest =
  | { kind: "disk"; role: "drive8"; bytes: Uint8Array; name: string; backingPath?: string }
  | { kind: "prg"; bytes: Uint8Array; name: string; mode: "load" | "inject-run"; entry?: number }
  | { kind: "crt"; bytes: Uint8Array; name: string; resetPolicy: "reset" | "power-cycle"; backingPath?: string }
  | { kind: "eject"; role: "drive8" | "cartridge" };

export interface MediaIngressEvent {
  cycle: number;
  operation: MediaIngressRequest["kind"];
  role?: string;
  format?: string;
  sha256?: string;
  resetPolicy?: string;
  checkpointBeforeId?: string;
  checkpointAfterId?: string;
}

export interface MediaIngressResult {
  ok: true;
  event: MediaIngressEvent;
  paused: boolean;
  /** Spec 709.12 — the run-state at ingress entry, so a UI adapter can decide
   *  whether to resume after a live insert (the service itself stays paused
   *  unless opts.resumeIfRunning is set). */
  wasRunning: boolean;
  detail: Record<string, unknown>;
}

/** Spec 709.12 — per-call options. The deterministic service default keeps the
 *  machine PAUSED after a mid-session change (replay/branch contract); the live
 *  UI adapter opts in to resume a session that was running before the insert. */
export interface MediaIngressOptions {
  resumeIfRunning?: boolean;
}

// ---- helpers ----
const looksLikeC64re = (bytes: Uint8Array, name: string): boolean =>
  name.toLowerCase().endsWith(".c64re") ||
  (bytes.length >= 8 && Buffer.from(bytes.buffer, bytes.byteOffset, 8).toString("ascii") === NATIVE_SNAPSHOT_MAGIC);

function diskFormat(bytes: Uint8Array, name: string): "d64" | "g64" {
  const n = name.toLowerCase();
  if (n.endsWith(".g64")) return "g64";
  if (n.endsWith(".d64")) return "d64";
  // magic fallback: G64 starts with "GCR-1541"
  if (bytes.length >= 8 && Buffer.from(bytes.buffer, bytes.byteOffset, 8).toString("ascii").startsWith("GCR-1541")) return "g64";
  return "d64";
}

function driveFacade(ctrl: RuntimeController): {
  attachDisk?(m: { kind: "d64" | "g64" | "p64"; bytes: Uint8Array; readOnly: boolean }): void;
  detachDisk?(): void;
  getAttachedMedia?(): { kind: string; bytes: Uint8Array } | null;
  isMediaDirty?(): boolean;
} | undefined {
  return (ctrl.session.kernel as { drive1541?: any }).drive1541;
}

/**
 * The single media-ingress entry point. Applies the operation at a deterministic
 * RuntimeController boundary, records a replayable MediaIngressEvent (with
 * checkpoint-before/after refs), and leaves the controller paused after a
 * mid-session change. Throws a precise error on any rejected case (drive9,
 * .c64re-as-media, dirty disk, parse failure) rather than reporting fake success.
 */
export async function ingestMedia(
  ctrl: RuntimeController,
  req: MediaIngressRequest,
  opts: MediaIngressOptions = {},
): Promise<MediaIngressResult> {
  // --- drive9 hard reject (v1 drive8-only) ---
  const role = (req as { role?: string }).role;
  if (role === "drive9" || role === "9" || (req as { slot?: number }).slot === 9) {
    throw new Error("media-ingress: drive 9 is not supported in v1 (drive8-only). Request rejected, not registered.");
  }

  // --- .c64re is NOT media ---
  if (req.kind !== "eject") {
    const b = (req as { bytes?: Uint8Array }).bytes;
    const nm = (req as { name?: string }).name ?? "";
    if (b && looksLikeC64re(b, nm)) {
      throw new Error("media-ingress: .c64re is a runtime snapshot, not media. Use snapshot/undump (Spec 707), not media ingest.");
    }
  }

  const drive = driveFacade(ctrl);

  // --- Spec 709.13: no branching media intervention while ANY mounted medium is
  // dirty + non-persistable (writable disk delta OR writable CRT flash delta). ---
  // Every ingest captures a before/after checkpoint and records a replayable
  // MediaIngressEvent — a new branch root / intervention (Spec 709 §2.3 + §4). A
  // checkpoint cannot serialize the delta, so the intervention would mint a
  // non-restorable branch. Reject EVERY op (disk / crt / prg / eject) BEFORE any
  // pause / apply / checkpoint / event — no partial apply. This is the SAME
  // shared guard the controller checkpoint chokepoint uses, so dirty disk and
  // dirty CRT are handled identically everywhere.
  const dirtyMedia = ctrl.nonPersistableDirtyMedia();
  if (dirtyMedia) {
    throw new Error(
      `media-ingress: cannot apply a media change — ${dirtyMedia} (Spec 709.13). v1 cannot ` +
      `persist this state, so the intervention would create a non-restorable checkpoint/branch. ` +
      `Aborting (no partial apply, no checkpoint, no event).`,
    );
  }

  // --- boundary: (conditional) pause, checkpoint-before, apply, checkpoint-after ---
  // Spec 709.13.1 — only C64-INTERNAL interventions pause the machine. The 1541
  // is a separate device: inserting/ejecting/swapping a disk leaves the C64
  // running (the drive picks the new image up like real hardware). The cartridge
  // port is PART of the C64 and a CRT op cold-boots it, so CRT (attach/replace/
  // eject) pauses; PRG writes C64 RAM/PC so it pauses too. Checkpoints are still
  // captured atomically via runExclusive whether running or paused.
  const wasRunning = ctrl.runState === "running";
  const requiresPause =
    req.kind === "crt" ||
    req.kind === "prg" ||
    (req.kind === "eject" && req.role === "cartridge");
  if (wasRunning && requiresPause) ctrl.pause();

  const mediaPresent = !!drive?.getAttachedMedia?.() ||
    !!(ctrl.session.kernel as { c64Bus?: { getBankInfo?: () => { cartridgeAttached?: boolean } } }).c64Bus
      ?.getBankInfo?.()?.cartridgeAttached;
  // A fresh session's first medium is the experiment ROOT (after-checkpoint
  // only); a change to an existing/running machine is an intervention (before+
  // after) — Spec 709 §2.2.
  const needBefore = wasRunning || mediaPresent;
  const before = needBefore ? await ctrl.captureCheckpoint() : undefined;

  const detail: Record<string, unknown> = {};
  let format: string | undefined;
  let sha256: string | undefined;

  await ctrl.runExclusive(() => {
    switch (req.kind) {
      case "disk": {
        if (!drive?.attachDisk) throw new Error("media-ingress: no VICE1541 drive to attach disk");
        format = diskFormat(req.bytes, req.name);
        sha256 = snapshotSha256(req.bytes);
        // Spec 742 — route through the one central attach so the backing-file
        // identity is preserved (write-through when local/project-backed).
        mountDiskMedia(
          {
            drive: drive as unknown as import("./mount-disk-media.js").DiskMountDrive,
            getDiskPath: () => ctrl.session.diskPath,
            setDiskPath: (p) => { (ctrl.session as { diskPath: string }).diskPath = p; },
          },
          {
            kind: format as "d64" | "g64",
            name: req.name,
            bytes: req.bytes,
            backingPath: req.backingPath,
            readOnly: false,
            source: req.backingPath ? "project-path" : "uploaded-bytes",
          },
        );
        detail["name"] = req.name;
        if (req.backingPath) detail["backingPath"] = req.backingPath;
        break;
      }
      case "eject": {
        if (req.role === "drive8") {
          drive?.detachDisk?.();
          ctrl.session.diskPath = "";
        } else {
          // BUG-023-cart / Spec 742 — write the programmed flash back to the host
          // .crt BEFORE detaching (VICE saves the .crt on detach). Read-only /
          // non-writable carts are skipped by persistCartridgeToFile.
          const bus = (ctrl.session.kernel as { c64Bus?: {
            attachCartridge?(c: undefined): void;
            getCartridge?(): import("../cartridge.js").HeadlessCartridgeMapper | undefined;
          } }).c64Bus;
          const cartPath = (ctrl.session as { cartPath?: string }).cartPath ?? "";
          if (cartPath) {
            const persisted = persistCartridgeToFile(bus?.getCartridge?.(), cartPath);
            if (persisted.written) detail["cartPersisted"] = persisted.path;
          }
          bus?.attachCartridge?.(undefined);
          (ctrl.session as { cartPath?: string }).cartPath = "";
          ctrl.session.resetCold("pal-default", { keepRam: true });
        }
        detail["role"] = req.role;
        break;
      }
      case "prg": {
        sha256 = snapshotSha256(req.bytes);
        format = "prg";
        const r = loadPrgBytes(ctrl, req.bytes);
        detail["loadAddress"] = r.loadAddress;
        detail["endAddress"] = r.endAddress;
        detail["mode"] = req.mode;
        if (req.mode === "inject-run") {
          const entry = req.entry ?? r.loadAddress;
          (ctrl.session.c64Cpu as { pc: number }).pc = entry & 0xffff;
          detail["entry"] = entry & 0xffff;
        }
        break;
      }
      case "crt": {
        format = "crt";
        sha256 = snapshotSha256(req.bytes);
        const mapper = loadCartridgeMapperFromBytes(req.bytes, req.name); // throws on bad CRT (no fake success)
        const bus = (ctrl.session.kernel as { c64Bus?: { attachCartridge?(c: unknown, m?: { bytes: Uint8Array; name: string }): void } }).c64Bus;
        if (!bus?.attachCartridge) throw new Error("media-ingress: bus has no cartridge attach");
        // Spec 709.7 — pass the source bytes so the checkpoint/.c64re can embed + recreate it.
        bus.attachCartridge(mapper, { bytes: req.bytes, name: req.name });
        // BUG-023-cart / Spec 742 — remember the host .crt path so a writable
        // (EasyFlash) cart can write its programmed flash back on eject/persist.
        (ctrl.session as { cartPath?: string }).cartPath = req.backingPath ?? "";
        // real reset so $FFFC re-vectors from the cart (Ultimax/GAME): power-cycle
        // clears RAM, reset keeps it.
        ctrl.session.resetCold("pal-default", { keepRam: req.resetPolicy === "reset" });
        detail["mapperType"] = mapper.getMapperType();
        if (req.backingPath) detail["backingPath"] = req.backingPath;
        detail["resetPolicy"] = req.resetPolicy;
        break;
      }
    }
  });

  // Spec 265 — record the played medium in the recents list so it reappears in
  // the Media tab. The legacy mount.ts did this; the ingress service dropped it,
  // so a played CARTRIDGE never showed up in Media (and a path-backed disk only
  // by project scan). Only host-file-backed media (a real backingPath) is
  // recallable — uploaded bytes with no path are skipped. PRG carries no path.
  if ((req.kind === "disk" || req.kind === "crt") && req.backingPath) {
    addRecent(req.backingPath, (req.kind === "crt" ? "crt" : format) as MediaType);
  }

  const after = await ctrl.captureCheckpoint();
  if (before) ctrl.checkpointRing.pin(before.id);
  ctrl.checkpointRing.pin(after.id);

  const event: MediaIngressEvent = {
    cycle: ctrl.session.c64Cpu.cycles,
    operation: req.kind,
    role, format, sha256,
    resetPolicy: req.kind === "crt" ? req.resetPolicy : undefined,
    checkpointBeforeId: before?.id,
    checkpointAfterId: after.id,
  };
  // Spec 709.8 — append to the ordered, replayable media-event history.
  ctrl.mediaEvents.push(event);
  // Leak fix (705.B ring): the before/after checkpoints are PINNED so the recent
  // media history stays replayable, but only a bounded window needs anchors. Each
  // media op (disk swap / PRG load / CRT attach) otherwise pins 2 forever → the
  // ring fills with un-evictable entries (unbounded across a long session — and
  // `runtime_swap_disk_and_continue` does eject+mount = 2 ops/swap). Keep the last
  // PINNED_MEDIA_EVENTS pinned; unpin the checkpoints of the event that fell out so
  // the ring can evict them.
  const PINNED_MEDIA_EVENTS = 16;
  const fellOut = ctrl.mediaEvents[ctrl.mediaEvents.length - 1 - PINNED_MEDIA_EVENTS];
  if (fellOut) {
    if (fellOut.checkpointBeforeId) ctrl.checkpointRing.unpin(fellOut.checkpointBeforeId);
    if (fellOut.checkpointAfterId) ctrl.checkpointRing.unpin(fellOut.checkpointAfterId);
  }

  // Spec 709.13.1 — resume semantics:
  //  - A device op (disk insert/eject/swap) never paused → the C64 keeps running.
  //  - A C64-internal op (CRT/PRG) paused for the cold-boot/RAM write; a live UI
  //    insert (opts.resumeIfRunning) resumes it at PAL pacing so the cart boots,
  //    while the deterministic service default stays paused (replay/branch +
  //    differential probes rely on it).
  // A CARTRIDGE op is a POWER-CYCLE: you cannot hot-swap a cart on a real C64 —
  // VICE does the same — so BOTH insert AND eject cold-boot the machine (resetCold
  // above), and a power-cycle ends RUNNING regardless of the prior state (powered
  // on = runs). This is the consistency fix: previously only CRT *insert* ran
  // after (`|| kind === "crt"`) while CRT *eject* fell through to stuck-paused
  // (yellow). Now both cart ops run-after on the live UI path. Disk/PRG keep the
  // prior run-state (wasRunning). The deterministic service path still stays
  // paused via opts.resumeIfRunning=false (replay/branch/differential probes).
  const isCartPowerCycle = req.kind === "crt" || (req.kind === "eject" && req.role === "cartridge");
  const resumeAfter = requiresPause && !!opts.resumeIfRunning && (wasRunning || isCartPowerCycle);
  if (resumeAfter) ctrl.run();
  const paused = ctrl.runState === "paused";
  return { ok: true, event, paused, wasRunning, detail };
}

// Byte-based PRG load (mirrors session.loadPrgIntoRam, no file path). Writes the
// payload at the header load address; sets the BASIC end-of-program pointers
// when loaded at the standard BASIC start ($0801) so a subsequent RUN works.
function loadPrgBytes(ctrl: RuntimeController, bytes: Uint8Array): { loadAddress: number; endAddress: number } {
  if (bytes.length < 2) throw new Error("media-ingress: PRG too short (need 2-byte load header)");
  const loadAddress = (bytes[0]! | (bytes[1]! << 8)) & 0xffff;
  const ram = (ctrl.session.c64Bus as { ram: Uint8Array }).ram;
  const payload = bytes.subarray(2);
  for (let i = 0; i < payload.length; i++) ram[(loadAddress + i) & 0xffff] = payload[i]!;
  const endAddress = (loadAddress + payload.length) & 0xffff;
  if (loadAddress === 0x0801) {
    // VARTAB / end-of-BASIC-program ($2D/$2E) = byte after the program.
    ram[0x2d] = endAddress & 0xff;
    ram[0x2e] = (endAddress >> 8) & 0xff;
  }
  return { loadAddress, endAddress: (endAddress - 1) & 0xffff };
}
