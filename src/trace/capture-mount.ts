// Spec 909 D4 — what was MOUNTED when a capture was taken.
//
// The runtime puts the identity of the disk in drive 8 into a capture's header (`mediaSha`) and nothing about a
// cartridge: it reports the cartridge by file name and type, never by hash. So a trace of a cartridge cannot say which
// image ran — and with two cartridges in one project that is the whole question.
//
// The hash is known where the image was put into the machine: a sandbox is started with an image path, and C64RE
// holds it. When a trace is finalized, that identity is written next to the capture, in a sidecar that shares its stem:
//   <name>.c64retrace   <name>.mount.json
// The importer reads it (graph import-trace). The capture itself is never touched; a capture without a sidecar
// (taken by an older build, or on a session whose image C64RE did not mount) falls back to the name the runtime reported.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface CaptureMount {
  v: 1;
  /** the session the capture was taken on */
  session?: string;
  at: string;
  cartridge?: {
    /** the runtime's own report: the mounted file's name and the mapper */
    sourceName?: string;
    type?: string;
    /** the bank selected when the trace was finalized */
    bank?: number;
    /** sha256 of the image C64RE put in the machine — present only when C64RE did */
    sha256?: string;
    path?: string;
  };
}

export const mountSidecarPath = (capturePath: string): string => capturePath.replace(/\.c64retrace$/u, "") + ".mount.json";

export function writeCaptureMount(capturePath: string, mount: CaptureMount): string {
  const path = mountSidecarPath(capturePath);
  writeFileSync(path, JSON.stringify(mount, null, 2) + "\n");
  return path;
}

export function readCaptureMount(capturePath: string): CaptureMount | undefined {
  const path = mountSidecarPath(capturePath);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CaptureMount;
    return raw && raw.v === 1 ? raw : undefined;
  } catch { return undefined; }
}
