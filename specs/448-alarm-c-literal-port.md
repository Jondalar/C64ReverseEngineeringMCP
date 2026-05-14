# Spec 448 — `alarm.c` literal port

**Status:** DONE (2026-05-14)  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 447  
**Proof:** [docs/spec-448-production-proof.md](../docs/spec-448-production-proof.md)  
**Doctrine:** The alarm system is the timing backbone for VIA1/VIA2
timers, rotation, and CPU events. Current TS `alarm/alarm-context.ts`
is abstract — needs literal port to match VICE.

## VICE source

- `alarm.c` + `alarm.h` ~400 LoC total
- struct `alarm_context_t`
- struct `alarm_t`
- Functions: `alarm_context_init`, `alarm_new`, `alarm_set`,
  `alarm_unset`, `alarm_destroy`, `alarm_pending_*`,
  `alarm_context_dispatch`

## Headless target

`src/runtime/headless/alarm/alarm-context.ts` (and related).
Today: TS class with custom queue. Must become literal port:
- `alarm_context_t` struct fields (pending heap, context name, etc.)
- `alarm_t` struct fields (callback, name, context-ref, data)
- Same registration order semantics
- Same dispatch order (next-due alarm first; ties by registration
  order)

## Audit + port

`docs/spec-448-alarm-audit.md`.

## Acceptance

1. State-shape mirrors `alarm_context_t` + `alarm_t` 1:1.
2. Dispatch order matches VICE for same input sequence.
3. Audit doc committed.
4. All callers in `via6522-vice.ts`, `rotation`-equivalent, drive
   cycle execution unchanged in behavior.
5. New smoke `tests/alarm-dispatch.test.ts` for tie-breaking.
6. Canaries green.

## Do Not

- Don't merge alarm system with `IntegratedSession` scheduler.
- Don't add an event-priority system VICE doesn't have.
- **Spec 148/149 verdicts INVALIDATED** under Epic-440 doctrine.
  Re-audit every line Claude-self. Sprint 430 GCR precedent:
  subagent "5 PASS", manual found 2 bugs.
- **No min-heap / priority-queue / sorted-pending.** VICE =
  unsorted `pending_alarms[256]` + cached `next_pending_alarm_clk` +
  `next_pending_alarm_idx`. Current header-comment claims "min-heap"
  but body is unsorted-array. Header is WRONG; body is right.
- **No class-wrappers / no method-this.** Top-level `alarm_set(alarm, clk)`
  not `context.set(alarm, clk)`. C-style port. Public exports MUST
  be VICE-verbatim snake_case names.

## FLACH-MANDATE

| Antipattern | Doctrin |
|---|---|
| `class AlarmContext { set(alarm, clk) }` | top-level `alarm_set(alarm, clk)` |
| camelCase exports (`alarmSet`, `alarmContextDispatch`) | VICE-verbatim `alarm_set`, `alarm_context_dispatch` |
| Min-heap / sorted-pending | unsorted `pending_alarms[256]` + cached head |
| `AlarmContext` / `Alarm` interface names | literal `alarm_context_t` / `alarm_t` snake_case |
| `AlarmCallback` type | literal `alarm_callback_t` snake_case |
| Hidden time-warp / dispatch optimization | literal C-style |
