# Spec 806 — Retire the TS emulator and VICE from the product

**Status:** IN BUILD 2026-08-12 — phase 1 DONE, **§8 steps 1 (evacuation) and 2
(convert the tools) DONE** (branch `spec-806-structural-cut`). Inventory + tool
cross-check in §6/§7 below; §6 corrected against the measurement in §6.1, §7
against the conversion in §7.1/§7.2. Next: §8 step 3 (answer the eleven).
**Repo:** C64RE. **Supersedes** the binding half of Spec 723 when it lands.

---

## 1. The decision

**`ts-emulator` and `runtime/vice` disappear from the released C64RE.** How is
open — deletion, or a branch that keeps them referenced somewhere for VICE
testing. What is not open: they are gone from the product.

## 2. Why now

The runtime backend has been TRX64 since Spec 771. The TS emulator was kept as a
"fallback and parity oracle", and the cost of keeping it is no longer theoretical:

- **It misleads by existing.** Twice in two days a question about "the runtime"
  needed a detour to establish whether a file was the product or the oracle, and
  once it was answered from the wrong one. 189 files now carry a `DEPRECATED`
  banner for exactly this reason — a banner is a symptom, not a fix.
- **The oracle has nothing left to check.** The monitor port audit (2026-08-11)
  compared 87 TS verbs against 97 Rust ones and found the Rust side ahead; the
  drive is proven by `drive_sector_read` and seven booting titles; TRX64 carries
  its own gates (Spec 783). Parity was the reason to keep it, and parity is done.
- **VICE is already off the RE surface by doctrine** (retired 2026-07-15), yet
  `src/runtime/vice/` is still imported by `server-tools/vice.ts` and five
  scripts, including a 27 KB binary-monitor client.

## 3. Order (each step green on its own)

**Phase 1 — the structural cut (prerequisite).** Non-emulator code moves OUT of
`src/runtime/headless/`, so that what remains is entirely the thing being retired.
Today the split runs *through* the directories, not between them: `trace/` holds
both the TRX64 capture reader (Spec 784/785 work) and TS-emulator bus tracing;
`media/`, `inspect/`, `vsf/` and `export/` are likewise mixed. Target:

```
src/runtime/      the TRX64 capsule and nothing else
src/trace/        capture read + store, backend-neutral
src/media/        neutral format/path helpers
src/ts-emulator/  what is being retired — the name says it, the banner becomes redundant
```

**Phase 2 — cut the reachability.** The `!isDaemonMode()` branches
(`runtime_monitor` and friends), `workspace-ui/ws-server.ts`'s top-level import of
`monitor-shell`, and `C64RE_RUNTIME_TS`. A tool that cannot reach it is most of
the way to not having it.

**Phase 3 — remove.** `ts-emulator/` and `runtime/vice/` leave the product tree.
Whatever is kept for VICE testing is kept somewhere that is not shipped.

**Phase 4 — doctrine.** Spec 723 (single-path) governs the TS runtime: it retires
with its subject. `DOCTRINE.md` §"Still binding" loses its first section, and
`scripts/probe-single-path.mjs` goes with it. The one-machine-per-process rule
stays — that is about TRX64 and is unaffected.

## 4. Open

- **What VICE testing still needs.** `server-tools/vice.ts` + 5 scripts use
  `runtime/vice/`. Establish whether any of it is still exercised before deciding
  between a branch and deletion.
- **What else asserts TS-runtime invariants.** `probe-single-path.mjs` is known;
  the e2e scripts need a sweep.

## 5. Non-goals

- No change to TRX64. This is C64RE shedding a second implementation.
- No behaviour change in phase 1 — moves and imports only.

---

## 6. Inventory (measured 2026-08-12, not estimated)

**The split is computed, not guessed:** the transitive import closure from the
hardware roots (`cpu vic cia via sid iec vice1541 drive1541 peripherals alarm c64
kernel audio parallel` + `memory-bus cartridge c64-rom spi-flash m93c86
eapi-am29f040 integrated-session integrated-session-manager stepping
reset-profiles snapshot providers`).

| | files |
|---|---|
| **DELETE** — reachable from a hardware root | **166** |
| **KEEP** — analysis / orchestration, must leave `ts-emulator/` first | **40** |

The 40 keepers, by what they are:

- **monitor helpers** `debug/{disasm6502,assembler6502,backtrace,monitor-bitmap,monitor-flow-disasm,stepping,memory-access-map}` — they decode and render, they do not execute
- **v2 analysis** `{bookmarks,breakpoints,taint,follow-path,resolve-pc,flow-focus,query-events,regression,fingerprint,fingerprint-extractor,loader-profile,trace-events,duckdb-backend,vice-diff,vice-syntax}` — they read traces and records
- **recorder** `{anchor-codec,anchor-record,anchor-store,medium-source,recorder-ring,recorder-worker,runtime-recorder}`
- **input** `{input-config,keymap,vicerc-loader,ws-handlers}`
- **perf** `{budgets,safe-skips,snapshot-file}`, `disk/no-disk-parser`, `session-modes`, `util/uint`, `test-helpers/synthetic-iec-device`

**One fact that unblocked this:** `integrated-session-manager.ts` is 37 lines
holding a `Map` of in-process TS instances. It is NOT the TRX64 session manager —
that is `src/runtime/daemon-client.ts`, already in the capsule and untouched. The
name misled me for an entire evening.

## 6.1 Correction — the 40 was curated, not computed (2026-08-12)

Re-running the closure before moving anything did **not** reproduce 166/40, and
no variant of the walk does. Measured from the stated roots: **158 reachable /
48 unreachable**. Three variants were tried (all edges; value edges only; value
edges with all-inline-`type` imports dropped) — 158/48, 142/64, 142/64.

Where the two lists disagree, and why:

- **18 of the 40 keepers ARE reachable** from a hardware root, all through two
  hub edges: `kernel/snapshot-persistence.ts` has `import type { RuntimeController }`
  — a *type-only* edge that drags in all of `debug/` and `recorder/` — and
  `c64/perf-ops-tests.ts` value-imports all of `perf/`.
- **26 unreachable files are not in the 40** — `export/*`, `inspect/*`,
  `media/{mount,swap-and-continue}`, `vsf/drive-vsf`, `trace-query`, `trace-index`,
  `workspace`, `runtime-session-service`, `diagnostic-mm`, `daemon/run`,
  `regress/runner`, `smoke/load-matrix` and 8 `v2/` files. Checked individually:
  every one binds to `integrated-session*`, `types.ts`, `runtime-checkpoint` or
  `drive-session-manager`. They are emulator-bound orchestration and stay in the
  delete set — the *neutral* halves of those directories already left in phase 1,
  so the DOCTRINE note naming `inspect/`/`export/`/`media/`/`vsf/` as
  "deliberately NOT marked" is now stale and can go with the deletion.

**Reachability is not the criterion — being the emulator is.** The check that
actually decided it: all 40 are **import-closed**. Not one imports anything from
`ts-emulator/` outside the set; their only other imports are node builtins and
(for two files) `src/trace/` and `src/project-knowledge/`. The curated list is a
sound movable unit even though it is not the complement of any closure.

**33 moved, 7 left behind.** The seven the brief left open —
`perf/{budgets,safe-skips,snapshot-file}`, `disk/no-disk-parser`,
`session-modes`, `util/uint`, `test-helpers/synthetic-iec-device` — each name an
emulator construct in their own header (`IntegratedSession`, `G64Parser`, the
removed fast-trap mode of Spec 723.3, "shared uint helpers" for the 1:1 VICE chip
port, a mock for the TS KERNAL serial matrix). None has a single consumer outside
the delete set, and none of the 33 movers imports them. Moving them would create
seven orphans in a fresh directory with no caller, so they die with the emulator.

**The delete set is therefore 173, not 166** (206 − 33).

## 7. Tool cross-check against the TRX64 mapper

44 MCP tools reach into the delete set. Checked against the daemon's 112 methods:

**41 have a counterpart** — session/* · debug/* · trace/* · checkpoint/* · media/* ·
snapshot/* · batch/* · audio/* · vic/inspect · monitor/exec · recorder/* ·
runtime/{mark,overlay_run,promote_branch,render_screen,scenario*,snapshot_tree,
swap_disk_and_continue,component_diff}.

**3 need a decision before their tool can be converted:**

| tool | TS module | question |
|---|---|---|
| `runtime_diagnose_mm` | `diagnostic-mm` | a per-title diagnostic. Does it survive at all? |
| `runtime_iec_bus_state` | `drive1541/drive-session-manager` | no daemon method found — does TRX64 expose IEC lines? |
| ~~`runtime_swimlane_slice`~~ | `v2/swimlane-render` | ~~rendering is C64RE-side; does it only need trace rows (then it keeps working) or live session state?~~ **ANSWERED in §7.2: trace rows. It keeps working.** |

### 7.1 Correction — it is nine, not three (measured while converting `headless.ts`)

"Has a counterpart on the daemon" and "**calls** it" are different claims, and §7
checked the first. Six more tools in `headless.ts` have no `isDaemonMode()` branch at
all — the whole handler is in-process, so there is nothing to collapse and nothing to
route:

| tool | TS module | why there is no daemon call |
|---|---|---|
| `runtime_drive_session_start` | `drive1541/drive-session-manager` | a **standalone drive** session — a 1541 with no C64 attached. TRX64 has no such object; its drive only exists inside a machine. |
| `runtime_drive_status` | ″ | reads that standalone session |
| `runtime_drive_persist_writes` | ″ | writes its modified GCR tracks back |
| `runtime_drive_session_save_vsf` | ″ + `vsf/drive-vsf` | .vsf of that session — LEGACY by its own description |
| `runtime_drive_session_load_vsf` | ″ + `vsf/drive-vsf` | ″ |
| `runtime_session_snapshot` | `integrated-session-manager` + `snapshot` | returns a **structured JSON** state object; the daemon's `snapshot/dump` writes a `.c64re` **file**. Different product, not a missing route — and `tier-tools.ts` already says so at its demotion comment. |

Together with `runtime_iec_bus_state` (same standalone-drive family) that is **five of
the nine sitting on one module**: `drive-session-manager`. The question for step 3 is
therefore not five questions but one — *does a C64-less drive session survive at all?*
If it does not, six tools retire together and the `vsf/` pair goes with them.

**All nine are ADVANCED-only** — none appears in `DEFAULT_TOOLS`, so none is reachable
by an LLM without `C64RE_FULL_TOOLS`. Retiring them changes no default surface.

### 7.2 One answered, three more found (measured while converting `runtime.ts`)

**`runtime_swimlane_slice` is ANSWERED: trace rows, not live session state.** It has
been calling `trace/read op=swimlane` since Spec 802; the tool keeps working. What is
left in `v2/swimlane-render` is `renderMarkdown` — 38 lines of pure formatting over a
plain row shape, with a type-only import and nothing else. The runtime has a swimlane
text renderer (`swimlane_text`), but it renders the *folded TUI* format the monitor
uses, not the markdown table this tool returns; routing there would change the tool's
output, which is a rewrite, not a removal. So: step 1 should have evacuated
`swimlane-render.ts` and did not — it is a formatter, in the class of the 33 movers.
It has four other consumers (`workspace-ui/ws-server.ts` plus
`scripts/{smoke-swimlane,render-swimlane,e2e-746-13-flow-focus,e2e-754-monitor}.mjs`),
so the move is a small cross-file change, not a `runtime.ts` one. **Decide with step 4:
move it out, or lose the markdown format.**

**Three more with no counterpart at all** — same shape as §7.1, found the same way:

| tool | TS module | why there is no daemon call |
|---|---|---|
| `runtime_export_screenshot` | `export/screenshot` | replays a SCENARIO from its start to `at_cycle` and writes a scaled PNG. The daemon has `session/screenshot` + `runtime/render_screen` — the *live* frame. Neither takes a scenario, a cycle or a scale. |
| `runtime_export_video` | `export/video` | scenario → MP4 via ffmpeg. No method, no family. |
| `runtime_export_audio` | `export/audio-export` | scenario → WAV. `audio/export` is the LIVE session's SID for N seconds (that is `runtime_session_export_audio`, converted); a saved scenario is a different input. |

There is no `export/*` method group on the daemon. Left untouched — inventing a
composition (`scenario_run` then `render_screen`) would be a new feature wearing an old
tool's name. **All three are ADVANCED-only**, and `tier-tools.ts` already carries the
reason at its demotion comment: *"they replay a SCENARIO in an in-process TS machine
(bypassing the daemon) — off the customer surface until scenario render runs on
TRX64."* That sentence is now the step-3 question: does scenario render move to the
runtime, or do the three retire?

**Running total for step 3: eleven** — the eight still open from §7/§7.1 (nine minus
the answered swimlane) plus these three. Every one is ADVANCED-only.

## 8. Execution order

1. ~~**Evacuate the 40 keepers**~~ **DONE 2026-08-12** — 33 moved to
   `src/monitor/` (7), `src/analysis/` (15), `src/recorder/` (7), `src/input/` (4);
   7 left to die with the emulator (§6.1). The `DEPRECATED — TypeScript runtime`
   banner was dropped from the 33: it claimed they are reachable only with
   `C64RE_RUNTIME_TS=1`, which was never true of them.

   **Four classes of path breakage, all silent to a path-string grep** — worth
   keeping because step 2 walks the same ground:
   - *specifiers escaping the moved tree* — `query-events` →
     `../../trace/store/schema726.js`, `resolve-pc` →
     `../../project-knowledge/effective-segments.js`. tsc caught both.
   - *multi-line imports* — `v2/{breakpoint-runtime,monitor}.ts` import
     `./breakpoints.js` across a wrapped statement, so a line-oriented scan
     reported zero edges. tsc caught both.
   - *roots counted in levels* — `vice-diff` counted six up for "the repo root"
     and landed two directories **above** the repo (wrong before the move too);
     `fingerprint` counted three and hit `dist/`, which the move happens to
     correct. `recorder/runtime-recorder`'s worker path survived untouched
     because `recorder-worker` moved with it and they stayed siblings.
   - *directories outside `tsconfig.json`* — `"include": ["src/**/*.ts"]` means
     `ui/` and `tests/` are never type-checked. `ui/vite.config.ts` imported
     `../src/runtime/headless/daemon/resolve-daemon-spawn` **without an
     extension**, dead since the phase-1 rename; fixed here. `tests/` is worse
     and is left alone deliberately — see §9.
2. **Convert the tools** — `headless.ts` (24 branches) and `runtime.ts` (12) lose
   their `else` and call the daemon. Independent files, parallelisable.
   **`headless.ts` DONE 2026-08-12** — all 24, daemon side untouched. What the
   collapse actually cost, beyond the brace matcher:
   - *the redeclaration was real, and singular*: `resolveTraceOut` was destructured
     from `./runtime-trace-sink.js` on **both** sides of `session_start`. Removing
     the else removes it; nothing had to be renamed.
   - *three inputs died with the branch that read them*: `session_start`'s
     `trace_iec` / `trace_drive` / `enable_kernal_*_traps` and `session_run`'s
     `breakpoints` were `IntegratedSession` construction options — the daemon has
     always accepted and ignored them. Left in the schemas (removing them is an
     input-surface change, not a path removal) and commented at the handler.
   - `session_run`'s `until` still throws its "not yet routed through the Runtime
     Daemon (744.4c slice 2)" error. That is the daemon's behaviour, unchanged —
     but note that with the else gone it is now the *only* behaviour, so 744.4c
     slice 2 is the thing standing between `until` and existing.
   - the `cpInProc` helper (an in-process `RuntimeController` for eight
     checkpoint/recorder tools) and the two already-unused static
     `../ts-emulator/{trace-query,trace-index}` imports went with it.
   - the branches were provably dead first: `isDaemonMode()` is false **only** under
     `C64RE_ALLOW_INPROC_RUNTIME=1`, and no script, gate or npm target in the repo
     sets it.

   **`runtime.ts` DONE 2026-08-12** — 11 branches (the twelfth `isDaemonMode()` was
   `candidateDaemon`'s inverted guard) plus `getApi()`, the helper that built an
   `AgentQueryApi` over a local session and was the whole reason four handlers had no
   daemon route. 36 `../ts-emulator/…` import sites → 4. What it cost:
   - *no redeclaration here* — the collisions the brace matcher hit were all in
     `headless.ts`. What `runtime.ts` had instead was **more imports than branches**
     (36 vs 12): the excess is nine whole tools whose only implementation was
     in-process, converted individually.
   - *two verbs, not one*: `resolvePc`, `diffSnapshots` and `formatDiff` are backed by
     the runtime but sit **outside** the narrow `api/call` allowlist (ten methods:
     monitor/step/breakpoint/until/status). They need the wide facade verb
     `runtime/call`, hence a new `callApiFull` beside `callApi`. Reading the allowlist
     first is what stopped this from becoming "no counterpart, leave it".
   - *`runtime_diff_snapshots` still reads the files here*, because the paths are the
     caller's; only the diff moved. The buffers travel as the number-array transport
     `saveVsf` already uses (68 KB per .vsf, measured). Its `enrich` input was ALWAYS
     inert — the TS signature is `_opts`, never read — so dropping the argument loses
     nothing and the input stays accepted.
   - *the scenario registry belongs to the runtime now*, so `scenarios/` resolves
     against the runtime's project dir, not the MCP's. Identical in production (the
     MCP spawns it with `--project <projectDir>`), different for a hand-started
     daemon: it then keeps the scenario in memory and returns no `filePath`. The tool
     says so rather than printing `saved to undefined`.
   - *`batch/start` is sequential, not parallel.* The tool's description said "in
     parallel via worker_threads"; the runtime runs the scenarios one after another
     in-process and returns the COMPLETED entry. Description corrected to state the
     contract that survives (a batchId to poll) rather than an implementation.
   - verified live, end to end, against a **separate daemon on its own port** — never
     the shared one (doctrine: one machine per process): 14 converted routes including
     both facade verbs, the scenario CRUD round trip, a real .vsf diff, media
     ingress/persist, `vic/inspect/at_capture` and `audio/export`.
   - *the branch-count in this line was right and the import-count was the signal.*
     "12 branches" described the mechanical work; the other 24 import sites were the
     actual job.
3. **Answer the eleven** (§7 + §7.1 + §7.2); convert or retire those tools.
4. **Delete the 166.**
5. **Retire Spec 723 + `probe-single-path`** — they govern the TS runtime.
6. **e2e**: a fresh project, boot, monitor, trace, screenshot — through the daemon only.

A branch collapse is NOT a mechanical rewrite. The first attempt unwrapped
`if (isDaemonMode())` blocks with a brace matcher and produced 18 redeclaration
errors, because a `const` inside the branch collided with one in the outer scope.
Each site needs reading.

---

## 9. Open — `tests/` has been dead since the phase-1 rename

63 files under `tests/` still import `dist/runtime/headless/**`, a path that
stopped existing at commit f80b4674. `tsconfig.json` includes only
`src/**/*.ts` and no npm script runs them, so nothing reported it — the same
blind spot that killed `ui/vite.config.ts`. They are mostly `tests/unit/{cpu,
cia,via,vic,sid,alarm}` and `tests/spec-61{5,6,7}`: chip-level fidelity tests
for the TS emulator, i.e. they are part of what step 4 deletes.

Not repaired here, because repairing them means repointing 63 files at code
that is being removed three steps later. The decision to take with step 4:
delete them alongside the emulator, or keep whichever survive as TRX64 port
references. `CLAUDE.md` already says "No test suite exists" — this is the
evidence for that sentence, and the tree should stop implying otherwise.
