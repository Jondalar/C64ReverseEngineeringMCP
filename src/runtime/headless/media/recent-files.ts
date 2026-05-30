// Spec 265 — recent media files persistence.
//
// Stored at ~/.config/c64re/recent-media.json (max 10 entries).
// Entries are ordered newest-first.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { MediaType } from "./fs-browser.js";

const MAX_RECENT = 10;

export interface RecentEntry {
  path: string;
  type: MediaType;
  /** ISO 8601 timestamp of last mount */
  mountedAt: string;
}

function recentFilePath(): string {
  // C64RE_RECENT_FILE overrides the store location (tests / isolated runs) so
  // the user's real recents store is never touched. Default: per-user config.
  const override = process.env.C64RE_RECENT_FILE;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".config", "c64re", "recent-media.json");
}

/** Load the current recent-files list (newest-first). */
export function getRecent(): RecentEntry[] {
  const p = recentFilePath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter(
      (e): e is RecentEntry =>
        typeof e === "object" &&
        typeof e.path === "string" &&
        typeof e.type === "string" &&
        typeof e.mountedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Add a file to the recent list, deduplicating by path, trimming to max. */
export function addRecent(path: string, type: MediaType): void {
  const existing = getRecent().filter((e) => e.path !== path);
  const updated: RecentEntry[] = [
    { path, type, mountedAt: new Date().toISOString() },
    ...existing,
  ].slice(0, MAX_RECENT);

  const p = recentFilePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(updated, null, 2), "utf8");
  } catch { /* ignore write errors in smoke/test contexts */ }
}
