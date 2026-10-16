// An anchor is a name on a ring checkpoint AND a file in the project. The ring dies with the daemon and
// rolls on; the file does not. A scenario that says `Given the mark "x"` starts from the file, on a machine
// of its own, any time later.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "../lib/id-path.js";

export function anchorsDir(projectDir: string): string {
  return join(projectDir, "knowledge", "anchors");
}

/** `<project>/knowledge/anchors/<name>.c64re` — the media are embedded, as in every .c64re. */
export function anchorFile(projectDir: string, name: string): string {
  return join(anchorsDir(projectDir), `${safeSegment(name)}.c64re`);
}

/** The path the graph keeps: relative to the project, forward slashes. */
export function anchorFileRel(name: string): string {
  return `knowledge/anchors/${safeSegment(name)}.c64re`;
}

export function anchorFileExists(projectDir: string, name: string): boolean {
  return existsSync(anchorFile(projectDir, name));
}

export function ensureAnchorsDir(projectDir: string): void {
  mkdirSync(anchorsDir(projectDir), { recursive: true });
}

/** Remove the file and the media folder an undump may have left beside it. True when a file was there. */
export function removeAnchorFile(projectDir: string, name: string): boolean {
  const f = anchorFile(projectDir, name);
  const had = existsSync(f);
  rmSync(f, { force: true });
  rmSync(f.replace(/\.c64re$/, "_media"), { recursive: true, force: true });
  return had;
}
