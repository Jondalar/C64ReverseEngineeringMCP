// Spec 265 — server-side filesystem browser for media selection.
//
// Roots:
//   - samples/ (vendored disks, relative to package root)
//   - $C64RE_PROJECT_DIR (current project)
//   - ~/Downloads
//   - user-added paths (~/.config/c64re/media-roots.json)
//
// Filter: .d64 .g64 .crt .prg .vsf + .t64/.tap (grayed = deferred)

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";

// File extensions that are supported + deferred.
const MEDIA_EXTS_ACTIVE = new Set([".d64", ".g64", ".crt", ".prg", ".vsf"]);
const MEDIA_EXTS_DEFERRED = new Set([".t64", ".tap"]);
const MEDIA_EXTS_ALL = new Set([...MEDIA_EXTS_ACTIVE, ...MEDIA_EXTS_DEFERRED]);

export type MediaType = "d64" | "g64" | "crt" | "prg" | "vsf" | "t64" | "tap";

export interface FsRoot {
  label: string;
  path: string;
  exists: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | MediaType;
  /** For .t64 / .tap entries: true = grayed out, not mountable in V3 */
  deferred: boolean;
  sizeBytes?: number;
}

export interface FsBrowseResult {
  path: string;
  entries: FsEntry[];
}

// Absolute path to the package root (two levels up from src/runtime/headless/media).
const PACKAGE_ROOT = resolve(new URL("../../../../", import.meta.url).pathname);

/** Resolve the user-added roots list from ~/.config/c64re/media-roots.json */
function loadUserRoots(): string[] {
  const cfg = join(homedir(), ".config", "c64re", "media-roots.json");
  if (!existsSync(cfg)) return [];
  try {
    const data = JSON.parse(readFileSync(cfg, "utf8"));
    if (Array.isArray(data)) return data.filter((x): x is string => typeof x === "string");
  } catch { /* ignore parse errors */ }
  return [];
}

/** Return all configured fs roots. */
export function listFsRoots(): FsRoot[] {
  const roots: FsRoot[] = [];

  // 1. samples/ (vendored disks bundled with the package).
  const samplesPath = join(PACKAGE_ROOT, "samples");
  roots.push({ label: "samples", path: samplesPath, exists: existsSync(samplesPath) });

  // 2. $C64RE_PROJECT_DIR
  const projectDir = process.env["C64RE_PROJECT_DIR"];
  if (projectDir) {
    roots.push({ label: "project", path: resolve(projectDir), exists: existsSync(projectDir) });
  }

  // 3. ~/Downloads
  const downloadsPath = join(homedir(), "Downloads");
  roots.push({ label: "Downloads", path: downloadsPath, exists: existsSync(downloadsPath) });

  // 4. User-added paths
  for (const p of loadUserRoots()) {
    const abs = resolve(p);
    roots.push({ label: basename(abs) || abs, path: abs, exists: existsSync(abs) });
  }

  return roots;
}

/** Detect media type from extension. Returns undefined if not a media file. */
function mediaTypeFromExt(ext: string): MediaType | undefined {
  switch (ext) {
    case ".d64": return "d64";
    case ".g64": return "g64";
    case ".crt": return "crt";
    case ".prg": return "prg";
    case ".vsf": return "vsf";
    case ".t64": return "t64";
    case ".tap": return "tap";
    default: return undefined;
  }
}

/**
 * Browse a directory and return filtered entries.
 * Subdirectories are always included. Files are filtered to known media types.
 */
export function browseDir(dirPath: string): FsBrowseResult {
  const abs = resolve(dirPath);
  if (!existsSync(abs)) {
    return { path: abs, entries: [] };
  }

  let names: string[];
  try {
    names = readdirSync(abs).sort((a, b) => a.localeCompare(b));
  } catch {
    return { path: abs, entries: [] };
  }

  const entries: FsEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // skip dotfiles
    const fullPath = join(abs, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      entries.push({ name, path: fullPath, type: "dir", deferred: false });
      continue;
    }

    if (stat.isFile()) {
      const ext = extname(name).toLowerCase();
      if (!MEDIA_EXTS_ALL.has(ext)) continue;
      const mediaType = mediaTypeFromExt(ext);
      if (!mediaType) continue;
      entries.push({
        name,
        path: fullPath,
        type: mediaType,
        deferred: MEDIA_EXTS_DEFERRED.has(ext),
        sizeBytes: stat.size,
      });
    }
  }

  return { path: abs, entries };
}
