# 1541 / IEC / VIA like-for-like analysis against VICE

Date: 2026-05-13  
Scope: Last Ninja Remix LOAD/Fastloader failure, C64 `$DD00` <-> IEC bus <-> 1541 VIA1 `$1800` timing.

## Position

Update after user decision: this document is not a request for another
proof-first debugging loop. It is input to Spec 430, whose goal is a
literal VICE-shaped TypeScript port of the 1541 IEC/VIA communication
path.

Primary spec:

- `specs/430-1541-iec-via-literal-vice-port.md`

The current failure should not be treated as "KERNAL LOAD is broken".
Plain KERNAL LOAD working only proves that the slow IEC protocol is good
enough. A fastloader or drive-resident loader can still fail if IEC/VIA
edge order or drive scheduling differs by one or a few cycles.

The useful question is narrower:

> At the point where the game or uploaded loader starts bit-banging IEC,
> does headless produce the same drive VIA1 state, IEC line state, and
> drive CPU phase as VICE?

The row-1145 swimlane says no: at `$EEA9 LDA $DD00`, VICE and headless
read different DATA-in state. Therefore the error is in 1541/IEC/VIA
communication timing or state, not in the KERNAL routine itself.

## Hardware contract from 1541 docs

Reference:

- https://ist.uwaterloo.ca/~schepers/MJK/1541__.html
- https://ist.uwaterloo.ca/~schepers/MJK/serialbus.html
- https://ist.uwaterloo.ca/~schepers/MJK/via.html

Relevant facts:

- 1541 uses serial IEC, controlled by VIA #1.
- Drive CPU is a 6502 around 1 MHz.
- VIA1 PB wiring:
  - PB0 = DATA input from serial bus
  - PB1 = DATA output to serial bus
  - PB2 = CLOCK input from serial bus
  - PB3 = CLOCK output to serial bus
  - PB4 = ATN acknowledge output
  - PB5/PB6 = device address switches
  - PB7 = ATN input from serial bus
- VIA IRQ output is connected to the 1541 CPU IRQ input.

So the exact surface for this bug is:

```text
C64 CIA2 PA ($DD00)
  -> IEC bus resolution
  -> 1541 VIA1 PB read/write ($1800)
  -> VIA1 CA1 ATN edge
  -> VIA1 IFR/IER -> drive CPU IRQ
  -> drive ROM / uploaded drive code response
```

## VICE contract

### C64 CIA2 `$DD00` write

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia2.c`
- function: `store_ciapa`

Contract:

```text
if effective PA output changed:
  tmp = ~byte
  update VIC bank from tmp & 3
  iecbus_callback_write(tmp, maincpu_clk + !write_offset)
```

For x64sc, CIA write_offset is 0, therefore the IEC write clock is
`maincpu_clk + 1`.

### C64 CIA2 `$DD00` read

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia2.c`
- function: `read_ciapa`

Contract:

```text
value = ((PRA | ~DDRA) & 0x3f)
value |= iecbus_callback_read(maincpu_clk)
return value
```

The bus callback supplies the IEC input/readback bits.

### IEC bus conf1 write

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c`
- function: `iecbus_cpu_write_conf1`

Contract:

```text
drive_cpu_execute_one(unit8, clock)
iec_update_cpu_bus(data)
if ATN changed:
  iec_old_atn = cpu_bus & 0x10
  viacore_signal(via1d1541, VIA_SIG_CA1, iec_old_atn ? 0 : VIA_SIG_RISE)
recompute drv_bus[8] from drv_data[8] and cpu_bus
iec_update_ports()
```

Important ordering:

1. drive flush first,
2. C64 bus mutation,
3. ATN CA1 signal,
4. drive bus recompute,
5. cached cpu_port / drv_port recompute.

### IEC bus conf1 read

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c`
- function: `iecbus_cpu_read_conf1`

Contract:

```text
drive_cpu_execute_all(clock)
return iecbus.cpu_port
```

No bus mutation on read except the mandatory drive catch-up before
returning the cached bus state.

### Drive VIA1 `$1800` write

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c`
- function: `store_prb`

Contract:

```text
if ORB byte changed:
  drv_data[unit] = ~byte
  drv_bus[unit] = (((drv_data << 3) & 0x40)
                 | ((drv_data << 6) & ((~drv_data ^ cpu_bus) << 3) & 0x80))
  iec_update_ports()
```

### Drive VIA1 `$1800` read

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c`
- function: `read_prb`

Contract:

```text
tmp = (drv_port ^ 0x85) | 0x1a | driveid
byte = (PRB & DDRB) | (tmp & ~DDRB)
return byte
```

### Drive CPU catch-up

VICE source:

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c`
- function: `drivecpu_execute`

Contract:

```text
drivecpu_wake_up(drv)
cycles = max(0, clk_value - cpu->last_clk)
cpu->cycle_accum += sync_factor * cycles
cpu->stop_clk += cpu->cycle_accum >> 16
cpu->cycle_accum &= 0xffff
while drive_clk < stop_clk:
  execute 6510core per cycle
cpu->last_clk = clk_value
drivecpu_sleep(drv)
```

Important: in current VICE, `drivecpu_sleep()` is effectively a no-op.
It does not pause ordinary drive emulation.

## Headless mapping

### C64 CIA2

Headless source:

- `src/runtime/headless/peripherals/cia2.ts`
- `src/runtime/headless/cia/cia6526-vice.ts`

Observed mapping:

- `c64CiaWriteOffset = 0` in `headless-machine-kernel.ts`, matching x64sc.
- `installCia2` computes IEC write clock as `clkPtr() + 1` for writeOffset 0.
- CIA core computes effective PA as `PRA | ~DDRA`, matching VICE.
- CIA2 backend inverts later in `IecBus.setC64Output`, matching VICE's
  `tmp = ~byte`.
- Read path computes `((PRA | ~DDRA) & 0x3f) | pins`, matching VICE.

Assessment: CIA2 mapping looks mostly correct for this bug.

### IEC core

Headless source:

- `src/runtime/headless/iec/iec-bus-core.ts`
- `src/runtime/headless/iec/iec-bus.ts`
- `src/runtime/headless/iec/iecbus-callbacks.ts`

Observed mapping:

- `cpu_bus`, `cpu_port`, `drv_port`, `drv_bus[16]`, `drv_data[16]`
  mirror VICE `iecbus_t`.
- `iec_update_cpu_bus` formula matches VICE.
- `iec_update_ports` AND-fold and `drv_port` mapping match VICE.
- `drive_store_pb` formula matches VICE `store_prb`.
- `IecBus._performC64Write` does push-flush before bus mutation, then
  calls `core.c64_store_dd00`, matching VICE order at a high level.
- `IecBus._performC64Read` does push-flush before returning cached
  `cpu_port`, matching VICE order at a high level.

Assessment: formulas are close. The suspicious area is not the obvious
bit formula, but the wrapper semantics around ATN CA1 edge signalling
and exact drive clock at which the VIA IRQ is stamped.

## Differences / risk areas

### Risk 1 - ATN edge is converted through a level API, not passed like VICE

VICE calls:

```c
viacore_signal(via1d1541, VIA_SIG_CA1, iec_old_atn ? 0 : VIA_SIG_RISE)
```

Headless path:

```text
IecBusCore.c64_store_dd00(data, onAtnEdge)
  -> onAtnEdge(newAtn !== 0)
IecBus._performC64Write callback
  -> driveVia1.pulseCa1(!atnHigh, stamp)
Via1d1541.pulseCa1
  -> converts level transition to "rise"/"fall"
Via6522Vice.signal("ca1", ...)
```

This may be functionally equivalent, but it is not like-for-like. There
is already a `Via1d1541.signalAtnEdge(risingEdgeTag)` method that maps
closer to VICE's polarity-tag API, but the active IEC bus path uses
`pulseCa1(level)`.

Risk:

- wrong initial `_lastCa1` baseline can create or suppress one edge,
- level-to-edge conversion can hide a VICE polarity-tag mismatch,
- traces become harder to compare because VICE logs edge tags, headless
  logs inferred pin levels.

Recommendation:

- For Spec 439, compare this first.
- Prefer routing ATN through a VICE-shaped method:

  ```text
  iec_old_atn changed -> via1.signalAtnEdge(iec_old_atn ? false : true)
  ```

  only if the trace proves current `pulseCa1` is the mismatch.

### Risk 2 - CA1 baseline comments are contradictory

`IecBus.attachDriveVia1` initializes with:

```ts
via.pulseCa1(!this.atnLine)
```

With ATN released, `atnLine === true`, so this initializes CA1 level to
false. That matches the "inverted ATN" model.

But `Via1d1541` currently has:

```ts
private _lastCa1 = true; // starts high (ATN released)
```

That comment conflicts with the IEC bus comment and with the call above.
The code then immediately drives `_lastCa1` to false during attach, so it
may be harmless in practice, but this must be verified around reset,
mount, and snapshot restore.

Recommendation:

- Trace the first CA1 state after reset and after mount.
- Ensure no artificial CA1 edge is generated before DOS has configured
  PCR/IER.

### Risk 3 - drive catch-up is broadly correct, but `last_clk` equivalence
must be proven at IEC events

VICE stores host clock baseline in `cpu->last_clk` after every
`drivecpu_execute`.

Headless stores `lastSyncC64Clk` before running owed cycles. Because JS
is not re-entrant here, this should be equivalent for ordinary execution.
But for this bug the only proof that matters is at IEC events:

```text
C64 $DD00 event clock
VICE drive last_clk / stop_clk / drive clk
HL lastSyncC64Clk / accumulator / drive cycles
```

Recommendation:

- Do not instrument broad CPU history again.
- Instrument only `execute_enter/exit` for C64 `$DD00` read/write flush
  and drive `$1800` read/write windows.
- Compare `clock`, `driveClkBefore`, `driveClkAfter`, and accumulator.

### Risk 4 - headless has stale hybrid-sync vocabulary

`HeadlessKernelBus.computeCycleStepped()` still returns `pc < 0xa000` and
comments describe an old hybrid mode. Current `DriveCpu.executeToClock`
ignores `_cycleStepped` and always uses the microcoded/cycle-stepped path.

This is probably not the active runtime bug anymore, but it is a major
source of confusion in specs and agent reasoning.

Recommendation:

- Mark this as stale comments / cleanup, not as an active fix.
- Do not reintroduce whole-instruction drive dispatch.

### Risk 5 - legacy fallback `IecBusCore.drive_read_pb` is not the same
shape as active VIA1 read

The active `Via1d1541.readPb` uses the VICE formula:

```ts
tmp = ((drv_port ^ 0x85) | 0x1a | driveId)
return (prb & ddrb) | (tmp & ~ddrb)
```

The legacy helper `IecBusCore.drive_read_pb(prb, deviceId)` has a
different-looking formula and should not be used for production VIA1
reads.

Assessment:

- Current production path appears to use `Via1d1541.readPb`, so this is
  probably not the LNR bug.
- It is still dangerous as a fallback/debug path because it can make
  trace/debug conclusions disagree with runtime behavior.

Recommendation:

- Confirm no LNR runtime path uses `IecBusCore.drive_read_pb`.
- If unused, mark it legacy-only or delete in a cleanup spec.

## What should not be done next

Do not search for arbitrary "drive PC drift before fastloader" as a
general problem. That can waste days because the drive can be in different
idle/ROM phases and still complete KERNAL LOAD.

The right anchor is:

1. identify the first transition into the custom loader / uploaded drive
   code / fast IEC bit-bang path,
2. compare only the IEC/VIA state around that transition,
3. then walk backward to the first CA1/IFR/`$1800`/drive-clock mismatch.

Do not change:

- drive opcodes,
- C64 opcodes,
- GCR parser,
- mount logic,
- KERNAL ROM assumptions,
- VIC/SID/UI.

## Concrete port target

The next step is not another broad comparison pass. The next step is to
make the production code structurally match VICE:

```text
c64cia2.c store/read PA
  -> iecbus_callback_read/write
  -> iecbus_cpu_read/write_conf1
  -> drive_cpu_execute_one/all
  -> iec_update_cpu_bus / iec_update_ports
  -> via1d1541 read_prb/store_prb
  -> viacore_signal/update_myviairq
```

The current analysis identifies the places where the existing TS code is
not literal enough. Spec 430 owns the implementation.

## Concrete acceptance comparison

For one failing LNR run, capture or query only:

- C64 `$DD00` read/write:
  - C64 PC
  - C64 clock
  - effective PA output byte
  - effective `$DD00` read byte
- IEC bus:
  - `cpu_bus`
  - `cpu_port`
  - `drv_port`
  - `drv_bus[8]`
  - `drv_data[8]`
  - `iec_old_atn`
- Drive VIA1:
  - `$1800` read/write byte
  - ORB/DDR
  - PCR
  - IFR/IER
  - CA1 edge tag
- Drive CPU:
  - drive clock before/after flush
  - drive PC/SP before/after CA1 IRQ entry
  - `lastSyncC64Clk`
  - `cycleAccumulator16dot16`

After the literal port phases, the first useful acceptance check is:

```text
On the C64 $DD00 write that asserts ATN for the relevant loader exchange:

VICE:
  drive_cpu_execute_one(clock)
  cpu_bus changes
  CA1 signal fires at drive clock X
  VIA1 IFR/IRQ changes at drive clock X

Headless:
  same order?
  same drive clock?
  same CA1 edge tag?
  same PCR gate?
  same IFR/IER result?
```

If this does not match, fix the ATN/VIA path. If it matches, move to
the first `$1800` drive-side response byte that differs.

## Current conclusion

The current headless 1541 is close enough to pass broad KERNAL usage, but
it is not yet proven VICE-equivalent at the exact IEC/VIA timing boundary
that fastloaders care about.

The most suspicious deviation is not the KERNAL, not the disk parser, and
not drive opcode execution. It is the C64 `$DD00` -> IEC -> VIA1 CA1/IFR
edge path and the exact drive clock at which that edge becomes visible to
the 1541 CPU.
