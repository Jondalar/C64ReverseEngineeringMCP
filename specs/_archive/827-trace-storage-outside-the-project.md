# Spec 827 — Trace storage lives outside the project directory

**Status:** BUILT 2026-09-06 — gate `npm run e2e:827` 43/0, hermetic (no daemon, no capture); `gates.yml` green
**Origin:** Issue #9 (mrr19121970): `runtime_trace_start` writes its DuckDB under the
project dir; the project lives in OneDrive; a play session blows past the sync quota.
Measured on the maintainer's own project the same day, which makes it a general problem
rather than one user's setup.
**Anchor:** Spec 726.B (the `.c64retrace` binary log is the authority, DuckDB is its
index) · Spec 746.x (background indexer) · Spec 806 (the runtime is a separate daemon
process) · `DOCTRINE.md` rule 4 (traces go into the trace store)
**Touches:** `src/trace/trace-location.ts` (new) · `src/server-tools/headless.ts`
(`runtime_trace_start`, `runtime_session_start`) · `src/server-tools/runtime-trace-sink.ts`
(`resolveTraceOut` keeps its contract) · `scripts/e2e-827-trace-location.mjs` (new) ·
`docs/tools/headless.md`

## 1. What exists today, measured

`resolveTraceOut(traceOut, projectDir)` is four lines: an absolute path passes through, a
relative one resolves **under the project directory**. When `runtime_trace_start` is
called without `output`, C64RE passes nothing and the runtime daemon picks its own
default, which is likewise project-relative (`traces/live_<ts>.duckdb`). Either way the
capture lands inside the project tree.

What that costs, in `Wasteland_EF/runtime/` on 2026-09-06:

| | files | size |
|---|---|---|
| `.duckdb` (the index) | 44 | **10.7 GB** |
| `.c64retrace` (the authority) | 51 | **9.2 GB** |
| everything else (screenshots, notes) | 24 | < 0.1 GB |

Twenty gigabytes in one project, of which **more than half is a rebuildable index**. The
project directory is also what a user backs up, syncs, and — in Mike's case — hands to
OneDrive. A DuckDB file is the worst possible object for a file-sync client: it is large,
it is binary, it is rewritten continuously while a trace runs, and there is no delta
sync, so every flush re-uploads the whole file. A sync client that locks or reads it
mid-write can also corrupt the capture.

## 2. The gap

Spec 726.B already decided what these two files ARE: the `.c64retrace` is the timeline
authority, the `.duckdb` is an index over it that the background indexer can rebuild.
Nothing acted on that distinction in terms of *where they live*. An index that can be
regenerated has no business in a directory the user syncs; and the authority is evidence,
so it must not go somewhere a cleaner will delete either.

## 3. Decisions

**D1 — Traces default to a per-user data directory, never the project.** With no explicit
`output`, C64RE resolves the path itself instead of leaving it to the daemon:

| platform | root |
|---|---|
| Windows | `%LOCALAPPDATA%\c64re\traces` |
| macOS | `~/Library/Application Support/c64re/traces` |
| Linux | `$XDG_DATA_HOME/c64re/traces`, else `~/.local/share/c64re/traces` |

`C64RE_TRACE_DIR` overrides all of it. **A data directory, not a cache directory,** and
that is deliberate: the `.c64retrace` next to the index is evidence under Spec 726.B, and
`~/Library/Caches` or `%TEMP%` are places the system is entitled to empty. The goal is to
leave the *synced* tree, not to make the capture disposable.

**D2 — Keyed by project, readably.** `<root>/<basename>-<first 8 of sha1(abs path)>/`.
The basename makes the directory recognisable when a human opens it; the hash makes two
projects with the same folder name impossible to confuse, and survives a rename of the
parent path.

**D3 — The project keeps a pointer, not the payload.** Each start appends to
`<project>/runtime/traces.json`: `{ runId, duckdbPath, retracePath, startedAt, domains }`.
That is the file the project syncs, and it is the answer to "where did that capture go".
Writing it is soft-fail: a trace never fails because the pointer could not be written.

**D4 — An explicit `output` is still obeyed, exactly as before.** `resolveTraceOut` keeps
its contract: absolute passes through, relative resolves under the project. Somebody who
asks for a capture in the project gets it there. But when the resolved path lies inside a
**sync-managed** directory, the tool says so in its result — one line, naming the client
it recognised. A warning, not a refusal: it is the user's disk.

**D5 — Sync detection is by path, and conservative.** A path segment matching OneDrive,
Dropbox, `Library/Mobile Documents` (iCloud), Google Drive, or pCloud counts. False
negatives are fine; a false positive would nag about a directory that is not synced, so
the list stays to names these clients actually create.

**D6 — Both files move together, and that is not a regression.** The daemon derives the
`.c64retrace` path from the `.duckdb` path by swapping the suffix
(`background-indexer.ts`), so splitting them needs a change on the TRX64 side. Under D1
the authority also leaves the project — into a durable per-user directory, recorded by
the D3 pointer. Splitting them (index in the data dir, authority in the project) is named
here as the follow-up if anyone wants the evidence physically beside the project.

## 4. Gate

`scripts/e2e-827-trace-location.mjs` (`npm run e2e:827`), pure and hermetic — no daemon,
no capture:

- the root follows the platform, and `C64RE_TRACE_DIR` beats all three;
- the project key contains the basename and is stable across calls, and two projects
  whose basename is identical get different directories;
- a default output is absolute, ends in `.duckdb`, and lies outside the project;
- `resolveTraceOut` is unchanged: absolute through, relative under the project;
- sync detection fires for OneDrive / Dropbox / iCloud / Google Drive paths and not for
  an ordinary one;
- the pointer file is created, appended to on a second run, valid JSON, and a read-only
  project directory does not make the call fail.

## 5. Acceptance

- `runtime_trace_start` without `output` writes outside the project, and says where.
- `<project>/runtime/traces.json` names every capture of that project.
- A project inside OneDrive gets a warning line when a trace is nevertheless directed
  into it.
- `e2e:827` green; the gates in `gates.yml` stay green.

## 6. Non-goals

- Moving or deleting the 20 GB that already exists. This spec changes where the NEXT
  capture goes; a migration or a pruning tool is separate work.
- Splitting index and authority across two directories (D6).
- Any change to the daemon. C64RE decides the path and passes it; TRX64 writes where it
  is told.

## 7. Built — what the gate found

The one defect the gate caught was in the sync detector: it split the path on the
HOST's separator, so a Windows path examined on macOS was one long segment and
`C:\Users\mike\OneDrive\…` was not recognised. A path reaches this function from a
config, from the daemon, or from a test — it is not always the host's. It now splits on
both separators and does not resolve (resolving a Windows path on POSIX mangles it).

Everything else landed as designed. Note for whoever reads this next: the 20 GB already
on disk is untouched — this decides where the NEXT capture goes (§6). And the authority
moves with the index, because the daemon derives the `.c64retrace` path from the
`.duckdb` path by swapping the suffix; splitting them is a TRX64-side change (D6).
