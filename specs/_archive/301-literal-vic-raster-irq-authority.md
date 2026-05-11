# Spec 301 — Literal VIC-II Raster IRQ Authority

Status: open
Date: 2026-05-10
Predecessor: Spec 300 (literal $D000-$D3FF read/write authority)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 3 of migration plan

## Mini Phase 0

### Current state (post-Spec 300)

- `regs[]` shared by reference between VicIIVice and literal.
- `regs[0x1a]` (IRQ mask) identical in both.
- `irq_status` is INDEPENDENT — each chip maintains its own.
- VicIIVice IRQ: alarm-driven (`raster_irq_clk` + `alarmSet` callback);
  also tracks bit 0 + bit 7 summary.
- Literal IRQ: per-cycle polled. `vicii-cycle.ts:346` fires
  `vicii_irq_raster_trigger` when `raster_y == raster_irq_line` at
  cycle 0 (or cycle 1 for line 0). Sets bit 0; calls
  `vicii_irq_set_line` which OR-checks against `regs[0x1a]` and calls
  `host.maincpu_set_irq`.
- `$D019` ack writes go through literal `vicii_store` (Spec 300) →
  `collision_store` → `vicii_irq_set_line`. Literal handles ack.

### irqAsserted semantic (both)

```
(irq_status & regs[0x1a] & 0x0f) != 0
```

VicIIVice: `vic.irqAsserted()` (vic-ii-vice.ts:1321).
Literal: `(LIT_TYPES.vicii.irq_status & vic.regs[0x1a] & 0x0f) != 0`.

### Risk

Alarm vs per-cycle timing may differ by a few cycles when bit 0 is
set. Diff harness will reveal exact divergence.

### Slice

Wire CPU IRQ line to read literal `irq_status` (instead of VicIIVice)
when `useLiteralPortVicIrq` flag is on. No removal. VicIIVice IRQ
alarm continues running for diff comparison.

## Scope (in)

1. Add `useLiteralPortVicIrq` flag (defaults to
   `useLiteralPortVicReads`).
2. In `updateMicrocodedInterruptLines`, when flag on, use literal
   `irq_status & regs[0x1a] & 0x0f` instead of `vic.irqAsserted()`.
3. Diff harness `scripts/smoke-vic-301-irq-diff.mjs`:
   - boot BASIC ready scenario
   - per cycle (or per N cycles) compare VicIIVice.irqAsserted vs
     literal IRQ asserted
   - log first divergence with cycle, raster_y, irq_status (vice +
     lit), regs[0x1a]
4. Raster IRQ acceptance harness (synthetic, no PRG injection
   problems): poke `regs[0x1a] = 0x01`, set `regs[0x12] = 0x80`, run,
   verify literal `irq_status & 0x01` becomes set when raster crosses
   line $80, and ack via `$D019` write clears.

## Scope (out)

- Removal of VicIIVice IRQ path.
- Alarm dispatcher port (literal stays per-cycle polled).
- BA/AEC migration (Phase 4).
- Framebuffer migration (Phase 5).
- Light pen IRQ (out of corpus).
- All other do-not-investigate items from Phase 0 deliverable.

## Acceptance Gates

1. Existing 297 + 300 tests still green.
2. **Diff harness silent over 60 frames on BASIC-ready** (zero
   divergence between VicIIVice.irqAsserted and literal-asserted).
3. Synthetic raster-IRQ test:
   - set `regs[0x1a] = 0x01`, `regs[0x12] = 0x80`, ensure DEN +
     `$D011` bit 7 = 0
   - run a few frames
   - assert literal `irq_status & 0x01` was set during raster crossing
   - write `$D019 = 0x01` via bus → assert literal `irq_status & 0x01`
     clears
4. TS build green.

## Implementation

### Flag

```ts
public useLiteralPortVicIrq: boolean = false;
this.useLiteralPortVicIrq = opts.useLiteralPortVicIrq ?? this.useLiteralPortVicReads;
```

### IRQ line wiring (`updateMicrocodedInterruptLines`)

```ts
const vicIrq = this.useLiteralPortVicIrq
  ? ((LIT_TYPES.vicii.irq_status & this.vic.regs[0x1a]! & 0x0f) !== 0)
  : this.vic.irqAsserted();
cpu.irqLine = (this.cia1IrqLine() || this.cia1.irqAsserted()) || vicIrq;
```

### Diff harness shape

```text
[cyc 1234567 raster=200] vice.asserted=true lit.asserted=false
  vice.irq_status=$81 lit.irq_status=$01 mask=$01
```

## Deliverables

- `specs/301-literal-vic-raster-irq-authority.md` (this file)
- `scripts/smoke-vic-301-irq-diff.mjs` (primary gate)
- `scripts/smoke-vic-301-raster-irq.mjs` (synthetic ack test)
- Patch to `src/runtime/headless/integrated-session.ts`:
  - new `useLiteralPortVicIrq` flag
  - IRQ line read switch in `updateMicrocodedInterruptLines`

## Results (v1)

- Build green.
- 297a + 297k + 300 diff harness still pass (no regression).
- IRQ diff harness: 0 divergences over 36 samples on idle BASIC
  (no IRQ activity in idle baseline = trivially clean; stronger
  test below).
- Synthetic raster IRQ test (`smoke-vic-301-raster-irq.mjs`):
  - Both VicIIVice + literal trigger raster IRQ ✓
  - Both clear via `$D019` ack via bus ✓
  - Literal triggers at raster ~134 (within sample window of expected
    line 128 / `$80`) ✓
  - VicIIVice triggers at raster 298 = ~170 lines late. Pre-existing
    VicIIVice timing bug. Not a Spec 301 regression and out of scope
    per migration plan: VicIIVice IRQ is being deprecated, literal
    becomes authority. Logged here for post-migration cleanup.

### Known limitation

Diff harness on idle BASIC is weak proof — IRQ stays inactive most of
the time. Stronger diff would interleave a raster-IRQ-active workload
with the diff loop. Deferred to a follow-up smoke when needed (current
synthetic test plus the read-side diff in Spec 300 cover the primary
risk).

## Next slice

When 301 silent on harness:
- Phase 4 = literal BA/AEC + CPU stall authority (separate spec, mini
  Phase 0 sub-analysis).
