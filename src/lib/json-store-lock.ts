// A JSON store that two processes may write at the same time.
//
// `knowledge/artifacts.json` has two writers and always had: the MCP server
// registers a tool's outputs, and the analysis pipeline — a separate CommonJS
// child process — registers whatever a CLI subcommand just wrote. Under 3- to
// 6-way parallelism that cost six registrations in about 590 calls:
//
//   ENOENT: no such file or directory,
//   rename '…/knowledge/artifacts.json.tmp' -> '…/knowledge/artifacts.json'
//
// Both writers staged through the SAME fixed name. Two of them overlapping is
// enough: A writes the staging file, B writes it too, A renames it into place,
// B renames a file that is no longer there. Never seen serially, which is why
// it took a parallel run to find it.
//
// The unique staging name below is only the floor. The real defect is that a
// registration is a read-modify-write: both writers load the store, add their
// row and write the whole file back. Fixing the collision alone would have
// turned a loud crash into a lost row — the last writer wins and the other
// registration is gone with no error anywhere. So the read, the change and the
// write go inside one cross-process lock.
//
// THIS FILE EXISTS TWICE — `src/lib/json-store-lock.ts` (ESM) and
// `pipeline/src/lib/json-store-lock.ts` (CommonJS) — because the two trees
// cannot import each other (817 §1) and a lock only works if every writer runs
// the SAME protocol. The two copies are byte-identical and a gate keeps them
// that way; it imports nothing but node builtins so that stays possible.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** After this long a lock is assumed to belong to a process that died holding it. */
export const STORE_LOCK_STALE_MS = 20_000;

/** How long a writer waits for its turn before giving up — loudly, never silently. */
export const STORE_LOCK_TIMEOUT_MS = 30_000;

let stagingCounter = 0;

/** Locks this process is already inside, so a nested acquire does not deadlock on itself. */
const heldHere = new Set<string>();

/**
 * Pause the thread without unwinding. The whole read-modify-write is
 * synchronous on both sides — `saveArtifact` returns a record, the pipeline's
 * `registerCliArtifact` returns void — so there is no promise to await here.
 */
function nap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A staging name no other writer can pick: pid, a per-process counter, and entropy. */
export function stagingPathFor(path: string): string {
  stagingCounter += 1;
  const salt = Math.random().toString(36).slice(2, 8);
  return `${path}.${process.pid}.${stagingCounter}.${salt}.tmp`;
}

/**
 * Write `contents` to `path` through a staging file of its own, then rename it
 * into place. The rename is atomic, so a reader sees either the old file or the
 * new one and never a half-written store.
 */
export function writeJsonStoreAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = stagingPathFor(path);
  try {
    writeFileSync(staging, contents, "utf8");
    renameSync(staging, path);
  } catch (error) {
    // Leave nothing behind for the next `ls` to puzzle over. The rename may
    // already have consumed it, so a failure to unlink is not news.
    try { if (existsSync(staging)) unlinkSync(staging); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * Run `body` with an exclusive, cross-process lock on `path`.
 *
 * `open(…, "wx")` is the primitive: it creates the lock file or fails with
 * EEXIST, atomically, on every platform we target. A lock older than
 * STORE_LOCK_STALE_MS is broken — a crashed writer must not wedge a project
 * forever — and a wait longer than STORE_LOCK_TIMEOUT_MS throws, because a
 * registration that cannot be made has to be said out loud.
 */
export function withJsonStoreLock<T>(path: string, body: () => T): T {
  const target = resolve(path);
  if (heldHere.has(target)) return body();

  mkdirSync(dirname(target), { recursive: true });
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  let handle: number | undefined;
  let attempts = 0;

  for (;;) {
    try {
      handle = openSync(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let heldForMs: number | undefined;
      try { heldForMs = Date.now() - statSync(lockPath).mtimeMs; } catch { heldForMs = undefined; }
      if (heldForMs === undefined) continue; // the holder finished between the open and the stat
      if (heldForMs > STORE_LOCK_STALE_MS) {
        try { unlinkSync(lockPath); } catch { /* another waiter broke it first */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${target} stayed locked for ${STORE_LOCK_TIMEOUT_MS} ms by another writer `
          + `(${lockPath}, held ${Math.round(heldForMs)} ms). Nothing was written. `
          + `If no other c64re process is running, delete the lock file and retry.`,
        );
      }
      attempts += 1;
      nap(Math.min(25, attempts));
    }
  }

  heldHere.add(target);
  try {
    try { writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`); } catch { /* the lock is the file, not its contents */ }
    return body();
  } finally {
    heldHere.delete(target);
    try { closeSync(handle); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* broken as stale by someone else */ }
  }
}
