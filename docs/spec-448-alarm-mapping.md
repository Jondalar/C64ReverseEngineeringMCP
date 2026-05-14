# Spec 448 — alarm.c + alarm.h ↔ alarm-context.ts mapping (Claude-self re-audit)

**Status:** PROGRESS — Phase 2 audit complete (algorithm verified MATCH; rename + header-rot fixes pending)
**VICE sources:**
- `src/alarm.c` (212 LoC)
- `src/alarm.h` (187 LoC)
**TS target:** `src/runtime/headless/alarm/alarm-context.ts`
**Doctrine:** Claude-self, no subagents. Spec 148/149 verdicts INVALIDATED.

Verdict legend: MATCH / DEVIATION / BUG / MISSING / TS-EXTRA / OMIT-OK / RENAME-NEEDED.

---

## A. Constants

| VICE | Lines | TS | Verdict |
|---|---|---|---|
| `ALARM_CONTEXT_MAX_PENDING_ALARMS = 0x100` | alarm.h:33 | `ALARM_CONTEXT_MAX_PENDING_ALARMS = 0x100` (alarm-context.ts:44) | **MATCH** |
| `CLOCK_MAX = ~((CLOCK)0)` (uint32) | types.h | `CLOCK_MAX = 0xffffffff >>> 0` (alarm-context.ts:47) | **MATCH** |

## B. Type definitions

| VICE struct/typedef | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `alarm_callback_t` (fn-pointer) | alarm.h:35 | `type AlarmCallback` (alarm-context.ts:54) | **RENAME-NEEDED** → `alarm_callback_t` |
| `struct alarm_s` / `alarm_t` | alarm.h:38-58 | `interface Alarm` (alarm-context.ts:62-76) | **RENAME-NEEDED** → `alarm_t`. Fields snake_case OK. |
| `struct pending_alarms_s` / `pending_alarms_t` | alarm.h:60-67 | `interface PendingAlarm` (alarm-context.ts:79-82) | **RENAME-NEEDED** → `pending_alarms_t`. Fields MATCH. |
| `struct alarm_context_s` / `alarm_context_t` | alarm.h:70-88 | `interface AlarmContext` (alarm-context.ts:85-98) | **RENAME-NEEDED** → `alarm_context_t`. Fields snake_case MATCH. |

### B.1 alarm_t fields (alarm.h:38-58)

| VICE field | TS field | Verdict |
|---|---|---|
| `char *name` | `name: string` | MATCH |
| `struct alarm_context_s *context` | `context: AlarmContext` (→ `alarm_context_t` post-rename) | MATCH |
| `alarm_callback_t callback` | `callback: AlarmCallback` (→ `alarm_callback_t` post-rename) | MATCH |
| `int pending_idx` | `pending_idx: number` | MATCH |
| `void *data` | `data: unknown` | MATCH |
| `struct alarm_s *next, *prev` | `next: Alarm \| null; prev: Alarm \| null` | MATCH |

### B.2 pending_alarms_t fields (alarm.h:60-67)

| VICE field | TS field | Verdict |
|---|---|---|
| `struct alarm_s *alarm` | `alarm: Alarm` | MATCH |
| `CLOCK clk` | `clk: CLOCK` | MATCH |

### B.3 alarm_context_t fields (alarm.h:70-88)

| VICE field | TS field | Verdict |
|---|---|---|
| `char *name` | `name: string` | MATCH |
| `struct alarm_s *alarms` (head of dll) | `alarms: Alarm \| null` | MATCH |
| `pending_alarms_t pending_alarms[256]` | `pending_alarms: PendingAlarm[]` (size-fixed 256) | MATCH |
| `unsigned int num_pending_alarms` | `num_pending_alarms: number` | MATCH |
| `CLOCK next_pending_alarm_clk` | `next_pending_alarm_clk: CLOCK` | MATCH |
| `int next_pending_alarm_idx` | `next_pending_alarm_idx: number` | MATCH |

---

## C. Functions (12 entry points)

| VICE function | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `alarm_context_new(name)` | alarm.c:39-47 | `alarmContextNew(name)` (alarm-context.ts:111-122) | RENAME-NEEDED → `alarm_context_new` |
| `alarm_context_init(context, name)` | alarm.c:49-57 | `alarmContextInit(context, name)` (alarm-context.ts:132-138) | RENAME-NEEDED → `alarm_context_init` |
| `alarm_context_destroy(context)` | alarm.c:59-77 | `alarmContextDestroy(context)` (alarm-context.ts:147-160) | RENAME-NEEDED → `alarm_context_destroy` |
| `alarm_context_time_warp(context, amount, dir)` | alarm.c:79-101 | `alarmContextTimeWarp(...)` (alarm-context.ts:170-197) | RENAME-NEEDED → `alarm_context_time_warp` |
| `alarm_init` (static) | alarm.c:105-125 | inlined into `alarmNew` body | MATCH-INLINED |
| `alarm_new(context, name, cb, data)` | alarm.c:127-137 | `alarmNew(...)` (alarm-context.ts:210-238) | RENAME-NEEDED → `alarm_new` |
| `alarm_destroy(alarm)` | alarm.c:139-165 | `alarmDestroy(alarm)` (alarm-context.ts:246-269) | RENAME-NEEDED → `alarm_destroy` |
| `alarm_unset(alarm)` | alarm.c:167-207 | `alarmUnset(alarm)` (alarm-context.ts:279-315) | RENAME-NEEDED → `alarm_unset` |
| `alarm_log_too_many_alarms()` | alarm.c:209-212 | `alarmLogTooManyAlarms()` (alarm-context.ts:448-450) | RENAME-NEEDED → `alarm_log_too_many_alarms` |
| `alarm_context_next_pending_clk(context)` (inline) | alarm.h:105-108 | `alarmContextNextPendingClk(context)` (alarm-context.ts:326-328) | RENAME-NEEDED → `alarm_context_next_pending_clk` |
| `alarm_context_update_next_pending(context)` (inline) | alarm.h:110-129 | `alarmContextUpdateNextPending(context)` (alarm-context.ts:338-353) | RENAME-NEEDED → `alarm_context_update_next_pending` |
| `alarm_context_dispatch(context, cpu_clk)` (inline) | alarm.h:131-144 | `alarmContextDispatch(context, cpuClk)` (alarm-context.ts:374-390) | RENAME-NEEDED → `alarm_context_dispatch` |
| `alarm_set(alarm, cpu_clk)` (inline) | alarm.h:146-185 | `alarmSet(alarm, cpuClk)` (alarm-context.ts:408-439) | RENAME-NEEDED → `alarm_set` |

---

## D. Algorithm audit per function (Claude-self, line-by-line vs VICE)

### `alarm_set` (alarm.h:146-185) ↔ TS:408-439

| VICE step | TS step | Verdict |
|---|---|---|
| `idx = alarm->pending_idx` | `const idx = alarm.pending_idx` | MATCH |
| `if (idx < 0)` not-pending branch | `if (idx < 0)` | MATCH |
| append: `new_idx = num_pending_alarms` | `const newIdx = context.num_pending_alarms` | MATCH |
| `if (new_idx >= 0x100)` overflow check + log | `if (newIdx >= ALARM_CONTEXT_MAX_PENDING_ALARMS)` + log | MATCH |
| store `pending_alarms[new_idx] = {alarm, clk}` | `context.pending_alarms[newIdx] = {alarm, clk: cpuClk}` | MATCH |
| `num_pending_alarms++` | `context.num_pending_alarms++` | MATCH |
| `if (cpu_clk < next_pending_alarm_clk)` cache update | `if (cpuClk < context.next_pending_alarm_clk)` | MATCH |
| `alarm->pending_idx = new_idx` | `alarm.pending_idx = newIdx` | MATCH |
| else: already-pending modify | else: same | MATCH |
| `pending_alarms[idx].clk = cpu_clk` | `context.pending_alarms[idx]!.clk = cpuClk` | MATCH |
| condition: `next_pending_alarm_clk > cpu_clk \|\| idx == next_pending_alarm_idx` | same | MATCH |
| call `alarm_context_update_next_pending(context)` | call same | MATCH |

**Verdict: ALGORITHM MATCH.**

### `alarm_unset` (alarm.c:167-207) ↔ TS:279-315

| VICE step | TS step | Verdict |
|---|---|---|
| `idx = alarm->pending_idx; if (idx<0) return` | same | MATCH |
| `if (num_pending_alarms > 1)` | same | MATCH |
| `last = --num_pending_alarms` | `const last = --context.num_pending_alarms` | MATCH |
| `if (last != idx)` swap-with-last | same | MATCH |
| copy alarm + clk + fix moved.pending_idx | same | MATCH |
| if cached_idx==idx: `alarm_context_update_next_pending` | same | MATCH |
| elif cached_idx==last: `next_pending_alarm_idx = idx` | same | MATCH |
| else (only one): reset num=0, clk=CLOCK_MAX, idx=-1 | same | MATCH |
| `alarm->pending_idx = -1` | same | MATCH |

**Verdict: ALGORITHM MATCH.**

### `alarm_context_dispatch` (alarm.h:131-144) ↔ TS:374-390

| VICE step | TS step | Verdict |
|---|---|---|
| `offset = cpu_clk - next_pending_alarm_clk` | `const offset = u32(cpuClk - context.next_pending_alarm_clk)` | MATCH (TS explicit u32 wrap mirrors VICE uint32) |
| `idx = next_pending_alarm_idx` | same | MATCH |
| `alarm = pending_alarms[idx].alarm` | same | MATCH |
| `(callback)(offset, data)` | `alarm.callback(offset, alarm.data)` | MATCH |
| does NOT remove / update cache (callback responsibility) | same | MATCH |

**TS-EXTRA:** TS adds `if (slot === undefined) throw` defensive check (alarm-context.ts:380-387). VICE would crash on invalid index. TS-EXTRA-ACCEPTABLE (catches misuse; doesn't change correct-path behaviour).

**Verdict: ALGORITHM MATCH** + 1 TS-EXTRA defensive guard.

### `alarm_context_update_next_pending` (alarm.h:110-129) ↔ TS:338-353

| VICE step | TS step | Verdict |
|---|---|---|
| `next_pending_alarm_clk = CLOCK_MAX` | `let nextPendingAlarmClk: CLOCK = CLOCK_MAX` | MATCH |
| `next_pending_alarm_idx = context->next_pending_alarm_idx` (preserve) | same | MATCH |
| scan `i = 0..num_pending_alarms` | same | MATCH |
| `if (pending_clk <= next_pending_alarm_clk)` (=, not <) | same `<=` | **MATCH** (preserves VICE tie-break: LAST entry in array order wins) |
| write back to context | same | MATCH |

**Verdict: ALGORITHM MATCH.**

### `alarm_context_time_warp` (alarm.c:79-101) ↔ TS:170-197

| VICE step | TS step | Verdict |
|---|---|---|
| `if (warp_direction == 0) return` | same | MATCH |
| for each pending: `clk += warp_amount` or `clk -= warp_amount` | same with `u32(...)` wrap | MATCH (explicit u32) |
| `next_pending_alarm_clk +=/- warp_amount` | same | MATCH |

**Verdict: ALGORITHM MATCH.**

### Other fns

- `alarm_context_new/init/destroy`: MATCH (TS init collapses init-into-new, mirrors VICE alloc+init)
- `alarm_new` / `alarm_init` inlined: MATCH (prepend to context.alarms dll, set pending_idx=-1)
- `alarm_destroy`: MATCH (unset + unlink from dll; null-input no-op)
- `alarm_log_too_many_alarms`: MATCH (console.warn vs log_error — TS-EXTRA-acceptable)

---

## E. Findings summary

| # | Finding | Severity |
|---|---|---|
| 1 | Header-comment line 5 claims "min-heap-by-clock" — code is unsorted-array. Doc-rot. | **DOC-BUG** |
| 2 | All 12 public exports use camelCase — VICE-verbatim snake_case mandated by FLACH-MANDATE. | **RENAME-NEEDED** |
| 3 | Type names `Alarm` / `AlarmContext` / `AlarmCallback` / `PendingAlarm` UpperCamelCase — should be `alarm_t` / `alarm_context_t` / `alarm_callback_t` / `pending_alarms_t` snake_case. | **RENAME-NEEDED** |
| 4 | Defensive `if (slot === undefined) throw` in dispatch | TS-EXTRA-ACCEPTABLE |
| 5 | Algorithm body for `alarm_set` / `alarm_unset` / `alarm_context_dispatch` / `alarm_context_update_next_pending` / `alarm_context_time_warp` | **ALGORITHM MATCH** (line-by-line) |
| 6 | Spec 149 cite + Spec 401 cite in header | DOC-ROT (purge → Spec 448 closeout) |

**No load-bearing algorithm BUGs found.** Sprint 149 audit produced correct algorithm body. The failure mode user predicted (Sprint 430 GCR precedent: subagent PASS, manual finds bug) DID NOT MATERIALIZE for the body — but the header comment claim ("min-heap") IS a documentation-level lie that would mislead a future reader.

---

## F. Caller-impact list (mass-rename)

Files that import / call the renamed identifiers:

- `src/runtime/headless/via/via6522-vice.ts` (5 alarms: t1_zero, t2_zero, t2_underflow, t2_shift, phi2_sr)
- `src/runtime/headless/scheduler/cycle-wrappers.ts` (`alarmContextDispatch`, `alarmContextNextPendingClk`)
- `src/runtime/headless/drive/drive-cpu.ts` (`AlarmContext` type)
- `src/runtime/headless/cpu/cpu65xx-vice.ts` (CPU dispatch tick — if any)
- All test files that touch alarm fns

Strategy: ADD snake_case aliases that delegate to existing impls; keep camelCase aliases marked `@deprecated` for back-compat during transition; future commit purges camelCase after all callers migrate.

OR: Mass rename in single commit (cleaner). Estimated ~30-50 call sites.

---

## G. Acceptance check

- [x] Mapping doc committed (this file)
- [ ] Header doc-rot fixed (Phase 3)
- [ ] Snake_case rename for 12 fns + 4 types (Phase 3)
- [ ] Caller migration (Phase 5)
- [ ] Tie-breaking smoke test (Phase 4)
- [ ] Spec 444 cycle-diff unchanged (Phase 6)
- [ ] canary:spec-430 5/5 (Phase 6)
- [ ] Production-proof doc with SHAs (Phase 6)
