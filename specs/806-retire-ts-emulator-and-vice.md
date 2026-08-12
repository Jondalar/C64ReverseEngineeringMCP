# Spec 806 — Retire the TS emulator and VICE from the product

**Status:** IN BUILD 2026-08-12 — phase 1 DONE, **§8 step 1 (evacuation) DONE**
(branch `spec-806-structural-cut`). Inventory + tool cross-check in §6/§7 below;
§6 corrected against the measurement in §6.1. Next: §8 step 2 (convert the tools).
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
| `runtime_swimlane_slice` | `v2/swimlane-render` | rendering is C64RE-side; does it only need trace rows (then it keeps working) or live session state? |

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
3. **Answer the three** above; convert or retire those tools.
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
