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
import { snapshotSha256, NATIVE_SNAPSHOT_MAGIC } from "../kernel/native-snapshot.js";
import { loadCartridgeMapperFromBytes } from "../cartridge.js";

export type MediaIngressRequest =
  | { kind: "disk"; role: "drive8"; bytes: Uint8Array; name: string }
  | { kind: "prg"; bytes: Uint8Array; name: string; mode: "load" | "inject-run"; entry?: number }
  | { kind: "crt"; bytes: Uint8Array; name: string; resetPolicy: "reset" | "power-cycle" }
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
  detail: Record<string, unknown>;
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
export async function ingestMedia(ctrl: RuntimeController, req: MediaIngressRequest): Promise<MediaIngressResult> {
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

  // --- dirty-media hard stop for any op that detaches/replaces the disk ---
  const detachesDisk =
    req.kind === "disk" || (req.kind === "eject" && req.role === "drive8");
  if (detachesDisk && drive?.getAttachedMedia?.() && drive.isMediaDirty?.()) {
    throw new Error(
      "media-ingress: mounted disk is dirty (written since attach). v1 has no writable-disk-delta contract, " +
      "so it cannot be swapped/ejected without losing the written state. Aborting (Spec 709 §2.3).",
    );
  }

  // --- boundary: pause, checkpoint-before, apply, checkpoint-after, stay paused ---
  const wasRunning = ctrl.runState === "running";
  if (wasRunning) ctrl.pause();

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
        drive.attachDisk({ kind: format as "d64" | "g64", bytes: req.bytes, readOnly: false });
        ctrl.session.diskPath = req.name; // identity/display name
        detail["name"] = req.name;
        break;
      }
      case "eject": {
        if (req.role === "drive8") {
          drive?.detachDisk?.();
          ctrl.session.diskPath = "";
        } else {
          // cartridge eject: detach + reset so the machine re-vectors to KERNAL
          const bus = (ctrl.session.kernel as { c64Bus?: { attachCartridge?(c: undefined): void } }).c64Bus;
          bus?.attachCartridge?.(undefined);
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
        // real reset so $FFFC re-vectors from the cart (Ultimax/GAME): power-cycle
        // clears RAM, reset keeps it.
        ctrl.session.resetCold("pal-default", { keepRam: req.resetPolicy === "reset" });
        detail["mapperType"] = mapper.getMapperType();
        detail["resetPolicy"] = req.resetPolicy;
        break;
      }
    }
  });

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
  return { ok: true, event, paused: true, detail };
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
