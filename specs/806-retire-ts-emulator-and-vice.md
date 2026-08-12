# Spec 806 — Retire the TS emulator and VICE from the product

**Status:** IN BUILD 2026-08-12 — phase 1 DONE (branch `spec-806-structural-cut`, 6 commits). Inventory + tool cross-check in §6/§7 below.
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

1. **Evacuate the 40 keepers** out of `ts-emulator/` into honest homes
   (`src/monitor/`, `src/analysis/`, `src/recorder/`, `src/input/`).
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
