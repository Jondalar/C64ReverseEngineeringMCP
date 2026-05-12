# VICE vs Headless IEC Like-for-Like Audit - 2026-05-08

## Scope

This audit compares the C64 CIA2 / IEC / 1541 VIA1 / drive CPU path
between local VICE source and the TypeScript headless runtime.

It is intentionally narrow. It does not investigate G64 parsing, GCR
decode, KERNAL LOAD internals, VICE patching, or broad scheduler
hypotheses. The current MoTM failure is in the AB fastloader path after
KERNAL `LOAD "AB"` has succeeded.

## Local VICE Sources

Primary local VICE source tree:

```text
/Users/alex/Development/C64/Tools/vice/vice/src
```

Git identity:

```text
/Users/alex/Development/C64/Tools/vice
r46089-4946-ge635822a93
```

Relevant VICE files:

```text
/Users/alex/Development/C64/Tools/vice/vice/src/core/ciacore.c
/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia1.c
/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia2.c
/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c
/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.c
/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c
/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive.c
/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c
```

Relevant headless files:

```text
src/runtime/headless/cia/cia6526-vice.ts
src/runtime/headless/peripherals/cia2.ts
src/runtime/headless/kernel/headless-machine-kernel.ts
src/runtime/headless/kernel/headless-kernel-bus.ts
src/runtime/headless/iec/iec-bus.ts
src/runtime/headless/iec/iec-bus-core.ts
src/runtime/headless/via/via6522-vice.ts
src/runtime/headless/via/via1d1541.ts
src/runtime/headless/drive/drive-cpu.ts
```

## Finding A - CIA2 write clock is not VICE/x64sc-like

Status: fixed in headless wiring on 2026-05-08. `Cia6526Vice` now
accepts `writeOffset`, headless CIA1/CIA2 install with C64SC
`writeOffset=0`, and CIA2 IEC writes are routed with the effective
VICE/x64sc callback clock.

### VICE

`c64cia2_setup_context()` sets CIA `write_offset = 0` for
`VICE_MACHINE_C64SC`:

```c
if (machine_class == VICE_MACHINE_C64SC
    || machine_class == VICE_MACHINE_SCPU64) {
    cia->write_offset = 0;
}
```

`store_ciapa()` forwards the IEC write with:

```c
(*iecbus_callback_write)((uint8_t)tmp,
                         maincpu_clk + !(cia_context->write_offset));
```

So in x64sc/C64SC mode, CIA2 IEC writes are handed to the drive catch-up
path at `maincpu_clk + 1`.

### Headless

`Cia6526Vice` hardcodes default `write_offset = STORE_OFFSET`, where
`STORE_OFFSET = 1`, and exposes no option to set it per machine class.
`installCia2()` also does not pass a machine-specific offset.

On `$DD00` writes, `HeadlessMachineKernel.buildC64BusCtx()` uses:

```ts
clock: this.c64Cpu.cycles
```

and `HeadlessKernelBus.c64Write()` catches the drive up to exactly that
clock.

### Difference

For the VICE/x64sc oracle, C64-side IEC writes are visible to the drive
one C64 cycle later than our current headless path.

This matches the symptom shape in the current MoTM report: a fastloader
debounce/handshake path where headless sees a stable line one cycle
earlier or exits a loop one iteration earlier.

### Required narrow check

Do not patch broadly. Add a focused instrumentation row for the first
AB-scoped mismatch around `$EEA9` / `$DD00`:

```text
c64_pc, c64_clk, cia2_write_offset, bus_ctx.clock,
vice_effective_iec_clock, PRA, DDRA, composed_PA,
cpu_bus, drv_bus[8], cpu_port, read_result
```

If VICE row uses `clk+1` while headless uses `clk`, fix the CIA2
machine-class write offset and callback clock plumbing first.

## Finding B - CIA2 PA write ignores the VICE-composed PA argument

Status: fixed in headless wiring on 2026-05-08. `installCia2()` now
uses the `storePa(paOut)` argument computed by `Cia6526Vice` instead
of re-reading raw `PRA`.

### VICE

`ciacore.c` computes the effective port output before calling the
machine backend:

```c
byte = cia_context->c_cia[CIA_PRA] | ~(cia_context->c_cia[CIA_DDRA]);
(cia_context->store_ciapa)(cia_context, *(cia_context->clk_ptr), byte);
```

`c64cia2.c` then inverts that composed byte:

```c
tmp = (uint8_t)~byte;
(*iecbus_callback_write)((uint8_t)tmp, ...);
```

### Headless

`Cia6526Vice` correctly computes:

```ts
const out = u8(this.c_cia[CIA_PRA]! | ~this.c_cia[CIA_DDRA]!);
this.backend.storePa(out, this.old_pa);
```

But `installCia2()` discards the `out` argument and re-reads raw
registers:

```ts
storePa: () => {
  const or = cia.c_cia[0] ?? 0;
  const ddr = cia.c_cia[2] ?? 0;
  opts.iecWrite(or, ddr);
}
```

`IecBus.setC64Output(cia2Pa, _ddrMask)` then ignores `_ddrMask` and
inverts `cia2Pa`.

### Difference

VICE forwards `~(PRA | ~DDRA)`.

Headless currently forwards `~PRA` in the actual IEC core path.

When DDRA bits 3-5 are already outputs (`DDRA & $38 == $38`) this is
often equivalent for IEC output bits. But AB `W40B4` explicitly does:

```text
STA $DD00 = $03
LDA $DD02
ORA #$38
STA $DD02
```

That means the raw/composed distinction can matter at setup boundaries
and should not be left as "probably ok". It is a code-level
like-for-like mismatch.

### Required narrow check

On every `$DD00` write in `$4000 -> W425C`, capture both:

```text
PRA, DDRA, composed_PA = PRA | ~DDRA, forwarded_to_iec
```

If `forwarded_to_iec != composed_PA`, fix the backend to use the
`storePa(out)` argument and either remove the dead DDR parameter or make
the contract explicit.

## Finding C - VIA1 IEC formulas are mostly like-for-like

### VICE

`via1d1541.c store_prb()` receives the VIA-core-composed PB output
`PRB | ~DDRB`, stores `drv_data = ~byte`, recomputes `drv_bus`, then
updates `cpu_port` and `drv_port`.

`read_prb()` builds:

```c
tmp = (iecbus->drv_port ^ 0x85) | 0x1a | driveid;
byte = ((VIA_PRB & VIA_DDRB) | (tmp & ~VIA_DDRB));
```

### Headless

`via6522-vice.ts` computes `bbOut = PRB | ~DDRB` before calling
`backend.storePb()`.

`via1d1541.ts` and `iec-bus-core.ts` mirror the VICE formulas for
`drive_store_pb()` and `readPb()`.

### Difference

No obvious formula mismatch found in the VIA1 PB path during this pass.
Do not spend the next session rewriting VIA1 unless the AB transaction
row proves a VIA1 input tuple diverges.

## Finding D - Drive catch-up shape is VICE-like, but timing input is suspect

### VICE

`iecbus_cpu_read_conf1(clock)` calls `drive_cpu_execute_all(clock)`.

`iecbus_cpu_write_conf1(data, clock)` calls
`drive_cpu_execute_one(unit, clock)` before updating the C64 bus state.

`drivecpu_execute()` accumulates drive cycles from `clk_value -
last_clk`, runs the drive CPU until `stop_clk`, then sets
`last_clk = clk_value`.

### Headless

`HeadlessKernelBus` catches the drive up before `$DD00` reads/writes.
`DriveCpu.executeToClock()` accumulates drive cycles from the previous
C64 sync clock and runs whole drive instructions.

### Difference

The broad shape is correct. The suspect is not "TypeScript async" or
"separate modules". The suspect is the exact clock handed into
catch-up, especially Finding A's `maincpu_clk + 1` x64sc write behavior.

## Do Not Investigate Next

Do not spend the next session on:

- patching VICE source
- G64 parser changes
- GCR extraction
- drive cold boot
- KERNAL `LOAD "AB"` internals
- `$EBE8/$EBED` boot PRB speculation
- VIA1 formula rewrites
- full CPU replacement
- general scheduler rewrites

Those may be valid later, but they are not the current first like-for-like
mismatch.

## Recommended Next Patch Scope

One small diagnostic patch, then one small behavior patch only if proven:

1. Add AB-scoped trace fields for CIA2:
   `PRA`, `DDRA`, `composed_PA`, `forwarded_PA`, `write_offset`,
   `bus_ctx.clock`.
2. Re-run the existing AB transaction swimlane only through the first
   mismatch around `$EEA9`.
3. If confirmed, make `Cia6526Vice` accept `writeOffset`, set CIA1/CIA2
   to `0` for the C64SC/headless default, and route CIA2 IEC write
   catch-up with the same effective clock VICE uses.
4. Separately fix `installCia2().storePa(out)` to forward the composed
   argument, with a focused unit test:

```text
PRA=$03, DDRA=$00 -> forwarded composed PA must be $FF, not $03
PRA=$03, DDRA=$38 -> forwarded composed PA must be $C7, not $03
PRA=$03, DDRA=$3F -> forwarded composed PA must be $C3
```

Only after these two code-level mismatches are tested should the
investigation return to transaction-level VICE/headless traces.
