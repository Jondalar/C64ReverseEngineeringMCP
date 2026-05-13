# Spec 430 - Literal VICE port for 1541 IEC/VIA/GCR communication

**Status:** OPEN  
**Priority:** HIGH  
**Doctrine:** Stop debugging symptoms. Port the relevant VICE 1541/IEC/VIA/GCR
implementation structure like-for-like into TypeScript.

## Decision

The current 1541/IEC/VIA/GCR implementation is too much "VICE-inspired TS"
and not enough literal VICE architecture.

For Last Ninja Remix and similar fastloader cases, the target is not:

```text
prove one small mismatch, patch one wrapper, repeat
```

The target is:

```text
make the TypeScript 1541/IEC/VIA/GCR path structurally match VICE.
```

This is the same principle that worked for:

- VIC-II literal port,
- C64 vs 1541 CPU separation,
- C64 CPU opcode dispatch cleanup.

This also applies to GCR/media helpers. A function name like
`readTrackSectorLikeVice` is not sufficient if the implementation does
not literally follow VICE `gcr.c`.

## Scope

Port these VICE areas as literal TypeScript modules, preserving state
shape, function boundaries, call order, and naming as much as practical.

### VICE sources

- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus.h`
- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia2.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/via.h`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.h`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.h`

### Headless targets

Current files may be replaced, split, or wrapped by literal modules:

- `src/runtime/headless/iec/iec-bus.ts`
- `src/runtime/headless/iec/iec-bus-core.ts`
- `src/runtime/headless/iec/iecbus-callbacks.ts`
- `src/runtime/headless/peripherals/cia2.ts`
- `src/runtime/headless/via/via1d1541.ts`
- `src/runtime/headless/via/via6522-vice.ts`
- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/kernel/headless-machine-kernel.ts`
- `src/runtime/headless/kernel/headless-kernel-bus.ts`
- `src/disk/gcr.ts`
- `src/disk/g64-parser.ts`
- `src/runtime/headless/drive/gcr-shifter.ts`
- `src/runtime/headless/drive/via2-gcr.ts`

## Required Architecture

### 1. Preserve VICE module boundaries

Do not hide VICE behavior behind invented abstractions such as:

- `pulseCa1(level)` when VICE uses `viacore_signal(..., edgeTag)`,
- hybrid sync hints,
- wrapper-owned callback semantics,
- "legacy fallback" behavior on the production path,
- level re-evaluation shims.

If VICE calls:

```c
viacore_signal(unit->via1d1541, VIA_SIG_CA1,
               iec_old_atn ? 0 : VIA_SIG_RISE);
```

then the TS production path must have the same shape:

```ts
viacore_signal(via1d1541, VIA_SIG_CA1, iec_old_atn ? 0 : VIA_SIG_RISE)
```

It may be TypeScript syntax, but it must not be semantically redesigned.

### 2. Preserve VICE state objects

Create literal state objects matching VICE structs where possible.

Examples:

```text
iecbus_t:
  cpu_bus
  cpu_port
  drv_port
  drv_bus[16]
  drv_data[16]
  iec_old_atn

via_context_t:
  via[16]
  ifr
  ier
  oldpa/oldpb equivalents
  ca2_out_state
  cb2_out_state
  alarm/context pointers or TS equivalents

drivecpu_context_t:
  last_clk
  stop_clk
  cycle_accum
  int_status
```

Avoid parallel duplicate state. If a value exists in the VICE struct,
the TS port should read/write that equivalent field.

### 3. Preserve VICE call order

The exact order matters more than local elegance.

For `iecbus_cpu_write_conf1`, TS must keep:

```text
drive_cpu_execute_one(unit, clock)
iec_update_cpu_bus(data)
if ATN changed:
  update iec_old_atn
  viacore_signal(via1d1541, VIA_SIG_CA1, edgeTag)
recompute drv_bus[8]
iec_update_ports()
```

For `iecbus_cpu_read_conf1`, TS must keep:

```text
drive_cpu_execute_all(clock)
return iecbus.cpu_port
```

For `via1d1541_store_prb`, TS must keep:

```text
if byte changed:
  drv_data[unit] = ~byte
  recompute drv_bus[unit]
  iec_update_ports()
```

For `drivecpu_execute`, TS must keep:

```text
drivecpu_wake_up(drv)
cycles = max(0, clk_value - cpu.last_clk)
cycle_accum += sync_factor * cycles
stop_clk += cycle_accum >> 16
cycle_accum &= 0xffff
while drive_clk < stop_clk:
  execute one 6502 cycle through VICE-style core
cpu.last_clk = clk_value
drivecpu_sleep(drv)
```

### 4. Remove production legacy paths

These may stay only in tests or compatibility wrappers, never in the
active runtime path:

- `pulseCa1(level)` as ATN production path,
- `reevaluateCa1Level`,
- old `cycleStepped` / `pc < 0xa000` sync hints,
- `vice-whole-instruction` fallback,
- alternate `drive_read_pb` helper if it differs from `via1d1541.c`,
- synthetic IEC release hooks unless explicitly isolated outside
  truedrive mode.

### 5. One production path

For truedrive 1541, there must be one path:

```text
C64 CIA2 -> iecbus_callback -> iecbus_conf1 -> drivecpu_execute ->
iec_update_cpu_bus / iec_update_ports -> via1d1541 -> viacore ->
drive CPU interrupt status
```

No parallel direct `IecBus` convenience path may affect production state.

### 6. Preserve VICE GCR bit-level behavior

Sector and block helpers must not be "VICE-like" by naming only.

The TS GCR sector reader must literally port these VICE functions:

- `gcr_find_sync`
- `gcr_decode_block`
- `gcr_find_sector_header`
- `gcr_read_sector`
- `gcr_write_sector` only if write-back is in scope

Important VICE behavior:

```text
gcr_find_sync(raw, p, s)
  scans bit-by-bit from arbitrary bit position p
  wraps around track end
  returns the exact bit position after 10 consecutive 1-bits

gcr_decode_block(raw, p, buf, num)
  decodes from bit position p
  handles arbitrary bit shift p & 7
  wraps around track end

gcr_find_sector_header(raw, sector)
  repeatedly calls gcr_find_sync over the whole track
  decodes candidate header blocks from the returned bit position
  checks header[0] == 0x08 and header[2] == sector

gcr_read_sector(raw, data, sector)
  finds header sync
  finds next data sync within 500*8 bits from header position
  decodes 65 GCR groups
  validates block id and checksum exactly like VICE
```

Do not use byte-aligned scans, fixed-gap assumptions, or custom
header/data pairing heuristics in code that claims VICE equivalence.

## Phases

### Phase A - Freeze current runtime behavior

Before refactor:

- preserve canary commands,
- capture current passing games,
- keep existing Last Ninja failure as known red test.

Required canaries:

- Murder on the Mississippi
- Maniac Mansion
- Scramble / Krill
- IM2
- Last Ninja Remix S1 as expected failing target

### Phase B - Literal iecbus port

Create a TS module that mirrors:

- `iecbus_t`,
- `iecbus_cpu_read_conf0/1/2/3`,
- `iecbus_cpu_write_conf0/1/2/3`,
- `iec_update_cpu_bus`,
- `iec_update_ports`,
- `iecbus_status_set`,
- callback index calculation.

Do not keep the current callback router shape unless it matches VICE
function boundaries exactly.

### Phase C - Literal via1d1541 port

Port `via1d1541.c` as a device-specific wrapper around the VIA core:

- `via1d1541_store`,
- `via1d1541_read`,
- `store_prb`,
- `read_prb`,
- `store_pra`,
- `read_pra`,
- `set_int`,
- `set_ca2`,
- `set_cb2`,
- no-op functions must remain explicit no-ops if VICE has them.

The production ATN path must use the VICE-style edge tag call into
`viacore_signal`.

### Phase D - Literal VIA signal/IRQ path

Audit `via6522-vice.ts` against `viacore.c` only for the subset needed by
1541 VIA1/VIA2 first:

- `viacore_signal`,
- `update_myviairq`,
- IFR clear on reads/writes,
- PCR edge polarity,
- IER behavior,
- timer alarm update only where required by 1541.

Do not modernize.

### Phase E - Literal drive CPU catch-up surface

Make the drive catch-up surface match VICE naming and state:

- `drive_cpu_execute_one`,
- `drive_cpu_execute_all`,
- `drivecpu_execute`,
- `drivecpu_wake_up`,
- `drivecpu_sleep`,
- `last_clk`,
- `stop_clk`,
- `cycle_accum`,
- `sync_factor`.

The TS CPU core can remain TS, but the execution wrapper must match VICE
state and call order.

### Phase F - Delete/adapt old wrappers

After B-E:

- remove old production wrappers,
- keep compatibility only at public API edges,
- update comments that still mention hybrid sync or legacy paths,
- ensure all runtime paths go through the literal VICE-shaped modules.

### Phase G - Literal GCR sector/block helpers

Replace or quarantine the current `readTrackSectorLikeVice` path unless it
is proven to be a direct `gcr.c` port.

Port `gcr.c` into TypeScript with VICE-shaped names and behavior:

- `gcr_find_sync`
- `gcr_decode_block`
- `gcr_find_sector_header`
- `gcr_read_sector`

Current risk observed from another title (`The Pawn`):

- VICE scans sync bit-by-bit at arbitrary bit positions.
- Current TS tooling appears to use custom sync/block helpers and may
  effectively rely on byte-aligned or fixed-gap assumptions.
- Custom gaps or shifted data syncs can therefore produce wrong data bytes
  and false checksum errors even though VICE reads the sector.

Acceptance for this phase:

- Add tests with shifted sync/data positions and non-standard gaps.
- `read_g64_sector_candidate` must use the literal `gcr_read_sector` port.
- Any legacy "VICE-like" helper that is not literal must be renamed or
  removed from production/tooling paths.

## Do Not Do

- Do not add another trace-only abstraction to explain the bug.
- Do not patch Last Ninja specifically.
- Do not continue a "prove first, patch tiny thing" loop.
- Do not invent a cleaner TS architecture in this area.
- Do not route production ATN through level APIs if VICE uses edge tags.
- Do not keep two competing IEC/VIA production paths.
- Do not call a helper `LikeVice` unless it is a literal VICE port.
- Do not use byte-aligned GCR scanning for VICE-equivalent sector reads.

## Acceptance

The spec is complete when:

1. The active runtime IEC/VIA/GCR/1541 path is structurally VICE-shaped.
2. Production ATN signalling uses VICE-style `viacore_signal` edge tags.
3. Production `iecbus_cpu_write_conf1` and `iecbus_cpu_read_conf1` call
   order matches VICE.
4. Production VIA1 `$1800` read/write formulas and call order match VICE.
5. Production drive catch-up wrapper has VICE-equivalent `last_clk`,
   `stop_clk`, and `cycle_accum` behavior.
6. No old hybrid/legacy path remains active in truedrive mode.
7. GCR sector reads use literal `gcr.c` bit-level sync scanning and block
   decode semantics.
8. Canaries still pass.
9. Last Ninja Remix is retested after the port. If it still fails, the
   next bug is investigated against the literal port, not the old wrapper
   architecture.

## Agent Instruction

```text
Implement Spec 430. The goal is not another proof document. The goal is a
literal VICE-shaped TypeScript port of the 1541 IEC/VIA/GCR communication path.

Start with iecbus.c and via1d1541.c. Preserve state names, function
boundaries, and call order. Remove production use of pulseCa1(level),
hybrid cycleStepped hints, and legacy alternate IEC paths.

Then port gcr.c literally for sector reads: gcr_find_sync,
gcr_decode_block, gcr_find_sector_header, gcr_read_sector. Do not keep
byte-aligned or fixed-gap "VICE-like" helpers on production/tool paths.

Do not modernize the architecture. Do not add game-specific patches. Keep
canaries green after each phase.
```
