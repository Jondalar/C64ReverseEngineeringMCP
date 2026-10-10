import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The path with symlinks resolved, even when the file itself does not exist (yet):
 * the nearest existing ancestor is canonicalised and the missing tail appended. A
 * project reached through a symlinked directory (`/tmp` on macOS) and a path spelled
 * through its real location then compare as the same place.
 */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs;
    tail.unshift(dir.slice(parent.length).replace(/^[\\/]+/, ""));
    dir = parent;
  }
  try { return join(realpathSync(dir), ...tail); } catch { return abs; }
}

/**
 * Is `abs` strictly inside `root`? Compared on resolved real paths, so `..` segments,
 * symlinked directories and (on Windows, where `relative` is case-insensitive and a
 * different drive yields an absolute result) drive letters cannot fool it.
 */
export function insideProject(root: string, abs: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(abs));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
