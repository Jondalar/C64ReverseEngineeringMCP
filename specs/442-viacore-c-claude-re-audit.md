# Spec 442 — `viacore.c` Claude-eigener line-by-line re-audit

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 441  
**Doctrine:** Spec 434 hat einen Subagent das audit machen lassen.
Resultat war "33 fns MATCH" — unzuverlässig per epic-440 (GCR-fall).
**Anchors:**
- `docs/vice-iec-arc42.md` §5.5
- `/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.c` (2243 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/via.h`

## VICE source

- `viacore.c` — 2243 LoC, 6522 VIA core.
- `via.h` — struct + signal/edge defines.

Functions in scope (no shortcut):

- `viacore_init`, `viacore_reset`, `viacore_signal`,
  `viacore_read`, `viacore_store`, `viacore_peek`
- `update_myviairq` / `update_myviairq_rclk`
- Timer alarms (T1 zero, T2 zero, T2 underflow)
- IFR clear-on-read/write rules per register (ORA, ORB, IRA, IRB,
  T1L/T1H, T2L/T2H, SR, ACR, PCR, IFR, IER)
- PCR edge polarity for CA1/CA2/CB1/CB2
- IER bit-7 rule (set/clear semantics)
- ACR-mode bits (T1_PB7, T2_CONTROL, SR_CONTROL, latching)
- Shift register modes (free-run, T2-clocked, external)
- Snapshot save/load — OUT of scope for V1
- ALARM callbacks: `int_via_t1` `int_via_t2`

## Headless target

`src/runtime/headless/via/via6522-vice.ts` (1341 LoC).

Spec 434 produced `docs/spec-434-viacore-audit.md` based on a
subagent run. That doc is **invalidated** by this spec until each
row is re-verified by Claude.

## Audit procedure (Claude-self only)

1. Open `viacore.c` from top. For each function:
   - Read its body in full.
   - Find TS counterpart in `via6522-vice.ts`.
   - Append/overwrite a row in `docs/spec-442-viacore-audit.md`
     (overwrite the old 434 file — don't keep two).
   - State the verdict + line cite both sides.
2. Pay special attention to:
   - Bit-7 of IFR (always reflects `(ifr & ier & 0x7f) != 0`)
   - Edge-tag dispatch order for CA1 vs CA2 vs CB1 vs CB2 vs CB2-output
   - IER write semantics (`(val & 0x80) ? (ier |= val & 0x7f) : (ier &= ~val)`)
   - PCR edge-polarity gates (4 channels)
   - T1 reload-mode (PB7 toggle)
   - T2 pulse-counting mode
   - Shift-register state machine
3. Any non-MATCH = fix in this same PR.

## Acceptance

1. `docs/spec-434-viacore-audit.md` REMOVED or replaced by
   `docs/spec-442-viacore-audit.md` (one source of truth).
2. New audit has at least 60 rows (vs Spec 434's 33, because
   T1/T2 alarms + each register write/read pair are separate rows).
3. Each row cites VICE file:line AND TS file:line.
4. Every non-MATCH has a commit-sha referencing the fix.
5. Two new unit-tests:
   - `tests/viacore-ifr-clear.test.ts` — every register read/write
     IFR clear-bit pair (20+ vectors)
   - `tests/viacore-pcr-edge.test.ts` — CA1/CA2/CB1/CB2 PCR-edge
     polarity matrix (16 vectors)
6. `npm run canary:spec-430` still green.
7. No subagent invoked.

## Do Not

- Do not skim. Read viacore.c top to bottom.
- Do not trust the Spec 434 doc.
- Do not delegate.
- Do not "fix style" only — semantic 1:1 only.
