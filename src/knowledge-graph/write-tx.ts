// Every write to graph.sqlite takes the write lock FIRST, and only when it has something
// to write.
//
// Measured on the Windows runner, 2026-09-27, with the store-concurrency race (N writers
// creating and filling one graph at once): a writer died on the graph with errcode 5,
// `database is locked`. Timed, the failure came ~5.5 s after the step began — the busy
// timeout (5 s) running out, not an immediate refusal. So it is STARVATION: SQLite's busy
// handler sleeps between attempts, and under enough writers a waiting connection keeps
// missing the window in which the lock is free until its timeout is spent. Never seen on
// macOS in 100 trials; Windows' file locking is slower, and that is enough.
//
// Two things follow, and this module holds both:
//
//  1. Do not queue for the lock when there is nothing to write. Every open used to run
//     the schema DDL and every door rewrote two meta rows — writes, on every call, that
//     changed nothing. `ddlObjectsPresent` lets a caller see that the schema is already
//     there and skip the transaction entirely. Taking the lock for the schema on EVERY
//     open was tried first and made the starvation worse (10/60 trials at 16 writers).
//  2. When the lock really is needed, take it at BEGIN (IMMEDIATE — before anything is
//     read, so an upgrade can never be refused mid-transaction) and, if BEGIN itself
//     comes back busy, try again after a random pause, up to a deadline. Retrying BEGIN
//     is safe because nothing has happened yet; the random pause is what breaks the
//     lock-step in which the same connection keeps losing.
//
// Re-entrant per connection, so a door that opens the transaction can call a store method
// that also asks for one. Tracked here rather than read from `db.isTransaction`, which
// node:sqlite only has from 22.16 while the package runs on 22.0 and up.

import type { DatabaseSync } from "node:sqlite";

const OPEN = new WeakSet<DatabaseSync>();

export function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  const owned = beginWrite(db);
  try {
    const out = fn();
    endWrite(db, owned, true);
    return out;
  } catch (error) {
    try { endWrite(db, owned, false); } catch { /* the transaction is already gone */ }
    throw error;
  }
}

/**
 * The same, split in two, for a site that decides at the end whether to commit — a
 * migration dry run rolls back what it wrote. Returns whether THIS call opened the
 * transaction; inside an outer one it joins, and `endWrite` then leaves it alone.
 */
export function beginWrite(db: DatabaseSync): boolean {
  if (OPEN.has(db)) return false;
  const deadline = Date.now() + BEGIN_DEADLINE_MS;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      pause(10 + Math.floor(Math.random() * 90));
    }
  }
  OPEN.add(db);
  return true;
}

/** How long a writer keeps asking for the lock, each ask itself waiting out the busy
 *  timeout — so a writer gives up only after the store has been busy for this long. */
const BEGIN_DEADLINE_MS = 30_000;

function isBusy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string };
  return (typeof e?.errcode === "number" && (e.errcode & 0xff) === 5) || /database is locked/iu.test(String(e?.message ?? ""));
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True when every table, index, view and trigger `ddl` creates already exists — i.e. running
 * it would change nothing. Names are read from the DDL itself, so a statement added to it
 * later is covered without anyone remembering this function exists; every statement in
 * the graph's DDL is `CREATE … IF NOT EXISTS <name>`, and that is the only shape read.
 */
export function ddlObjectsPresent(db: DatabaseSync, ddl: string): boolean {
  const names = [...ddl.matchAll(/CREATE\s+(?:UNIQUE\s+|VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/giu)].map((m) => m[1]);
  if (names.length === 0) return false;
  const have = new Set(
    (db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name),
  );
  return names.every((n) => have.has(n));
}

export function endWrite(db: DatabaseSync, owned: boolean, commit: boolean): void {
  if (!owned) return;
  try {
    db.exec(commit ? "COMMIT" : "ROLLBACK");
  } finally {
    OPEN.delete(db);
  }
}
