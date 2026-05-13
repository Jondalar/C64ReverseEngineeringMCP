# Spec 436 — Production IEC/VIA/Drive path through src/

Date: 2026-05-13  
Branch: `1541-literal-vice`  
Sprint 430 post-D+E (commit `4ac150d`).

This document traces the single production path from C64 `$DD00`
access to the drive 6502 IRQ pipeline, citing file:line for every
hop. Acceptance for Spec 436.

## Path: C64 `$DD00` store → drive CPU IRQ

```
1. C64 6510 executes STA $DD00 / sub-cycle stalls
   → C64 CIA2 PA mutation                   src/runtime/headless/cia/cia6526-vice.ts (writeRegister, ORA path)
2. CIA2 emits effective output byte
   → IecBus.setC64Output(cia2Pa, ddr, clk)  src/runtime/headless/iec/iec-bus.ts:260
3. setC64Output inverts byte (~PA per c64cia2.c:150)
   → callbacks.callbackWrite(inverted, clk) src/runtime/headless/iec/iec-bus.ts:269
   (= VICE iecbus_callback_write — iecbus.h:91-99 indirection)
4. callbackWrite resolves to performWrite for conf1 (1541-only)
   → IecBus._performC64Write(data, clock)    src/runtime/headless/iec/iec-bus.ts:296
5. Push-flush: drive_cpu_execute_one(unit=8, clock)
   → pushFlush.one(8, clock, false)         src/runtime/headless/iec/iec-bus.ts:311
   → kernel.catchUpDrive(8, clock, false)   src/runtime/headless/kernel/headless-machine-kernel.ts:452
   → drive.executeToClock(clock, false)     src/runtime/headless/drive/drive-cpu.ts:1114
   VICE: iecbus.c:241 drive_cpu_execute_one(unit, clock).
6. core.c64_store_dd00(data, onAtnEdge)     src/runtime/headless/iec/iec-bus-core.ts (c64_store_dd00)
   - iec_update_cpu_bus(data)               (matches VICE c64iec.c:121-124)
   - if (cpu_bus & 0x10) != iec_old_atn:
       iec_old_atn = cpu_bus & 0x10
       onAtnEdge(edgeTagRise)               (VICE polarity tag: iecbus.c:251)
7. onAtnEdge → driveVia1.signalAtnEdge(edgeTagRise)
   → Via1d1541.signalAtnEdge                src/runtime/headless/via/via1d1541.ts (signalAtnEdge)
   → via.signal("ca1", "rise"|"fall")       src/runtime/headless/via/via6522-vice.ts:413
   VICE: iecbus.c:251 viacore_signal(via1d1541, VIA_SIG_CA1, edge_tag).
8. via.signal CA1: gate on PCR bit 0
   → if edgeBit == (PCR & 0x01):
       ifr |= VIA_IM_CA1
       updateIrq(clkRef())                  src/runtime/headless/via/via6522-vice.ts:422-424
   VICE: viacore.c:441-461 (CA1 case).
9. updateIrq → set_int → drive CPU IRQ
   → backend.setInt(value, rclk)            (Spec 410 chip-side push)
   → cpuIntStatus.setIrq(via1IntNum, asserted, clk)  src/runtime/headless/via/via1d1541.ts:158
   VICE: via1d1541.c:99 interrupt_set_irq(dc->cpu->int_status, ...).
10. recompute drv_bus[8] + iec_update_ports (back inside c64_store_dd00)
    VICE: iecbus.c:281-285 + c64iec.c:126-138.
```

## Path: C64 `$DD00` read

```
1. CIA2 readRegister(0)                     src/runtime/headless/cia/cia6526-vice.ts
2. IecBus.buildC64InputBits(clk, false)     src/runtime/headless/iec/iec-bus.ts:357
3. callbacks.callbackRead(clk)              src/runtime/headless/iec/iec-bus.ts:386
4. IecBus._performC64Read(clock)            src/runtime/headless/iec/iec-bus.ts:392
5. Push-flush: drive_cpu_execute_all(clock)
   → pushFlush.all(clock, false)            src/runtime/headless/iec/iec-bus.ts:393
   → kernel.catchUpDrive(8, clock, false)   src/runtime/headless/kernel/headless-machine-kernel.ts:457
   → drive.executeToClock(clock, false)     src/runtime/headless/drive/drive-cpu.ts:1114
   VICE: iecbus.c:229 drive_cpu_execute_all(clock).
6. return core.cpu_port                     src/runtime/headless/iec/iec-bus.ts:401
   VICE: iecbus.c:231 return iecbus.cpu_port.
```

## Path: drive `$1800` store (drive→bus)

```
1. drive 6502 STA $1800
   → drive bus dispatch                     src/runtime/headless/drive/drive-cpu.ts (memory map)
2. via.write(0x00, value)                   src/runtime/headless/via/via6522-vice.ts (store)
3. VIA core ORB path → backend.storePb      src/runtime/headless/via/via1d1541.ts:115-119
4. core.drive_store_pb(byte, deviceId=8)    src/runtime/headless/iec/iec-bus-core.ts (drive_store_pb)
   - drv_data[unit] = ~byte
   - recompute drv_bus[unit] (VICE iecbus.c:281-285 default branch)
   - iec_update_ports() (VICE c64iec.c:126-138)
```

## Path: drive `$1800` read (bus→drive)

```
1. drive 6502 LDA $1800
   → drive bus dispatch
2. via.read(0x00)                           src/runtime/headless/via/via6522-vice.ts (read)
3. VIA core IRB path → backend.readPb       src/runtime/headless/via/via1d1541.ts:103-109
4. compute byte from iec.drv_port + PRB + DDRB + driveId
   VICE: via1d1541.c:324-362 read_prb literal formula:
     tmp = (drv_port ^ 0x85) | 0x1a | driveId
     byte = (PRB & DDRB) | (tmp & ~DDRB)
```

## Confirmed

After Specs 432–435:

- **One production ATN path**: edge-tag through `signalAtnEdge` →
  `via.signal("ca1", "rise"/"fall")`. No `pulseCa1(level)` call
  on this path.
- **One push-flush path**: `pushFlush.{one,all}(clock, false)`
  forwarding to `drive_cpu_execute_one/all`. The `cycleStepped`
  arg is hardcoded `false` (Spec 435).
- **One drive IRQ push path**: chip-side `cpuIntStatus.setIrq(...)`
  from `Via1d1541.attachIrqLine` callback. Legacy polling bridge
  removed (Spec 410).
- **One read_prb formula**: literal VICE via1d1541.c.

No parallel production path observed.
