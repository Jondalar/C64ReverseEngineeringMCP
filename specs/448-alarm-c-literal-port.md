# Spec 448 — `alarm.c` literal port

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 447  
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
