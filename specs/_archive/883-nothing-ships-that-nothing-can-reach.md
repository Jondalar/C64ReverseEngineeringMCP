# Spec 883 — Nothing ships that nothing can reach

**Status:** BUILT 2026-09-26.
**Repo:** C64RE only. TRX64: no change.
**Number:** 883 (registry: `specs/README.md`).
**Origin:** Socket's supply-chain scan of `@trex64/c64re` 0.1.2 reported SQL in
`dist/analysis/regression.js`. Nothing could run it. The owner: *"Das nervt schon ganz
schön hart immer mal wieder."*

---

## §1 What is wrong

`regression.js` was the visible end of a shape, not a one-off. Two MCP tools, absent from
`DEFAULT_TOOLS`, whose handlers never imported the module and returned a fixed sentence
pointing at `scripts/regress-cli.mjs` — a script not in the package — in front of a module
whose entry point always throws. It shipped anyway, because `files` allowlists `dist/`
wholesale and nothing asks whether a shipped module is reached.

An audit found the rest. What it established, each claim traced in the code and the
four with the widest reach re-checked by hand:

- **The TypeScript trace stack outlived its job.** `analysis/{query-events,taint,
  follow-path,loader-profile,trace-events}` and all of `trace/store/`: the visible
  `runtime_query_events` / `_follow_path` / `_trace_taint` / `_profile_loader` call the
  daemon and import none of it. Its smokes were green — testing implementations no tool
  used.
- **The bookmark tools were a corpse the audit missed.** `runtime_bookmark_add` / `_list`
  read `trace_bookmarks`, a table only the retired TS store created; against a store the
  live system writes they fail with `Table with name trace_bookmarks does not exist`. Their
  one green test used the dead store as its fixture.
- **Visible tools named tools that do not exist** (`runtime_session_undump`,
  `snapshot_dump`) or that a session cannot see (ten redirects to hidden tools, including
  the steering text `project_init` seeds into a new project and the snippet `c64re setup`
  writes into a user's agent config).
- **Hints that assume a checkout** — `npm run …` and `scripts/…` — in text a package user
  reads.
- `try_depack` offered `backwards` for Exomizer raw and always threw on it. Spec 882.

## §2 The rule

**A module ships only if an entry a package user can start reaches it.** Entries: the
`bin`, the workbench (`workspace-ui/launch.js`, `workspace-ui/server.js`), the pipeline
child. What is legitimately unreachable at runtime — build-time, a test fixture, compiled
into the UI bundle from source — is excluded from the tarball by an exact `!dist/…` entry.

And the text rule, 878's applied to the surface: **a visible tool's text names only what a
session of that server can see and call.** Where the only door is advanced, the text says
so and says how (`C64RE_FULL_TOOLS=1`).

## §3 The gate

`check:dist-reachable` walks the BUILT `dist/`, where type-only imports are already
erased — so an `import type` cannot pass for a caller, which is exactly how the trace stack
looked alive. Edges: static and dynamic imports, `require`, and string literals naming a
dist file by path or by a basename unique in `dist/` (the pipeline loads
`listing-equates.js` from path parts). It fails on a shipped module no entry reaches, and
on a stale exclusion: one naming a missing file, or one naming a module that IS reached,
which would break the package. Proved red on both exclusion cases before it went in.

`npm run build` now clears `dist/` first: `tsc` never deletes an output, so a deleted
source's `.js` would otherwise go on shipping from any machine that is not a fresh clone.

## §4 What was done

- Deleted: the TS trace stack (§1), `bookmarks` + `duckdb-backend` + `withDuckDb` + the two
  bookmark tools, `regression` + its two stub tools + `regress-cli` + its smoke,
  `binary-log-worker`, `channels`, `input/ws-handlers` and `media-format/ingress-request`
  (both served the deleted `ws-server`), `project-knowledge/index` (a barrel nobody
  imported), `pipeline/lib/models`, the pipeline's `annotation-suggestions` /
  `runtime-tables` / `asm-sync`, `buildD64FromGCR` (writeback for the deleted TS 1541),
  and every smoke that only tested those.
- Reduced to their types: `analysis/flow-focus` (the classification runs incrementally in
  the graph producer), `trace/trace-definition` (the daemon validates and compiles),
  `inspect/asset-join-knowledge` (the daemon produces the shape; the workbench persists it).
- Excluded from the tarball by name: build-time `platform-kb/{seed,abi,extensions}` and
  `fingerprint-extractor`; the disk fixture builders; three modules the UI bundle compiles
  from source.
- Text: the two ghost names now name `runtime_monitor`'s `dump` / `undump`; the ten
  redirects name a visible door or the opt-in; `build_tools` refuses where there is no
  `tsconfig.json`; `c64ref_lookup`'s `auto_build` now also rebuilds a snapshot that carries
  the ROM listings and no memory map — its own coverage note told the caller to rebuild,
  and the only door that could was an advanced tool (proved: a ROM-only snapshot came back
  with `memory_map` and `symbols` after one call, then the original was restored); the checkout-only hints say which install they are for; `cli.ts` no
  longer promises an in-process runtime that Spec 806 deleted.

## §5 What was found and left, on purpose

- The workbench's Trace tab bookmark panel calls a daemon op `listBookmarks` that does not
  exist, catches the error to `[]`, and is therefore always empty. UI work, not done blind.
- `smoke:input` (Escape → `RUN_STOP` returns `LARROW`) and `smoke-ui-media-dropzone`
  (`.prg` → inject-run) were red before this and are not corpses; both are ungated.
- The phase gate acts only when `phaseGateStrict` is set, which nothing that ships sets.
  Reachable by hand-editing a profile, so it is not dead; whether it should exist is a
  separate question.
- Projects created before this keep the old steering sentence pointing at
  `auto_resolve_questions`: the seeding is idempotent and never clobbers hand-written
  content, which is right, so it does not rewrite theirs.
- `docs/tool-surface-inventory.md` lists 328 tools against today's 295; both pages that
  link it already call it a May-2026 snapshot. History, labelled as such.

## §6 The last four

`trace/{background-indexer,binary-log-indexer,binary-log-index-worker,trace-run-store}`
were reached only through `withDuckDb`, so they became unreachable when the bookmark tools
went — and `server-tools/trace-store.ts` already recorded that indexing moved to the daemon
with Spec 802. The harness's auto-mode classifier refused their deletion; the owner deleted
them by hand. The SQL fix made to `trace-run-store` earlier the same day went with the file.
With them gone, `check:dist-reachable` is green: 303 of 321 modules reached, 10 excluded by
name, every exclusion current.
