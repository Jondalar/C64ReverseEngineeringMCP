# Spec 141 — Clocked VIA1 CA1 / IRQ Timing

**Sprint**: 112 (core sync refactor)
**Phase**: implementation
**Status**: proposed
**Depends on**: Spec 139 (kernel), Spec 140 (IEC core)
**Sequenced after**: 140
**Sequenced before**: 144

## Why

ATN edge handling currently sets VIA IFR immediately and is paired
with a drive-RAM `$7C` rescue path. VICE timestamps CA1 events with
`rclk` and applies a deterministic 2-cycle interrupt-delay model.

Sprint 111 evidence + arc42 ADR-3 show our IRQ entry timing depends
on scheduler order and current instruction phase — non-deterministic
0..6 drive cycles after IFR set. This is the load-bearing reason
the `$7C` poke exists: when the IRQ is "missed" by the timing race,
the poke compensates by setting the ATN-pending byte directly. The
compensation works for the boot path but fails for fastloader timing
where the drive expects a precise IRQ entry moment.

Spec 141 makes IRQ timing deterministic and clocked, then removes
the compensating hack.

## Scope

**In scope**:

- Timestamped CA1/CB1/CA2/CB2 edge events. Event carries:
  `{ source: VIA, line: CA1|CB1|...; edge: "rise"|"fall"; clock }`.
- Timestamped VIA timer T1/T2 underflow events.
- Deterministic IRQ-visible and IRQ-service timing:
  - When IFR&IER becomes non-zero, record `irq_clk = current_clock`.
  - Drive CPU samples IRQ pin at instruction boundary AND
    `cpu_clock >= irq_clk + INTERRUPT_DELAY` (constant = 2 cycles
    matching VICE).
- Trace channel (Spec 142 extension): bus_access events on $1800
  read/write include VIA `irq_clk` and `last_ifr_set_clock` for
  correlation with diff (Spec 143).
- Removal of `IecBus.attachDriveRam` + `$7C` poke pathway in
  TrueDrive mode (mode-guarded; falls back to enabled in
  trap/debug mode).
- Removal of `Via6522.reevaluateCa1Level` Sprint 66 hack in
  TrueDrive mode (same gating).
- Boot order shim (optional): kernel can run drive ROM for N cycles
  before c64 reset — replicates real-HW behavior where drive boots
  faster than c64 KERNAL.

**Out of scope**:

- Full VIA shift-register fidelity (separate spec)
- Unrelated VIA2 GCR changes
- Trap-mode behavior changes

## Implementation plan

### Step 1: Event-stamped IFR set

```ts
// via6522.ts
export interface IrqStamp {
  setClock: number;
  source: "CA1" | "CA2" | "CB1" | "CB2" | "T1" | "T2" | "SR";
  edge?: "rise" | "fall";
}

private lastIrqStamp: IrqStamp | null = null;

setIfr(mask: number, source?: IrqSource, currentClock?: number): void {
  this.ifr |= (mask & 0x7f);
  if (source && currentClock !== undefined) {
    this.lastIrqStamp = { setClock: currentClock, source };
  }
}
```

### Step 2: Clocked IRQ pin sample

`Via6522.irqAsserted(currentDriveClock)` returns true only if:
- `(ifr & ier & 0x7f) !== 0`
- AND `currentDriveClock >= lastIrqStamp.setClock + INTERRUPT_DELAY`

`INTERRUPT_DELAY = 2` (matches VICE).

### Step 3: Drive CPU IRQ entry

`DriveCpu.runOneInstruction()` samples `via1.irqAsserted(driveClock)`
at instruction boundary. If asserted, vector to $FFFE.

Microcoded CPU: same logic, but the pin is sampled at the start of
the next instruction's first fetch cycle (T0).

### Step 4: ATN edge propagation through kernel

```
kernel.onC64BusWrite($DD00, value, ctx)
  → flushDriveTo(c64Clock)
  → iec.iecUpdateCpuBus(value, ddr)
  → if (atn-bit-changed):
      kernel.scheduleAtnEdge({
        target: driveVia1,
        line: "CA1",
        edge: atn_low ? "fall" : "rise",
        clock: c64Clock_in_drive_cycles
      })
  → recompute drv_bus[8] + iecUpdatePorts
```

`scheduleAtnEdge` calls `via.setIfrFromEdge(line, edge, clock)`
which checks PCR polarity match before setting IFR with stamp.

### Step 5: Remove `$7C` poke (TrueDrive mode)

Mode flag: `kernel.config.compatibilityHacks = "vice-pure" | "rescue-on"`.
- `"vice-pure"` (default for TrueDrive): no $7C poke, no
  `reevaluateCa1Level`, no synthetic line releases.
- `"rescue-on"`: legacy behavior preserved.

### Step 6: Tests

- IRQ-latency unit test: c64 stores $DD00 with ATN low at c64 cycle
  N. Drive's IRQ entry must occur at drive cycle (N * ratio) + 2,
  exactly. Both lockstep and push-flush kernel modes.
- IFR set without IER enabled: IFR remains set; CPU does NOT vector.
  Then drive enables IER → CPU vectors at next boundary + 2 cycles.
- ATN edge during drive instruction execution: drive completes
  current instruction, then enters IRQ.
- KERNAL LOAD regression in `vice-pure` mode: must remain green.
- motm in `vice-pure` mode: drive IRQ entry timing matches VICE
  trace within 0 cycles tolerance for the receive-window events.

## Acceptance

- [ ] `IrqStamp` field present on Via6522.
- [ ] `Via6522.irqAsserted` accepts current clock and applies
      INTERRUPT_DELAY.
- [ ] Kernel routes ATN edges through scheduled events.
- [ ] `vice-pure` mode default in TrueDrive, removes `$7C` poke and
      `reevaluateCa1Level`.
- [ ] Spec 143 diff report on motm shows IRQ entry cycle matches
      VICE within 0 cycles for first 3 cmd bytes.
- [ ] KERNAL LOAD regression green in both `vice-pure` and
      `rescue-on` modes.
- [ ] Existing IEC tests green.

## Estimated effort

3-4 days:
- 0.5d: IrqStamp + setIfr update
- 0.5d: clocked irqAsserted
- 0.5d: kernel ATN-edge scheduling
- 0.5d: mode flag + remove hacks (gated)
- 1.0-2.0d: tests, trace correlation, regression

## Risks

- **R1**: Real 1541 6502 IRQ delay may not be exactly 2 cycles. VICE
  uses `INTERRUPT_DELAY = 2` as a default that matches MOS 6510
  behavior. Drive uses MOS 6502 (slightly different IRQ latency
  model). Mitigation: make constant configurable; validate via
  diff with VICE.
- **R2**: Removing `$7C` poke may break MM boot if KERNAL LOAD
  relies on it inadvertently. Mitigation: regression run in
  `vice-pure` mode; if breaks, document missed-edge cause and fix
  via boot-order shim or kernel ATN-edge scheduling refinement.
- **R3**: Boot-order shim could mask real bugs. Mitigation: only
  enabled when explicitly requested; default = simultaneous reset.

## Files

To modify:
- `src/runtime/headless/drive/via6522.ts` (IrqStamp, clocked irqAsserted)
- `src/runtime/headless/iec/iec-bus.ts` (route ATN edge through kernel,
  remove direct pulseCa1 in vice-pure mode)
- `src/runtime/headless/integrated-session.ts` (mode flag wiring)
- `src/runtime/headless/scheduler/machine-kernel.ts` (ATN edge scheduling)
- `src/runtime/headless/drive/drive-cpu.ts` (pass driveClock to
  irqAsserted)
- `src/runtime/headless/cpu/cpu6510-cycled.ts` (microcoded IRQ
  sampling)

To delete (in vice-pure mode only — keep code path for rescue mode):
- The `attachDriveRam` $7C poke trigger in `IecBus.notifyAtnChanged`.
- `Via6522.reevaluateCa1Level` retroactive trigger.
