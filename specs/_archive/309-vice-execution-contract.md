# Spec 309 — VICE x64sc Execution Contract Port

Status: open
Date: 2026-05-10
Authority: `docs/adr-vice-execution-contract.md`
Source analysis: `docs/vice-execution-contract-analysis-2026-05-10.md`
VICE binary in scope: `x64sc` (cycle-exact). Plain `x64` ignored.

## Stance

Direct port of the VICE x64sc execution contract. No legacy
preservation. No flag-gated dual paths. No "Issue 3 swap" or other
historical hand-tuning kept "just in case". The new code IS the
contract; everything inconsistent with it goes.

This spec rewrites seven layers of the headless C64 + 1541 stack to
match x64sc exactly:

1. New `InterruptCpuStatus` state object (= VICE's `interrupt_cpu_status_t`),
   reusable for main CPU and drive CPU.
2. CPU boundary sample logic on the microcoded 6510 (main + drive).
3. Alarm scheduler — iterative same-clk drain. Two contexts per
   machine: `maincpuAlarmContext` + `drivecpuAlarmContext` (per drive).
4. CIA1 / CIA2 IRQ/NMI assert wiring (chip → main `InterruptCpuStatus`).
5. VIC-II literal port raster IRQ assert wiring (chip → main `InterruptCpuStatus`).
6. `IntegratedSession` per-cycle + per-opcode-boundary order for main CPU.
7. Drive 1541 6502 + VIA1/VIA2 ported to the same contract with
   `drivecpu`-prefixed state, executed under its own alarm context
   from the drive-side accumulator.

Everything below has VICE source `file:line` refs in the analysis doc.

## Working instruction (per ADR)

> I am porting the VICE x64sc execution path, not inventing a TypeScript
> scheduler. The VICE call order I am matching is `c64cpusc.c:47-51`
> CLK_INC + `6510dtvcore.c:1734-1812` per-opcode body. The first parity
> trace I will produce is a minimal D012 raster IRQ PRG diffed event-by-
> event against `x64sc` monitor output.

## Non-negotiable contract (= acceptance authority)

### Per CPU cycle (`CLK_INC()` equivalent)

```
interruptDelay()              // drain alarms; bump irq_delay_cycles / nmi_delay_cycles
maincpu_clk += 1
ba_low &= ~VICII; ba_low |= vicii_cycle()
```

`interruptDelay()` = `mainc64cpu.c:97-110`:

- iterative `while (clk >= alarmContext.nextPendingClk()) alarmContext.dispatchOne(clk)`
- if `irq_clk <= clk` then `irq_delay_cycles++`
- if `nmi_clk <= clk` then `nmi_delay_cycles++`

VIC ticks AFTER clk++. Reads just-bumped clk as assert clock.

### Per opcode boundary (= top of `6510dtvcore.c:1714` body)

```
while (clk >= alarmContext.nextPendingClk()) alarmContext.dispatchOne(clk)   // pre-sample drain
[JAM cleanup if jammed]
pending = cpuIntStatus.global_pending_int
if (pending != IK_NONE) {
  doInterrupt(pending)         // 7 cycles of CLK_INC inside; drain again post-DO_INTERRUPT
}
fetchOpcode()                  // 2-3 CLK_INC inside
executeOpcodeBody()            // CLK_INC per addressing/IO step
```

Sample = read `global_pending_int`. Take iff per-line delay counter
condition holds (= `cs.irq_delay_cycles >= INTERRUPT_DELAY [+1 branch]
[+1 CLI/PLP/RTI]`).

### Sample condition

```
takeIrq iff:
  global_pending_int & IK_IRQ
  AND ( !LOCAL_INTERRUPT() OR OPINFO_DISABLES_IRQ(LAST_OPCODE_INFO) )
  AND irq_delay_cycles >= INTERRUPT_DELAY (+ branch_delay) (+ cli_just_enabled_delay)

takeNmi iff:
  global_pending_int & IK_NMI
  AND last_opcode != BRK
  AND nmi_delay_cycles >= INTERRUPT_DELAY (+ branch_delay)
```

`INTERRUPT_DELAY = 2`. NMI is sticky — only `interrupt_ack_nmi`
clears `IK_NMI`.

## Scope (in)

### Phase A — InterruptCpuStatus (new state, no behaviour change yet)

Build `src/runtime/headless/cpu/interrupt-cpu-status.ts`:

```ts
export class InterruptCpuStatus {
  irqClk = CLOCK_MAX;
  nmiClk = CLOCK_MAX;
  irqPendingClk = CLOCK_MAX;
  nirq = 0;
  nnmi = 0;
  irqDelayCycles = 0;
  nmiDelayCycles = 0;
  globalPendingInt: PendingMask = IK_NONE;
  pendingInt: Map<IntNum, PendingMask> = new Map();
  lastOpcodeInfo = 0;
  lastStolenCyclesClk = 0;

  setIrq(intNum: IntNum, value: boolean, clk: CLOCK): void;
  setNmi(intNum: IntNum, value: boolean, clk: CLOCK): void;
  ackIrq(): void;
  ackNmi(): void;
  checkIrqDelay(): boolean;   // sample-condition for IRQ
  checkNmiDelay(): boolean;   // sample-condition for NMI
  bumpDelays(clk: CLOCK): void;  // called from interruptDelay()
}

export const INTERRUPT_DELAY = 2;
export const IK_NONE = 0, IK_IRQ = 1, IK_IRQPEND = 2, IK_NMI = 4, IK_RESET = 8;

export interface IntNum { readonly id: number; readonly name: string; }
export function newIntNum(name: string): IntNum;
```

Match `interrupt.h:141-180` (set_irq), `interrupt.h:199-250` (set_nmi),
`interrupt.h:273-282` (ack_nmi), `mainc64cpu.c:690-710`
(check_irq_delay), `mainc64cpu.c:663-685` (check_nmi_delay) line-by-
line. JS-ism only for bitwise + `Map<IntNum, mask>` instead of array
indexed by id.

### Phase B — Alarm context (rewrite scheduler)

Replace `cycle-lockstep-scheduler.ts` + `event-catchup-strategy.ts`
event-catchup model with a literal `AlarmContext` matching
`alarm.c` + `alarm.h`:

```ts
export class AlarmContext {
  pendingAlarms: AlarmEntry[] = [];   // dense array, idx is stable per alarm
  nextPendingClk = CLOCK_MAX;
  nextPendingIdx = -1;

  newAlarm(name: string, callback: AlarmCallback): Alarm;   // alarm_new
  set(alarm: Alarm, clk: CLOCK): void;                       // alarm_set
  unset(alarm: Alarm): void;                                  // alarm_unset
  nextPending(): CLOCK;                                       // next_pending_alarm_clk
  dispatchOne(clk: CLOCK): void;                              // alarm_context_dispatch
}
```

Selection rule = `<=` (not `<`) — same-clk last-set wins
(`alarm.h:110-129`). `dispatchOne` fires exactly ONE callback;
caller wraps in `while (clk >= ctx.nextPending()) ctx.dispatchOne(clk)`.

Single `maincpuAlarmContext` per machine. CIA1 + CIA2 + keyboard +
kbdbuf + glue + joystick + sid-pot + event ALL register against the
SAME context. No per-chip private tick lists. No bulk snapshot drain.

Drive 1541 keeps its own `drivecpuAlarmContext` (out of scope here —
matches `drivecpu_alarm_context` in VICE).

### Phase C — CPU boundary sample

Rewrite microcoded CPU step in `src/runtime/headless/cpu6510.ts` (or
the active microcoded variant):

- Drop boolean `irqLine` / `nmiLine` mirror fields entirely.
- Drop `updateMicrocodedInterruptLines` call site (delete the method).
- At opcode boundary: read `cpuIntStatus.globalPendingInt`. If
  non-zero, call `doInterrupt(pending)`.
- `doInterrupt` matches `6510dtvcore.c:354-407` DO_INTERRUPT macro:
  - NMI branch first (= NMI hijack precedence over IRQ).
  - 2× LOAD_DUMMY + push PCH + push PCL + push P + 2× LOAD vector
    bytes + JUMP. Each step is one cycle (= calls back into
    `clkInc()` once per).
  - `interruptAckIrq()` / `interruptAckNmi()` after sample.
- Track `lastOpcodeInfo` per executed opcode so `OPINFO_DELAYS_INTERRUPT`
  + `OPINFO_ENABLES_IRQ` + `OPINFO_DISABLES_IRQ` flags work.
- `OPINFO_*` table: build from `6510dtvcore.c` opcode dispatch flags
  (= mark CLI/PLP/RTI as ENABLES_IRQ, branch-taken-no-page-cross as
  DELAYS_INTERRUPT, BRK as the NMI-hijack opcode).

### Phase D — CIA1 / CIA2 wiring

`src/runtime/headless/cia/cia6526-vice.ts` (or active variant):

- Replace whatever existing `setIrqLine(boolean)` callback with
  per-slot routing identical to `c64cia1.c:95-98` and
  `c64cia2.c:86-89`:

  ```ts
  // CIA1 wrapper
  cia1.ciaSetIntClk = (ctx, value, clk) =>
    cpuIntStatus.setIrq(ctx.intNum, value, clk);
  // CIA2 wrapper
  cia2.ciaSetIntClk = (ctx, value, clk) =>
    cpuIntStatus.setNmi(ctx.intNum, value, clk);
  ```

- Remove any "polling" of CIA ICR.7 from CPU side. CIA pushes the
  edge via `setIrq` / `setNmi` and writes its own `irq_clk` / `nmi_clk`.
- CIA `intNum` allocated once at init via `cpuIntStatus.newIntNum("CIA1")`
  / `"CIA2"`.
- Each CIA registers its 5 alarms (TA, TB, TOD, SDR, IDLE) against
  `maincpuAlarmContext` matching `core/ciacore.c:2079-2103`. Alarm
  callbacks call `myset_int(value, rclk)` matching
  `core/ciacore.c:167-179`. `rclk = *clk_ptr - offset`.

### Phase E — VIC literal port wiring

`src/runtime/headless/vic/literal/vicii-cycle.ts` +
`vicii-irq.ts`:

- VIC has NO alarm. Confirmed by `viciisc/vicii.c:249-261` +
  `viciisc/vicii-irq.c:123-126`. Delete any old "vic raster alarm"
  plumbing from headless if present.
- `vicii_cycle()` raster compare check matches
  `viciisc/vicii-cycle.c:467-474` exactly. Edge-triggered:
  `raster_irq_triggered` flag prevents repeat assert on same line.
- On match, call `vicii_irq_raster_trigger()` →
  `vicii_irq_raster_set(maincpu_clk)` → `vicii_irq_set_line_clk`,
  matching `viciisc/vicii-irq.c:47-62 + 116-121`.
- `vicii.intNum` allocated once at init via `cpuIntStatus.newIntNum("VICII")`.
- `maincpu_set_irq_clk` shorthand calls
  `cpuIntStatus.setIrq(vicii.intNum, value, clk)` directly.

### Phase F — IntegratedSession orchestration

Rewrite `stepMicrocodedC64Instruction`:

```ts
do {
  // boundary drain — matches 6510dtvcore.c:1734
  while (clk >= alarmCtx.nextPending()) alarmCtx.dispatchOne(clk);

  // sample pending — matches 6510dtvcore.c:1758
  const pending = cpuIntStatus.globalPendingInt;
  if (pending !== IK_NONE) {
    doInterrupt(pending);   // each push/load step calls clkInc()
    while (clk >= alarmCtx.nextPending()) alarmCtx.dispatchOne(clk);
  }

  // fetch + execute opcode — each addressing/IO step calls clkInc()
  fetchOpcode();
  executeOpcodeBody();
} while (...);
```

Replace `tickLitVic` + per-cycle "refresh interrupts" + cpu.executeCycle
triad with single `clkInc()`:

```ts
function clkInc(): void {
  // matches c64cpusc.c:47-51 CLK_INC()
  interruptDelay();           // drain + bump delay counters
  maincpu_clk += 1;
  baLowFlags &= ~BA_LOW_VICII;
  baLowFlags |= viciiCycle();   // VIC ticks for new clk; may setIrq
}

function interruptDelay(): void {
  // matches mainc64cpu.c:97-110
  while (maincpu_clk >= alarmCtx.nextPending()) {
    alarmCtx.dispatchOne(maincpu_clk);
  }
  if (cpuIntStatus.irqClk <= maincpu_clk) cpuIntStatus.irqDelayCycles++;
  if (cpuIntStatus.nmiClk <= maincpu_clk) cpuIntStatus.nmiDelayCycles++;
}
```

Drive 1541 catch-up: drive runs its own `clkInc` loop with
`drivecpuAlarmContext` + `driveCpuIntStatus` (= Phase H). C64-side
`clkInc` advances `maincpu_clk`; drive catches up to `maincpu_clk`
boundary at end of each C64 instruction (= today's two-clock
accumulator pattern, but the inner per-cycle drive step is rewritten).

### Phase H — Drive 1541 execution contract port

VICE drive sources to mirror:

- `drive/drivecpu.c` — drive CPU mainloop (drive equivalent of `maincpu.c`)
- `drive/drivecpu65c02.c` (for 1571/1581) and `drive/drivecpu.c`
  (for 1541) — pick `drivecpu.c` for 1541 scope
- `drive/drivecpu.c` defines `drivecpu_alarm_context` per drive
  (`drive[i]->cpu->alarm_context`)
- `drive/iec/c64exp/c64exp-cmdline-options.c` etc. — out of scope
- `core/viacore.c` + `drive/iec/via1d1541.c` + `drive/iec/via2d.c` —
  VIA1/VIA2 alarm registration + IRQ assert via
  `viacore_set_int(via_context, value)` → drive CPU int status

Phase H rewrites:

- `src/runtime/headless/drive/drive-cpu.ts` — adopt same `clkInc()`
  pattern: `interruptDelay(); driveCpuClk++; ...` (drive has no VIC,
  so step 4 of CLK_INC is just any per-cycle drive-side hooks).
- `src/runtime/headless/drive/drive-via.ts` (= `via6522Vice`) — replace
  any boolean `driveIrqLine` mirror with direct
  `driveCpuIntStatus.setIrq(via.intNum, value, driveCpuClk)` call
  inside `viacore_set_int` equivalent.
- New `driveCpuIntStatus: InterruptCpuStatus` field per drive
  (re-using the Phase A class).
- New `drivecpuAlarmContext: AlarmContext` field per drive (re-using
  the Phase B class).
- VIA1 + VIA2 register their alarms (T1, T2, etc.) against the
  per-drive `drivecpuAlarmContext`. ZERO drive-side state crosses into
  `maincpuAlarmContext`.
- Drive boundary sample logic = same as Phase C, applied to drive 6502.
  IEC bus state changes are observed via memory reads (= already wired
  through `iec-bus.ts`); they do NOT travel through alarm/IRQ.
- Drive accumulator (`integrated-session.ts` + `headless-machine-kernel.ts`):
  C64 calls `clkInc()` per cycle → main_clk++; after C64 opcode
  boundary, drive runs its own `clkInc()` loop until
  `driveCpuClk * mainHz == mainCpuClk * driveHz` (= today's dual-clock
  catch-up math, unchanged ratio + rounding).

Phase H deletion list (additional to main C64 list):

- drive `EventCatchupStrategy` bulk-snapshot drain (= same shape as
  C64 side, replaced)
- drive boolean `irqLine` field on drive CPU (= replaced by
  `driveCpuIntStatus.globalPendingInt`)
- any "drive raster alarm" or "drive VIC alarm" plumbing (1541 has no
  VIC; if such code exists it is dead)
- `headless-kernel-bus` shim that mirrors drive IRQ as a boolean (=
  replaced by `driveCpuIntStatus`)

Phase H acceptance trace:

- minimal drive-side parity test: VIA1 timer T1 underflow on the
  drive CPU triggers IRQ at the same drive_clk in VICE drive monitor
  trace and headless trace.
- ratio between drive_clk and maincpu_clk identical to VICE
  (`drivecpu_execute_clk` math).

### Phase G — Trace harness + parity proof

`src/runtime/headless/trace/execution-contract-trace.ts` — new trace
channel emitting per master cycle:

```
clk=<n> pc=<hex> boundary=<bool> raster_line=<n> raster_cycle=<n>
  d019=<hex> d01a=<hex>
  cia1_irq=<bool> cia2_nmi=<bool>
  irq_clk=<n> nmi_clk=<n> irq_delay=<n> nmi_delay=<n>
  global_pending=<hex>
  handler_pc=<hex|->
```

`samples/asm/d012-min-split.asm` + assemble to
`samples/prgs/d012-min-split.prg` — minimal raster IRQ PRG (= setup
$D012/$D01A, CLI, infinite NOP, simple IRQ handler that toggles border
+ ack).

VICE-side capture: `scripts/vice-trace-d012.sh` — invoke `x64sc`
with `-monlog`, monitor breakpoints at the same six events (raster
match, irq_clk write, sample, IRQ ack, handler entry). Convert
monitor log → same format as headless trace.

`scripts/smoke-vic-309-d012-irq-parity.mjs` — diff event lists.
Allowed tolerance: ZERO unless documented VICE source reason.

## Scope (out)

Per ADR Non-Goals, MUST NOT touch in this spec:

- pixel pipeline / sprite / border / palette
- framebuffer capture (= already eliminated)
- VicIIVice dual-truth (= obsolete)
- 1541 drive 1571/1581 variants (= different CPU model — Phase H
  covers 1541 only)
- Rust port
- UI changes
- new renderers
- game-specific workarounds
- performance work
- VSF / snapshot save/load (= follow-up after contract is stable)

## Deletion list (= legacy code to REMOVE, not gate)

All of the following must be deleted in the merge that lands Phase F:

- `IntegratedSession.updateMicrocodedInterruptLines` method + every
  call site
- `Cpu6510.irqLine` / `Cpu6510.nmiLine` boolean fields (replaced by
  `cpuIntStatus.globalPendingInt`)
- per-cycle "refresh interrupts then tick VIC then step CPU" triad
  in `stepMicrocodedC64Instruction`
- `EventCatchupStrategy` bulk-snapshot drain (replaced by
  `alarmCtx.dispatchOne` loop)
- any `vicRasterAlarm` plumbing on the C64 side (drive raster keeps
  its own — not on C64)
- `tickLitVic` direct invocation from `stepMicrocodedC64Instruction`
  outside of `clkInc()`
- `VicIIVice.tick()` calls from C64-side hot path (kept in legacy
  block-mode path for non-microcoded fallback ONLY if that path is
  still needed; otherwise delete it too)
- "Spec V-V2-fix Issue 3" tick-order swap comments + heuristics
  (replaced by VICE-correct order whether they happen to coincide
  or not)

If any of these names survive in the diff that lands Phase F, the
merge is rejected.

## Acceptance gates

Per ADR Acceptance Standard:

1. Phase A-F merged. `IntegratedSession` per-cycle code reads as a
   line-for-line port of `c64cpusc.c:47-51` + `mainc64cpu.c:97-110` +
   `6510dtvcore.c:1714-1812`.
2. Deletion list above ALL gone. Grep for each deleted symbol returns
   zero hits.
3. Phase G trace harness produces side-by-side event log (VICE +
   Headless).
4. D012 raster IRQ parity:
   - same `clk` when `vicii.irq_status` raster bit (0x01) sets
   - same `clk` when `cpuIntStatus.irqClk` updates
   - same `clk` when `cpuIntStatus.globalPendingInt |= IK_IRQ`
   - same opcode boundary `clk` decides "take"
   - same handler-PC entry `clk` (= boundary + 7)
5. Existing 297 + 300 + 301 + 302 + 303 smokes still green AS A SIDE
   EFFECT of correct behaviour (= NOT by patching them to accept the
   new output).
6. motm + Scramble do NOT crash. Rendering quality is NOT an
   acceptance gate of this spec — that is downstream.
7. No screenshot-based "looks better" claims accepted as proof.

## Forbidden

- Pixel-side fixes proposed as evidence the contract is right.
- "It works in motm" / "Scramble title renders" as acceptance.
- Hand-tuning cycle counts to make a screenshot match.
- Stripping VICE-equivalent code paths "because they look unused".
- Keeping legacy paths behind feature flags.
- Rescuing the existing scheduler / interrupt mirror "for compatibility".

## Deliverables

- `docs/vice-execution-contract-analysis-2026-05-10.md` (= already
  landed, Phase 0 source map; revised by user 2026-05-10 to
  counter-driven model)
- `src/runtime/headless/cpu/interrupt-cpu-status.ts` (new)
- `src/runtime/headless/cpu/opinfo.ts` (new — opcode info flags table)
- `src/runtime/headless/scheduler/alarm-context.ts` (rewrite)
- `src/runtime/headless/scheduler/alarm.ts` (new — Alarm + AlarmEntry)
- Patches:
  - `src/runtime/headless/cpu6510.ts` (drop irqLine/nmiLine, add
    boundary sample, add doInterrupt)
  - `src/runtime/headless/cia/cia6526-vice.ts` (per-slot routing,
    register 5 alarms each)
  - `src/runtime/headless/vic/literal/vicii-cycle.ts` + `vicii-irq.ts`
    (direct setIrq from raster compare)
  - `src/runtime/headless/integrated-session.ts` (rewrite per-cycle +
    per-opcode-boundary order)
- Deletions per "Deletion list" above
- `src/runtime/headless/trace/execution-contract-trace.ts` (new)
- `samples/asm/d012-min-split.asm` + `samples/prgs/d012-min-split.prg`
- `scripts/vice-trace-d012.sh` (VICE monitor capture)
- `scripts/smoke-vic-309-d012-irq-parity.mjs` (parity diff)

## Phase order + sub-tasks

| Phase | Subject | Depends on |
| --- | --- | --- |
| A | InterruptCpuStatus state object | — |
| B | AlarmContext + iterative dispatch | — |
| C | CPU boundary sample + doInterrupt | A |
| D | CIA1/CIA2 setIrq/setNmi wiring + 5-alarm registration | A, B |
| E | VIC raster IRQ direct setIrq from vicii_cycle | A |
| F | IntegratedSession clkInc + boundary-drain rewrite (main CPU) | A, B, C, D, E |
| H | Drive 1541 6502 + VIA1/VIA2 ported to same contract | A, B, C |
| G | Trace harness + D012 parity proof + drive VIA T1 parity | F, H |

A + B parallelizable. C + D + E parallelizable after A+B. F is the
single integration point. G is the proof.

## Notes

This spec REPLACES the informal "Spec 309 vaddr_mask" label used in
conversation memory (= that fix has no spec file and is a Spec 304-
family follow-up).

Spec 305-308 follow-ups (= sprites, borders, palette) remain blocked
behind this spec per ADR Non-Goals.

After Spec 309 acceptance, all prior `VicIIVice` per-cycle mirror code
paths are formally dead. A follow-up cleanup spec may delete the file.
