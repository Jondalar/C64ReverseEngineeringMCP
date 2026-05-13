# Spec 434 — Phase D: `viacore.c` subset audit + literal alignment

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase D  
**Depends on:** [Spec 433](433-1541-port-phase-c-via1d1541-literal.md)  
**Doctrine:** Literal audit, not rewrite. `via6522-vice.ts` already
exists (1341 LOC). Compare line-by-line against VICE viacore.c for the
subset that the 1541 VIA1+VIA2 actually exercise. Fix any deviation;
do not modernize.
**Anchors:**
- `docs/vice-iec-arc42.md` §5.5 (via1d1541 + viacore)
- `docs/vice-1541-arch.md` §6.5 (CA1 = ATN line)
- `docs/vice-1541-arch.md` §6.6 (VIA1 timers and SDR)

## VICE source of truth

- `/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.c` (2243 LOC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/via.h`

Subset in scope for the 1541-only milestone:

| VICE function | Required for | In scope |
|---------------|--------------|----------|
| `viacore_signal` | CA1 ATN, CB1 BYTE-READY (VIA2) | ✅ |
| `update_myviairq` / `update_myviairq_rclk` | IRQ output to drive CPU | ✅ |
| IFR clear-on-read/write rules (ORA, ORB, IRA, IRB, T1L, T1H, T2L, T2H, SR) | drive ROM handlers | ✅ |
| PCR edge polarity (CA1, CA2, CB1, CB2) | ATN edge direction | ✅ |
| IER set/clear semantics | drive ROM `$1800-$180F` writes | ✅ |
| T1 + T2 timer alarm scheduling | VIA1 timers (motm fastloader uses T1) | ✅ |
| `viacore_read` / `viacore_store` dispatch | mandatory | ✅ |
| Shift register modes (SR free-run, T2 clocked, external) | VIA2 SR (defer to Spec 437 if GCR coupling shows up); VIA1 SR is unused in motm/MM/LNR | ⚠ partial — VIA1 only |
| ACR mode bits not used by 1541 | — | ❌ |
| Snapshot save/load | not on critical path | ❌ |

## Audit procedure

This is NOT a rewrite. It is a structured diff.

1. For each function in scope, produce a side-by-side note in
   `docs/spec-434-viacore-audit.md`:
   - VICE file:line range
   - HL file:line range (`via6522-vice.ts`)
   - Behavioral diff (state writes, IFR/IER bits set, alarm
     scheduled, return value)
   - Verdict: MATCH / MINOR-DEVIATION / BUG
2. Every MINOR-DEVIATION or BUG verdict gets a fix patch in the
   same PR.
3. State-shape pass: `via_context_t` fields named in the audit doc
   must map 1:1 to TS fields. Rename TS fields if needed.

## Required formulas (non-negotiable)

### `viacore_signal(via, sig, edge_tag)`

```text
if sig == VIA_SIG_CA1:
    if (edge_tag == VIA_SIG_RISE && (pcr & 0x01))
       || (edge_tag == 0           && !(pcr & 0x01)):
        ifr |= VIA_IM_CA1
        update_myviairq_rclk(rclk)
... same shape for CA2, CB1, CB2 ...
```

Edge polarity is gated by the corresponding PCR bit. Do not
re-interpret the edge tag locally.

### `update_myviairq_rclk(rclk)`

```text
new_irq = (ifr & ier & 0x7f) ? 1 : 0
if new_irq != old_irq:
    via_set_int(rclk, new_irq)
```

The `rclk` argument is the drive clock at the IFR-changing event.
It must reach the drive CPU IRQ pipeline so that interrupt sampling
is at the same cycle as VICE.

### IFR clear-on-read rules

Per `viacore.c` `viacore_read`. For each register, the IFR bit that
is cleared on read must exactly match VICE. Audit doc lists each.

## Headless files in scope

- `src/runtime/headless/via/via6522-vice.ts` — audit + targeted fixes
- `src/runtime/headless/via/via1d1541.ts` — only if a fix in viacore
  changes the wrapper's expected callback signature
- `src/runtime/headless/via/via2d1541.ts` — touched only if a fix in
  viacore affects VIA2 IRQ/CB1 path

## Wrapper purge (this phase's slice of Phase F)

- Remove any `// LEGACY` / `// HYBRID` comments in via6522-vice.ts
  that are no longer load-bearing.
- Remove any `_pcrFastPath` / `_ifrSnapshot` shortcuts not present
  in VICE. (Audit doc will enumerate.)
- Remove dead branches behind `process.env.C64RE_LEGACY_*` flags
  specific to viacore.

## Acceptance

1. `docs/spec-434-viacore-audit.md` committed. Every in-scope row
   has a MATCH verdict or a fix-commit-hash next to it.
2. `viacore_signal` accepts and dispatches edge tags
   (`VIA_SIG_RISE`, `VIA_SIG_FALL`, `0`) per VICE.
3. IFR clear-on-read table verified by unit test
   (`tests/viacore-ifr-clear.test.ts`).
4. `update_myviairq_rclk` stamps IRQ at `rclk` (drive-clock) not
   at "next instruction boundary".
5. All 4 green canaries from Spec 431 remain green.
6. LNR-S1 first-divergence row report updated in
   `docs/spec-430-progress.md` — must not regress earlier than
   Spec 433.

## Do Not

- Do not rewrite viacore.ts from scratch. Audit + targeted fix only.
- Do not add VIA2-SR/GCR coupling logic — that's Spec 437.
- Do not generalize for VIC-20 / Plus4 VIAs. 1541 only.
- Do not introduce typed enums where VICE uses numeric tags
  unless it preserves the numeric value exactly.

## Agent Instruction

```text
Implement Spec 434. Audit via6522-vice.ts against VICE viacore.c for
the 1541 VIA1 subset listed in the spec. Produce a row-per-function
audit doc with VERDICT (MATCH/MINOR/BUG) and patch every non-MATCH in
the same PR. Edge-tag dispatch in viacore_signal is mandatory.
update_myviairq_rclk must stamp IRQ at the drive-clock rclk. Keep
canaries green per Spec 431.
```
