// Spec 831 — where a machine-state dump lives.
//
// The `⬇ Dump` button called the daemon with a RELATIVE path
// (`dumps/dump-<ts>.c64re`). The workbench talks to the daemon directly, the
// daemon resolves a relative path against ITS working directory — the tools
// repo — and so four `.c64re` files ended up in a gitignored directory
// belonging to neither project that produced them. The fix is not to guess a
// better relative path; it is to stop sending one.
//
// Why this is the opposite case to Spec 827. 827 moved trace captures OUT of
// the project because a DuckDB index is large, binary, and rewritten
// CONTINUOUSLY while the trace runs — the one object a sync client can corrupt
// mid-write. A `.c64re` dump is written once, complete, and never touched
// again. It is project evidence and it belongs with the project, beside the
// `runtime/traces.json` pointer 827 already writes there.
//
// Pure path policy plus one mkdir, so the platform this targets does not have
// to be the platform it runs on.

import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** `<project>/runtime/dumps` — the directory, not created. */
export function dumpDirForProject(projectDir: string): string {
  return join(resolve(projectDir), "runtime", "dumps");
}

/**
 * A label is user-facing text, and a dump path is a filesystem write, so the
 * label is reduced to the characters a name may contain. A slash, a `..` or a
 * space cannot survive this, which is the point: no label escapes the
 * directory the policy chose.
 */
export function sanitizeDumpLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[-.]+/u, "").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "dump";
}

export interface DumpTarget {
  /** absolute — what the daemon is given, because its cwd is not the project's */
  path: string;
  /** what the UI shows: `runtime/dumps/<name>` */
  relativePath: string;
  dir: string;
  name: string;
}

/**
 * The target for one dump. `now` and `nonce` are parameters rather than reads
 * of the clock so the gate can pin them — and so two dumps inside the same
 * millisecond cannot land on the same name, which a bare timestamp allows.
 */
export function dumpTargetFor(
  projectDir: string,
  label = "dump",
  now: number = Date.now(),
  nonce: string = Math.random().toString(36).slice(2, 6),
): DumpTarget {
  const dir = dumpDirForProject(projectDir);
  const name = `${sanitizeDumpLabel(label)}-${now}-${nonce}.c64re`;
  const path = join(dir, name);
  return { path, relativePath: relative(resolve(projectDir), path).split("\\").join("/"), dir, name };
}

/** Create `<project>/runtime/dumps`. Idempotent; returns the directory. */
export function ensureDumpDir(projectDir: string): string {
  const dir = dumpDirForProject(projectDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
