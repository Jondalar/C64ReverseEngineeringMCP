# Spec 448 — `alarm.c` + `alarm.h` production-proof

**Status:** DONE (2026-05-14)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal re-audit. Sprint 148/149 verdicts
**INVALIDATED** under Epic-440 doctrine — re-audited every line.

## Source of truth

- VICE `src/alarm.h` (187 LoC) — struct + inline `alarm_set` /
  `alarm_unset` / `alarm_context_next_pending_clk` /
  `alarm_context_update_next_pending`
- VICE `src/alarm.c` (212 LoC) — `alarm_context_new` /
  `alarm_context_init` / `alarm_context_destroy` /
  `alarm_context_time_warp` / `alarm_new` / `alarm_destroy` /
  `alarm_log_too_many_alarms` / `alarm_context_dispatch`

## TS targets

- `src/runtime/headless/alarm/alarm-context.ts` (re-port + rename)
- `tests/unit/alarm/alarm-dispatch.test.ts` (NEW — tie-breaking +
  edge-case smoke)

## FLACH-MANDATE compliance

| Antipattern (rejected) | Doctrin (this port) |
|---|---|
| `class AlarmContext { set(alarm, clk) }` | top-level `alarm_set(alarm, clk)` |
| camelCase exports `alarmSet`, `alarmContextDispatch` | VICE-verbatim `alarm_set`, `alarm_context_dispatch` |
| Min-heap / sorted-pending | unsorted `pending_alarms[256]` + cached head |
| `AlarmContext` / `Alarm` interface names | literal `alarm_context_t` / `alarm_t` snake_case |
| `AlarmCallback` type | literal `alarm_callback_t` snake_case |
| Hidden time-warp / dispatch optimization | literal C-style |

## Audit coverage

`docs/spec-448-alarm-mapping.md` — 18 entry-point rows (2 constants
+ 4 types + 12 functions) + sub-tables for `alarm_t` /
`pending_alarms_t` / `alarm_context_t` field shapes.

## Final state

| Verdict | Count |
|---|---|
| MATCH (algorithm body verified line-by-line vs VICE) | 12 functions |
| MATCH (struct shape 1:1) | 4 types |
| DOC-BUG fixed (Sprint 149 header falsely claimed "min-heap") | 1 |
| RENAME-NEEDED → applied (camelCase → snake_case canonical) | 12 fns + 4 types |
| **BUG / load-bearing MISSING** | **0** |

### Ticketed-out

| Item | Target | Reason |
|---|---|---|
| alarm-context snapshot R/W | OUT (V1) → covered by Spec 451 (VSF cross-load) | VICE `alarm.c` has no snapshot module; chip-side VSF serializes alarm state per-chip (CIA / VIA timer fields include their own pending alarm clks). No alarm-system snapshot work owed by this spec. |
| `AlarmContextCycled` class wrapper | Removed in Spec 448.2 hygiene | FLACH-mandate consistency — VICE-equivalent is `PROCESS_ALARMS` macro (6510core.c:139-143), inline at CPU dispatch. Replaced by top-level `process_alarms(ctx, clk)` in `scheduler/cycle-wrappers.ts` + inline scheduler-adapter at callsites. |

### Sprint 148/149 INVALIDATION outcome

- **Algorithm body**: VERIFIED MATCH vs VICE alarm.c/alarm.h. Sprint
  149 audit was correct on the algorithm — just lied in the header
  comment.
- **Header comment claim "min-heap"**: PURGED. Body was always
  unsorted-array + cached head (matches VICE). The "min-heap" claim
  was doc-rot from a stale design note.
- **Naming**: Sprint 149 used camelCase exports
  (`alarmSet`, `alarmContextDispatch` …). Renamed to VICE-verbatim
  snake_case (`alarm_set`, `alarm_context_dispatch` …) in Spec 448
  (commit `52bf98f`). `@deprecated` camelCase fn + type aliases were
  retained for transition, then **removed in Spec 448.1**
  (commit `9ad2e3f`) after all 15 type-callers migrated. Module
  surface is now 100% VICE-verbatim snake_case.

## Mass-rename callers

36 files migrated camelCase → snake_case via word-boundary regex
(`tools: python3 + re.sub(r'\b<old>\b', <new>, s)`):

```
src/runtime/headless/vic/vic-ii-vice.ts
src/runtime/headless/c64/{cia,vic}-fidelity-tests.ts
src/runtime/headless/scheduler/cycle-wrappers.ts
src/runtime/headless/cpu/cpu65xx-vice.ts
src/runtime/headless/kernel/headless-machine-kernel.ts
src/runtime/headless/drive/{drive-cpu,drive-cpu-equiv-tests,via1-iec-tests,drive-session}.ts
src/runtime/headless/cia/{cia6526-vice,cia-sdr}.ts
src/runtime/headless/via/via6522-vice.ts
tests/unit/via/{via-sr-modes,via-device-conformance,via-ca-cb-handshake,viacore-conformance,via-register-rw,via-ila-ilb-latch,via-t1-pb7-toggle,via2-device-conformance,via-write-offset}.test.ts
tests/unit/cia/{cia-write-offset,cia2-iec-write,cia-test-helpers}.{ts,test.ts}
tests/unit/alarm/alarm-context.test.ts
tests/unit/vic/vic-test-helpers.ts
scripts/{smoke-401-tick-order,smoke-403-cia-vice-trace,smoke-410-via1-atn-edge,smoke-410-via1-pb-formula,smoke-411-via2-byte-ready,smoke-419-atn-edge,smoke-420-drive-irq-delay,smoke-421-via1-pb-roundtrip,sprint69-smoke}.mjs
```

Note: `alarmContext` (no API-fn suffix) appearing in option-bag /
member-field names is preserved — TS field-naming convention, not
VICE API surface.

### Spec 448.1 type-alias migration (commit `9ad2e3f`)

15 files migrated camelCase type imports → snake_case
(`Alarm → alarm_t`, `AlarmContext → alarm_context_t`,
`AlarmCallback → alarm_callback_t`, `PendingAlarm → pending_alarms_t`):

```
src/runtime/headless/{integrated-session,vic/vic-ii-vice,
  cpu/{drive-cpu-contract,cpu65xx-vice},
  via/{via6522-vice,via1d1541,via2d1541},
  peripherals/{cia1,cia2}, scheduler/cycle-wrappers,
  drive/{drive-cpu,drive-types}, cia/cia6526-vice,
  kernel/headless-machine-kernel}.ts
tests/unit/alarm/alarm-context.test.ts
```

The 13 `@deprecated` camelCase fn re-exports + 4 type aliases at
the bottom of `alarm-context.ts` (lines 382-414 in commit `52bf98f`)
were deleted — zero remaining callers post-migration.

## Verification table

| Gate | Result |
|---|---|
| `npm run build` (tsc full + pipeline) | PASS |
| `npx tsx tests/unit/alarm/alarm-context.test.ts` (Sprint 149 regressions) | **22/22 PASS** |
| `npx tsx tests/unit/alarm/alarm-dispatch.test.ts` (NEW tie-breaking smoke) | **11/11 PASS** |
| `node tests/integration/drivecpu-vs-vice-baseline.test.mjs` (Spec 444 cycle-diff) | **9999/9999 within ±2; max abs delta = 1** |
| `npm run canary:spec-430` (5 baselines) | **5/5 PASS** (motm/mm-s1/im2/scramble PASS, lnr-s1 red-as-expected) |
| Spec 448.1 hygiene rerun (build + alarm + cycle-diff + canary) | **all PASS** (no regression from type-alias migration / dead-alias purge) |

**CRITICAL**: Spec 444 cycle-diff is the timing-backbone regression
gate — alarm dispatch order directly drives drive CPU cycle counting.
0 regression means re-port preserves dispatch semantics exactly.

## Tie-breaking semantics pinned

| Path | Cache assignment | Reason |
|---|---|---|
| Fast-path `alarm_set` append (alarm.h:170-173) | FIRST entry at clk wins | `if (cpu_clk < next_pending_alarm_clk)` — strict `<` |
| Slow-path `alarm_context_update_next_pending` rescan (alarm.h:110-129) | LAST entry at clk wins | `if (pending_clk <= next_pending_alarm_clk)` — `<=` |

Both paths covered by `alarm-dispatch.test.ts` cases 1 + 2.

## SHAs

| Commit | Subject |
|---|---|
| `452f493` | Spec 448 charter update + mapping doc — Claude-self re-audit (Sprint 149 INVALIDATED) |
| `52bf98f` | Spec 448 DONE — alarm.c literal re-port + 36-file fn-rename + tie-break smoke |
| `9ad2e3f` | Spec 448.1 hygiene — type-alias migration (15 files) + dead-alias deletion |
| `4f7be81` | Spec 448 + 448.1 doc hygiene — fill SHAs + close audit checkboxes |
| `<this-commit>` | Spec 448.2 hygiene — `AlarmContextCycled` class → `process_alarms` flat fn + snapshot-deferral row |

## Sprint 148/149 verdicts INVALIDATED

Per Epic-440 doctrine ([[feedback_1541_port_workflow]],
[[feedback_vice_no_alternatives]]): every legacy spec verdict on
this file is hereby invalidated. This Claude-self re-audit (mapping
doc + 33 conformance tests + 9999/9999 cycle-diff) is the canonical
proof of correctness for `alarm.c` + `alarm.h` port.
