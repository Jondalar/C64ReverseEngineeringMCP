# 1541 Silicon-Equivalent Plan (Pre-V2)

VICE source studiert. Bus-Modell strukturell korrekt. Divergence in
timing-precision, nicht im logical model.

## VICE architecture confirmed

**File**: `src/iecbus/iecbus.c`, `src/drive/iec/via1d1541.c`

### Lazy lockstep (already in our Spec 090)
Every C64 access to $DD00 calls `drive_cpu_execute_one(unit, clock)`
BEFORE updating bus state. Drive runs forward to current C64 cycle,
THEN bus state updates, drive sees new state on next instructions.
We do this via `iecBus.beforeC64Read`. ✓ Same.

### Bus state formula (drive output side)

VICE `via1d1541_store_prb` — line 211-248:
```c
*drive_data = ~byte;          // open-collector inverter
*drive_bus = (((*drive_data) << 3) & 0x40)              // CLK out → bit 6
           | (((*drive_data) << 6)
              & ((~(*drive_data) ^ iecbus->cpu_bus) << 3) & 0x80);
                              // ATN-AND auto-pull DATA when ATN low + drive not ack-ed

iecbus->cpu_port = iecbus->cpu_bus;
for (unit = 4..) iecbus->cpu_port &= iecbus->drv_bus[unit];  // wired-AND

iecbus->drv_port = (((cpu_port >> 4) & 0x4)              // CLK_IN → drv bit 2
                  | (cpu_port >> 7)                       // DATA_IN → drv bit 0
                  | ((cpu_bus << 3) & 0x80));             // ATN_IN → drv bit 7
```

Drive read PRB: `((via_PRB & 0x1a) | drv_port) ^ 0x85`
- XOR 0x85 inverts bits 0/2/7 (active-low signals)
- Mask 0x1a preserves PB1 (DATA_OUT), PB3 (CLK_OUT), PB4 (ATNA)

### Our equivalent in `iec-bus.ts`

```ts
get dataLine(): boolean {
  const atnAckAutoPullActive = !this.atnLine && !this.driveAtnAckReleased;
  if (atnAckAutoPullActive) return false;
  return this.c64DataReleased && this.driveDataReleased;
}
```

Semantically same — ATN-AND gate when ATN asserted + drive not ack.
Wired-AND on releases. ✓

### Bit layout

Drive VIA1 PB:
| bit | signal     | direction |
|-----|------------|-----------|
| 0   | DATA_IN    | input (active low) |
| 1   | DATA_OUT   | output |
| 2   | CLK_IN     | input |
| 3   | CLK_OUT    | output |
| 4   | ATNA       | output (ATN-acknowledge) |
| 5   | DEV_ID 0   | input (jumper) |
| 6   | DEV_ID 1   | input (jumper) |
| 7   | ATN_IN     | input |

Match. ✓

## Suspected divergence sources

Can't be in bus logic — that matches. Must be timing:

### 1. VIA CA1 edge propagation
- VICE: `viacore_signal(VIA_SIG_CA1, VIA_SIG_RISE)` queues edge into VIA's alarm-context
- Ours: `via.pulseCa1(level)` fires immediately
- **Hypothesis**: real silicon has 1-cycle delay between bus edge and CA1 IFR set; we're 1 cycle early → drive ATN handler enters sooner than fastloader expects

### 2. VIA timer per-cycle vs batched
- VICE: timers count down in alarm-context callbacks per CPU cycle
- Ours: `tick(N)` batched after instruction completes
- **Hypothesis**: timer underflow timing within a multi-cycle instruction differs → IRQ fires at wrong point in instruction sequence

### 3. Drive cycle drift (2 residual cycles per Spec 109)
- IRQ-service entry path differs by 2 cycles between legacy/microcoded
- Likely cycle-counting wrapper bug, not opcode bug
- **Hypothesis**: small but accumulates over thousands of fastloader iterations

### 4. ATN-AND gate evaluation timing
- VICE: evaluate on event (drive PB write, C64 PA write, edge transitions)
- Ours: lazy-evaluate on `dataLine` getter call
- **Hypothesis**: lazy eval semantically equivalent BUT if observation order differs (drive sees gate result vs C64 sees it) we might short-cycle a settling delay

## Concrete next-step plan (V2 session)

### Sprint 111 — Oracle infrastructure (3-5 days)

**S1. Extend Spec 095 swimlane to drive-side per-cycle**

Existing `trace-eof-vice.mjs` captures C64-side coarse trace post-EOI.
Extend: capture every drive cycle's `{ pc, regs, viaA_PB, viaA_CB, iec_lines }`
during a fastloader window (e.g. 50 ms of motm hang).

VICE binmon command: `r drive 8` reads drive registers. `m drive 8 ...` reads drive memory. Set drive checkpoint at every cycle via `dbreak --action stop drive 8 0..ffff` won't scale; better: drive_cpu hook in VICE that emits per-cycle event.

Alternative: use VICE's **chips log**:
```
log enable 1
chips log on
g
```

Captures full CPU+IO trace. Parse offline.

**S2. Mirror trace from headless**

`session.enableDriveCycleTrace = true` — capture per-cycle drive
{ pc, A, X, Y, SP, flags, via1_orb, via1_irb, via2_orb, iec_lines }
to JSONL.

Hook into cycle-lockstep scheduler (where it ticks drive per cycle).

**S3. Diff harness**

`scripts/drive-swimlane-diff.mjs --vice=v.jsonl --headless=h.jsonl --align=cyc=N`

Outputs:
- First divergence cycle
- Drive PC at divergence
- VIA register diff
- IEC line diff

### Sprint 112 — Fix divergence #1 (likely VIA-related)

Whatever the diff harness shows. Per hypothesis ranking:
1. VIA CA1 propagation timing
2. VIA timer per-cycle batching
3. Drive cycle wrapper drift
4. ATN-AND evaluation timing

### Sprint 113 — Fix divergence #2 etc.

Iterate until motm boots. Each fix is small (timing tweak), validated
by oracle. NOT per-game whack-a-mole — each fix improves silicon
fidelity for ALL fastloaders.

### Sprint 114 — Acceptance ladder

motm + lnr-s1 + polarbear all boot to in-game. Reach gameplay = certified.

mm-s1 stays green (regression net). Adding more fastloader fixtures
(IM2, real LNR-s1, etc.) becomes additive validation.

## Why this approach beats per-game fixing

**Per-game whack-a-mole**:
- Patch motm-specific quirk
- Breaks polarbear because their workarounds clash
- Each new fastloader = new patch

**Oracle-driven silicon-equivalent**:
- One source of truth: VICE drive trace
- Each fix raises the floor for ALL software
- Eventually any 1541-bus-following software just works
- Regression-resistant: oracle compare catches future drift

## Files referenced

- VICE: `/Users/alex/Downloads/trex_cracktro_complete/tools/vice-3.7.1/src/`
  - `iecbus/iecbus.c` — bus state + lockstep entry points
  - `drive/iec/via1d1541.c` — drive-side VIA1 PB store/read
  - `drive/iec/iec.c` — drive-side IEC update
- Ours: `src/runtime/headless/iec/iec-bus.ts`, `peripherals/cia2.ts`,
  `drive/via1-iec.ts`, `drive/drive-cpu.ts`
- Existing VICE trace: `scripts/trace-eof-vice.mjs`,
  `src/runtime/vice/monitor-client.ts`

## Estimated effort

- Sprint 111 (oracle infra): 3-5 days
- Sprints 112-113 (fixes per oracle): 2-3 days each
- Sprint 114 (acceptance): 1-2 days

Total: ~2-3 weeks of focused work for true 101% 1541.

NICHT in einer Nacht machbar. ABER der Pfad ist klar.
