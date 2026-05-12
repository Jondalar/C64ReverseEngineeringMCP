# Spec 506 — IEC and 1541 Foundation

**Status:** STUB  
**Depends on:** 503, 505

## Goal

Build the native true-drive foundation: C64 CIA2 IEC wiring, VICE-style
IEC shared state, 1541 drive CPU, DOS ROM, RAM, and VIA1.

## Scope

- VICE-style IEC cached state (`cpu_bus`, `cpu_port`, `drv_port`,
  `drv_bus[]`, `drv_data[]`)
- C64 `$DD00` read/write routing through the native kernel bus
- drive CPU + RAM + DOS ROM
- drive memory map `$0000-$07ff`, `$1800`, `$1c00`, `$c000-$ffff`
- VIA1 PB IEC read/write
- CA1 ATN edge model
- drive IRQ event stamping
- C64/drive sync contract
- IEC bus-access trace events

## Acceptance

- standalone drive ROM boot reaches the idle loop.
- synthetic IEC line matrix passes.
- C64 `$DD00` and drive `$1800` trace windows are normalized against
  TypeScript/VICE fixtures.
- true-drive mode reports zero hidden hooks.

