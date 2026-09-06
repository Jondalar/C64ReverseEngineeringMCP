// Spec 827 — where a trace capture lives.
//
// Measured on Wasteland_EF, 2026-09-06: 10.7 GB of `.duckdb` index and 9.2 GB of
// `.c64retrace` log inside one project directory. A project directory is what a
// user syncs and backs up, and a DuckDB file is the worst object a sync client
// can be handed — large, binary, rewritten continuously while a trace runs, no
// delta sync, and a client that reads it mid-write can corrupt the capture.
//
// So a capture defaults OUTSIDE the project, into a per-user DATA directory —
// deliberately not a cache directory: the `.c64retrace` beside the index is
// evidence under Spec 726.B, and the system is entitled to empty a cache. The
// point is to leave the synced tree, not to make the capture disposable.
//
// The project keeps a pointer (`runtime/traces.json`), which is the small file
// that SHOULD sync.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Directory names these clients create. Conservative on purpose: a false
 *  positive nags about a directory that is not synced at all (D5). */
const SYNC_MARKERS: Array<{ segment: RegExp; client: string }> = [
  { segment: /^OneDrive([ -].*)?$/iu, client: "OneDrive" },
  { segment: /^Dropbox([ -].*)?$/iu, client: "Dropbox" },
  { segment: /^Mobile Documents$/iu, client: "iCloud Drive" },
  { segment: /^com~apple~CloudDocs$/iu, client: "iCloud Drive" },
  { segment: /^Google ?Drive$/iu, client: "Google Drive" },
  { segment: /^My Drive$/iu, client: "Google Drive" },
  { segment: /^pCloud ?Drive$/iu, client: "pCloud" },
  { segment: /^Nextcloud$/iu, client: "Nextcloud" },
];

/**
 * The per-user root for trace captures. `C64RE_TRACE_DIR` wins over everything,
 * so a machine with a big scratch disk can point at it in one variable.
 */
export function traceRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.C64RE_TRACE_DIR?.trim();
  if (override) return resolve(override);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    return join(local, "c64re", "traces");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "c64re", "traces");
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg || join(home, ".local", "share"), "c64re", "traces");
}

/**
 * A directory name a human recognises, that two projects cannot share: the
 * folder's own name plus eight hex of the absolute path (D2).
 */
export function projectKey(projectDir: string): string {
  const abs = resolve(projectDir);
  const name = basename(abs).replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 40) || "project";
  return `${name}-${createHash("sha1").update(abs).digest("hex").slice(0, 8)}`;
}

/** `<root>/<project key>` — created on demand by the caller that writes there. */
export function traceDirForProject(projectDir: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(traceRoot(env, platform), projectKey(projectDir));
}

/**
 * The path `runtime_trace_start` uses when the caller named none. Absolute, so
 * the daemon (which has its own idea of the project) writes exactly here.
 */
export function defaultTraceOut(projectDir: string, label = `live_${Date.now().toString(36)}`, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(traceDirForProject(projectDir, env, platform), `${label}.duckdb`);
}

/**
 * The sync client whose folder this path sits in, or undefined.
 *
 * Splits on BOTH separators and does not resolve: a Windows path can reach a
 * macOS host (it arrives from a config, a daemon, or a test) and `path.sep`
 * would then split on the wrong character and see one long segment.
 */
export function syncClientFor(path: string): string | undefined {
  for (const segment of path.split(/[\\/]+/u)) {
    for (const marker of SYNC_MARKERS) if (marker.segment.test(segment)) return marker.client;
  }
  return undefined;
}

/** One line for the tool result when a capture is about to land in a synced folder. */
export function syncWarning(path: string): string | undefined {
  const client = syncClientFor(path);
  if (!client) return undefined;
  return (
    `WARNING: this trace lands inside ${client} (${path}). A capture is a large binary file that is rewritten ` +
    `continuously — it will re-upload in full on every flush, and a sync client reading it mid-write can corrupt it. ` +
    `Omit \`output\` to use the per-user trace directory instead, or set C64RE_TRACE_DIR.`
  );
}

export interface TracePointer {
  runId?: string;
  duckdbPath: string;
  retracePath?: string;
  startedAt: string;
  domains?: string[];
}

/** `<project>/runtime/traces.json` — the small file that SHOULD live in the project (D3). */
export function tracePointerPath(projectDir: string): string {
  return join(resolve(projectDir), "runtime", "traces.json");
}

/**
 * Append a pointer. Soft-fail by contract: a trace must never fail because the
 * project directory is read-only or full. Returns the path when it was written.
 */
export function recordTracePointer(projectDir: string, entry: TracePointer): string | undefined {
  const path = tracePointerPath(projectDir);
  try {
    mkdirSync(join(resolve(projectDir), "runtime"), { recursive: true });
    let entries: TracePointer[] = [];
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { traces?: TracePointer[] };
        if (Array.isArray(parsed.traces)) entries = parsed.traces;
      } catch {
        // a corrupt pointer file is not worth failing a capture over: keep the
        // broken one beside the new one rather than silently dropping it
        try { appendFileSync(`${path}.corrupt`, readFileSync(path)); } catch { /* best effort */ }
      }
    }
    entries.push(entry);
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, note: "Spec 827 — captures live outside the project; this file says where.", traces: entries }, null, 2)}\n`);
    return path;
  } catch {
    return undefined;
  }
}
