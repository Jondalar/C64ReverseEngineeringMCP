// Spec 707 — backend dump/undump operations (the single implementation shared
// by the Spec 623 monitor `dump`/`undump` commands AND any UI/API control —
// §4: "UI controls never implement separate serialization logic").
//
// Reuses the 705.B controller capture/restore path + the 705.A RuntimeCheckpoint
// + the native .c64re codec. No second snapshot model, no parallel persistence.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath, basename } from "node:path";
import type { RuntimeController } from "../debug/runtime-controller.js";
import {
  writeNativeSnapshot,
  readNativeSnapshot,
  snapshotSha256,
  NATIVE_SNAPSHOT_FORMAT_VERSION,
  type NativeSnapshotMediaInput,
} from "./native-snapshot.js";
import { RUNTIME_CHECKPOINT_SCHEMA_VERSION } from "./runtime-checkpoint.js";

const RUNTIME_VERSION = `c64re-runtime/${RUNTIME_CHECKPOINT_SCHEMA_VERSION}`;

export interface SnapshotMediaSummary {
  role: string; format: string; sourceName?: string; sha256: string; bytes: number;
}
export interface DumpResult {
  path: string; cycle: number; pc: number; machine: string;
  media: SnapshotMediaSummary[]; fileBytes: number; breakpoints: number;
}
export interface UndumpResult {
  path: string; cycle: number; pc: number; machine: string;
  media: SnapshotMediaSummary[]; breakpoints: number; paused: boolean;
}

/**
 * Resolve a snapshot path under the active C64RE project/session root (Spec 707
 * §4 / 623 §7 — "not arbitrary process cwd"). Relative paths resolve under
 * C64RE_PROJECT_DIR (fallback cwd); absolute paths are honored as given.
 */
export function resolveSnapshotPath(p: string): string {
  if (!p || !p.trim()) throw new Error("snapshot path required");
  const root = process.env["C64RE_PROJECT_DIR"] || process.cwd();
  return isAbsolute(p) ? p : resolvePath(root, p);
}

interface CheckpointMediaField { diskPath?: string; imageFormat?: string }

/** Gather the media to embed (Spec 707 v1: clean media embedded by role). */
function gatherMedia(ctrl: RuntimeController, mediaField: CheckpointMediaField): NativeSnapshotMediaInput[] {
  const drive = (ctrl.session.kernel as { drive1541?: {
    getAttachedMedia?(): { kind: string; bytes: Uint8Array; readOnly: boolean } | null;
  } }).drive1541;
  const attached = drive?.getAttachedMedia?.() ?? null;
  if (!attached) return [];
  const sourceName = mediaField.diskPath ? basename(mediaField.diskPath) : undefined;
  return [{
    role: "drive8",
    format: attached.kind || mediaField.imageFormat || "g64",
    sourceName,
    bytes: attached.bytes,
    sha256: snapshotSha256(attached.bytes),
  }];
}

/**
 * `dump` — capture an instruction-boundary checkpoint through the 705.B
 * controller and persist it as a native .c64re snapshot. Refuses a dirty
 * mounted disk (Spec 707 media policy v1: writable-media delta is not yet a
 * supported payload — never silently persist a partial disk state).
 */
export async function dumpRuntimeSnapshot(ctrl: RuntimeController, path: string): Promise<DumpResult> {
  const abs = resolveSnapshotPath(path);

  // Spec 714.3 — the dirty-disk dump reject is RETIRED. The VICE1541 checkpoint
  // now runs save_disks=1, so the mutated GCR image rides in the drive1541 blob.
  // The embedded media payload (gatherMedia → getAttachedMedia) is the clean
  // SOURCE/identity baseline; on undump attachDisk(baseline) builds the GCR
  // buffer + disk identity and then the blob's GCRIMAGE OVERWRITES the tracks
  // (mutable wins, §6.1). A dump after a disk write therefore persists + restores
  // the written content. (The dirty writable-CRT reject below stays until
  // Spec 713/714.5.)

  // Spec 709.11b (writable-CRT policy B): the cartridge checkpoint embeds the
  // ORIGINAL .crt bytes + bank/control state, not flash write-deltas. A flash
  // that was written/erased since attach cannot be restored byte-identically in
  // v1, so reject rather than silently restore the original bytes. Clean
  // (unwritten) cartridges dump/restore normally.
  const cart = (ctrl.session.kernel as { c64Bus?: { getCartridge?(): { isWritableDirty?(): boolean } | undefined } }).c64Bus?.getCartridge?.();
  if (cart?.isWritableDirty?.()) {
    throw new Error(
      "dump: writable CRT state not persistable in v1 — the attached cartridge's flash " +
      "was written/erased since attach, and native snapshots embed only the original .crt " +
      "bytes + bank/control state (no flash delta). Aborting rather than restoring a stale " +
      "flash image (Spec 709.11b policy B).",
    );
  }

  const ref = await ctrl.captureCheckpoint();
  const snapshot = ctrl.checkpointRing.restoreSnapshot(ref.id);
  if (!snapshot) throw new Error("dump: checkpoint capture did not land in the ring");

  // Spec 709.11a — embed the ordered media-ingress history in the payload so a
  // fresh-session undump restores the replayable media evidence (Specs 705/712).
  (snapshot.payload as { mediaEvents?: unknown }).mediaEvents = ctrl.mediaEvents.map((e) => ({ ...e }));

  const mediaField = (snapshot.payload as { media?: CheckpointMediaField }).media ?? {};
  const media = gatherMedia(ctrl, mediaField);

  const bytes = writeNativeSnapshot({
    snapshot, media, runtimeVersion: RUNTIME_VERSION, machineModel: "c64-pal",
    provenance: { checkpointId: ref.id },
  });
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);

  return {
    path: abs, cycle: ref.cycles, pc: (snapshot.payload as { cpu?: { pc?: number } }).cpu?.pc ?? 0,
    machine: "c64-pal",
    media: media.map((m) => ({
      role: m.role, format: m.format, sourceName: m.sourceName,
      sha256: m.sha256 ?? "", bytes: m.bytes?.length ?? 0,
    })),
    fileBytes: bytes.length, breakpoints: ctrl.listBreakpoints().length,
  };
}

/**
 * `undump` — read + validate a native .c64re snapshot, re-establish its media,
 * and restore through the 705.B path (pausing, publishing restored debug state,
 * running the 706.8 audio transport flush). Rejects version/integrity/media
 * failures rather than partially restoring.
 */
export async function undumpRuntimeSnapshot(ctrl: RuntimeController, path: string): Promise<UndumpResult> {
  const abs = resolveSnapshotPath(path);
  let fileBytes: Uint8Array;
  try {
    fileBytes = readFileSync(abs);
  } catch (e) {
    throw new Error(`undump: cannot read snapshot ${abs}: ${(e as Error).message}`);
  }

  // readNativeSnapshot validates magic + format version + sha256 integrity +
  // embedded media sha; it throws a clear error on any failure (no partial).
  const { manifest, snapshot, media } = readNativeSnapshot(fileBytes);

  // Spec 714.3 — re-establish the embedded media FIRST: attachDisk(baseline)
  // rebuilds the drive's GCR buffer + disk identity from the clean source bytes.
  // restoreFromSnapshot() then runs drive1541.restore(blob), whose GCRIMAGE
  // module (save_disks=1) OVERWRITES those tracks with the mutated content —
  // so the embedded baseline never wins over the restored mutable disk (§6.1).
  const drive = (ctrl.session.kernel as { drive1541?: {
    attachDisk?(m: { kind: string; bytes: Uint8Array; readOnly: boolean }): void;
  } }).drive1541;
  const mediaSummary: SnapshotMediaSummary[] = [];
  for (const { ref, bytes } of media) {
    if (ref.role !== "drive8") continue; // v1 single drive
    if (!bytes) {
      // No embedded payload + no external resolution path in v1 → cannot restore
      // the disk safely. Fail rather than continue with a different/absent disk.
      throw new Error(
        `undump: media ${ref.role} has no embedded payload and external media resolution ` +
        `is not supported in v1 (sourceName=${ref.sourceName ?? "?"}, sha256=${ref.sha256}).`,
      );
    }
    const kind = (ref.format === "d64" || ref.format === "g64" || ref.format === "p64") ? ref.format : "g64";
    drive?.attachDisk?.({ kind, bytes, readOnly: false });
    mediaSummary.push({ role: ref.role, format: ref.format, sourceName: ref.sourceName, sha256: ref.sha256, bytes: bytes.length });
  }

  await ctrl.restoreFromSnapshot(snapshot, { pause: true });

  // Spec 709.11a — restore the media-ingress history embedded in the .c64re so
  // it is readable after a fresh-session undump (replace the live array contents
  // in place; the WS media/events route + ingress share this ref).
  const restoredEvents = (snapshot.payload as { mediaEvents?: unknown[] }).mediaEvents;
  if (Array.isArray(restoredEvents)) {
    ctrl.mediaEvents.length = 0;
    ctrl.mediaEvents.push(...(restoredEvents as (typeof ctrl.mediaEvents)));
  }

  return {
    path: abs,
    cycle: manifest.checkpoint.cycle, pc: manifest.checkpoint.pc, machine: manifest.machine.model,
    media: mediaSummary, breakpoints: ctrl.listBreakpoints().length, paused: true,
  };
}

/** One-line human summary for monitor/CLI output. */
export function formatDumpSummary(r: DumpResult): string {
  const media = r.media.length
    ? r.media.map((m) => `${m.role}=${m.sourceName ?? m.format}(${m.format}, ${(m.bytes / 1024).toFixed(0)}KB)`).join(", ")
    : "none";
  return [
    `dumped ${r.path}`,
    `  cycle=${r.cycle} pc=$${r.pc.toString(16).padStart(4, "0")} machine=${r.machine}`,
    `  media: ${media}`,
    `  file=${(r.fileBytes / 1024).toFixed(1)}KB breakpoints=${r.breakpoints} format=v${NATIVE_SNAPSHOT_FORMAT_VERSION}`,
  ].join("\n");
}
export function formatUndumpSummary(r: UndumpResult): string {
  const media = r.media.length
    ? r.media.map((m) => `${m.role}=${m.sourceName ?? m.format}(${m.format})`).join(", ")
    : "none";
  return [
    `undumped ${r.path}`,
    `  cycle=${r.cycle} pc=$${r.pc.toString(16).padStart(4, "0")} machine=${r.machine} (paused)`,
    `  media: ${media}`,
    `  breakpoints=${r.breakpoints}`,
  ].join("\n");
}
