// Spec 742 / BUG-023 — the ONE authoritative disk-media attach path.
//
// Before this, five entry paths (UI picker / WS ingress, runtime_media_mount,
// runtime_session_start, drag&drop, scenario, standalone drive-session) each
// called drive1541.attachDisk independently. Only one threaded the host backing
// path, so a fix in one path did not apply to the others and the UI lost the
// backing-file identity → no host-file write-through (BUG-023).
//
// EVERY disk attach now routes through mountDiskMedia, which:
//   - preserves the backing-file identity (backingPath) when the media is
//     local/project-backed, so writable disks write through to the host file at
//     the VICE diskimage commit (fsimage_*_write_half_track → hostFlush),
//   - treats a disk change as an implicit eject (persists + detaches the
//     outgoing disk first),
//   - records the path identity on the session/target.
// Uploaded bytes with no host file get no backingPath → RAM-only (correct: there
// is no file to write through to).

import { writeFileSync } from "node:fs";

/** Minimal drive surface mountDiskMedia needs (the VICE1541 facade implements it). */
export interface DiskMountDrive {
  attachDisk(m: { kind: "d64" | "g64" | "p64"; bytes: Uint8Array; readOnly: boolean; backingPath?: string }): void;
  detachDisk?(): void;
  getAttachedMedia?(): { kind: string; bytes: Uint8Array; readOnly: boolean } | null;
  persistDirtyTracks?(): void;
}

/** Where the mounted-disk path identity lives (IntegratedSession / drive-session record). */
export interface DiskMountTarget {
  drive: DiskMountDrive | undefined;
  getDiskPath(): string;
  setDiskPath(path: string): void;
}

export type DiskMediaSource =
  | "project-path" | "uploaded-bytes" | "scenario" | "runtime-tool" | "snapshot";

export interface DiskPersistResult { written: boolean; path?: string; bytes?: number; reason?: string }

/**
 * Flush dirty GCR → media.bytes and write the in-RAM image back to its backing
 * file. With write-through (Spec 742), the host file is already current at the
 * track-commit; this is the FINAL not-yet-committed-track safety flush (called
 * on unmount/swap/explicit-persist). Read-only media is never overwritten.
 */
export function persistDriveToFile(drive: DiskMountDrive | undefined, backingPath: string): DiskPersistResult {
  if (!drive?.getAttachedMedia) return { written: false, reason: "no drive / media accessor" };
  drive.persistDirtyTracks?.();
  const attached = drive.getAttachedMedia();
  if (!attached) return { written: false, reason: "no media attached" };
  if (attached.readOnly) return { written: false, path: backingPath, reason: "media is read-only — not writing back" };
  if (!backingPath) return { written: false, reason: "no backing file path" };
  writeFileSync(backingPath, attached.bytes);
  return { written: true, path: backingPath, bytes: attached.bytes.length };
}

/**
 * THE single disk-media attach entry. All paths (UI/ingress/mount tool/session
 * start/scenario/drive-session) call this so backing-file identity + write-back
 * behaviour are uniform.
 */
export function mountDiskMedia(target: DiskMountTarget, opts: {
  kind: "d64" | "g64" | "p64";
  name: string;
  bytes: Uint8Array;
  backingPath?: string;
  readOnly?: boolean;
  source: DiskMediaSource;
}): { persistedOutgoing?: DiskPersistResult } {
  const drive = target.drive;
  if (!drive?.attachDisk) throw new Error("mountDiskMedia: no VICE1541 drive to attach disk");

  // A disk change is an implicit eject of the currently mounted disk: persist
  // its writes to the host file + detach BEFORE attaching the new one, else the
  // outgoing disk's writes are lost. No-op on the first mount.
  let persistedOutgoing: DiskPersistResult | undefined;
  const curPath = target.getDiskPath();
  if (curPath && drive.getAttachedMedia?.()) {
    persistedOutgoing = persistDriveToFile(drive, curPath);
    drive.detachDisk?.();
  }

  drive.attachDisk({
    kind: opts.kind,
    bytes: opts.bytes,
    readOnly: opts.readOnly ?? false,
    backingPath: opts.backingPath, // write-through target when local/project-backed
  });

  // Preserve path identity: the real backing path when available, else the
  // display name (uploaded bytes with no host file → no write-through).
  target.setDiskPath(opts.backingPath ?? opts.name);
  return { persistedOutgoing };
}
