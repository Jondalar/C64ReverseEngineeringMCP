# Spec 064 — Full KERNAL via real CIA1/CIA2 timer model

## Problem

`IntegratedSession` (Spec 062 Sprint 65) loads real C64 KERNAL/BASIC/CHARROM ROMs but cannot run KERNAL serial routines authentically. Sprint 66 iteration discovered the IEC handshake deadlocks in mutual wait between C64 KERNAL serial code and the drive ROM ATN handler.

Root cause: KERNAL's serial bit-bang routines (LISTEN/SECOND/CIOUT/UNLSN/TALK/ACPTR) use **CIA1 timer A** for inter-bit handshake delays (per CBM serial spec, ~64µs settle, 60µs setup, etc.). CIA1 timer A IRQ also drives the standard 60Hz/50Hz jiffy clock that the IRQ vector at $FFFE → $FF48 → ($0314) → $EA31 keyboard scan + cursor blink + jiffy increment depends on. Without CIA1 timer model, no IRQ → no jiffy → KERNAL serial routines stall waiting for timer events that never fire.

Sprint 67 worked around the issue by trapping LOAD/SAVE/SETLFS/SETNAM at the JMP table — bootstrap PRGs load instantly via direct G64 read. The trap is documented as a temporary measure. The user's stance is firm: with real ROMs in place, the trap defeats the purpose; we should run KERNAL authentically.

## Decision

Implement real CIA1 + CIA2 timer A/B with IRQ generation. Wire CIA IRQs into the C64 6510 IRQ line. Remove the file-IO traps. KERNAL serial routines run their actual bit-bang code, drive ROM responds via the existing IEC bit-mirror (Sprints 60-66), real handshake completes, files load authentically.

This is the foundation for Spec 065 VIC Phase A — VIC raster IRQ feeds back through the same CIA-generated IRQ-handler dispatch path.

## Scope

### CIA model (per CIA, applies to both CIA1 and CIA2)

Implement in `src/runtime/headless/cia/cia6526.ts`:

- **Port A / Port B**: PRA / PRB / DDRA / DDRB. Same OR-latch + DDR-aware read semantics as the existing 6522 model. Backends supply pin state; current CIA1 keyboard-stub + CIA2-IEC-bus wiring stay (just moved into proper backend interfaces).
- **Timer A** ($0E control): 16-bit down-counter, latch + counter, one-shot vs continuous, PB6-output mode (ignored), counts-Φ2 vs counts-CNT (we model Φ2 only for now). IRQ on underflow: sets ICR bit 0; if ICR mask bit 0 set, asserts IRQ line.
- **Timer B** ($0F control): same as Timer A. Modes that count-Timer-A-underflows or count-CNT-pulses are stubbed (Φ2 only). IRQ bit 1 in ICR.
- **TOD clock** ($08-$0B): 50Hz/60Hz BCD time-of-day. Most games don't use it; stub at zeros, ignore writes. (TOD-alarm IRQ bit 2 deferred.)
- **Shift register** ($0C): unused on standard C64. Stub.
- **Interrupt control register $0D (ICR)**:
  - Read: returns current pending flags + bit 7 = "any flag set". Read clears the flags (per real 6526 — important for KERNAL's IRQ-ack pattern).
  - Write: bit 7 = 1 → set the bits in v (enable mask). Bit 7 = 0 → clear the bits in v (disable mask).
- **Tick API**: `tick(cycles: number)` decrements active timers; sets ICR flags + asserts IRQ line on underflow per ICR mask. Called per CPU instruction by the integrated session step loop, like the VIA already does on the drive side.

### CIA1 specifics

- Port A ($DC00) = keyboard column write + paddle select + joystick port 2.
- Port B ($DC01) = keyboard row read + joystick port 1.
- Keyboard backend: scriptable input source. For now, return $FF (all keys released) by default; later (Spec 063 Phase C) add programmatic key-press queue.
- Joystick backend: $FF (all directions released, fire up).
- Timer A: drives 60Hz IRQ (NTSC) / 50Hz (PAL). KERNAL IOINIT writes $4025/$40 (PAL: 19656=50Hz, NTSC: 17045=60Hz) to T1 latch + sets ICR bit 0 + control = continuous. IRQ pin to 6510 IRQ.
- Timer B: serial-bus inter-bit delays in some KERNAL paths.

### CIA2 specifics

- Port A ($DD00) = IEC bus output bits + RS232 + VIC bank select. Already wired to iec-bus via `attachCia2ToIecBus` (Spec 062 Sprint 61); refactor to use the new CIA model's port backends.
- Port B ($DD01) = user port + RS232. Stub.
- Timer A: NMI source for some games; on standard C64 also drives RS232. CIA2 IRQ wired to **6510 NMI** line (not IRQ — important architectural detail).
- TOD: rarely used.

### IRQ + NMI wiring

- C64 6510 IRQ line = CIA1 IRQ OR (later, Spec 065) VIC IRQ. Asserted while either source has flags set; level-triggered.
- C64 6510 NMI line = CIA2 IRQ OR RESTORE-key (RESTORE wired to NMI directly, not via CIA — stub for now).
- Both use the existing `Cpu6510.serviceInterrupt(vector, brk)` API. `IntegratedSession.checkC64Interrupts` extends from current empty stub to:
  - If `cpu.interruptsDisabled() === false && (cia1.irqAsserted())`: serviceInterrupt(0xfffe, false)
  - If NMI edge detected on CIA2 or RESTORE: serviceInterrupt(0xfffa, false). NMI is edge-triggered so model previous-state.

### Integration touch points

- `IntegratedSession`: replace inline `installCia1KeyboardStub()` + `installVicMinimalStubs()` with proper CIA1 + CIA2 model objects. CIA2 wired to iec-bus per Sprint 61's pattern (move `attachCia2ToIecBus` into the new CIA2 backend setup).
- Step loop ticks both CIAs per C64 instruction (cycles consumed * 1.0 — C64 and CIAs share Φ2 clock).
- KERNAL trap removal: delete `trapLoad`/`trapSave`/`trapSetlfs`/`trapSetnam` + `handleKernalTrap`. Direct callers that previously poked zero-page parameters and JSR'd $FFD5 still work — they just take more cycles to complete (the real KERNAL serial bit-bang).

### Deferred

- TOD alarm IRQ (rarely used; stub OK).
- Timer modes that count CNT/Timer-A-underflow (most games don't use these).
- Real RS232 emulation (out of scope; the few games using it are edge cases).
- CIA shift register (unused on standard C64).
- RESTORE key NMI (stub returning "never pressed" works; Spec 063 Phase C adds the real input source).

## Acceptance criteria

1. **CIA1 timer fires regular IRQs.** From cold-start, after ~17k C64 cycles a CIA1 timer A underflow has fired and the IRQ handler ran (jiffy clock at $A0/$A1/$A2 incremented).
2. **No file-IO traps active.** `grep -c "trap\(Load\|Save\|Setlfs\|Setnam\)" src/runtime/headless/integrated-session.ts` returns 0.
3. **Maniac Mansion bootstrap completes via real KERNAL serial.** Direct $FFD5 call with filename "*", device 8, sa 1 → C64 KERNAL serial routines run real bit-bang → drive ROM responds → "boot" PRG bytes arrive in C64 RAM at $02A7. Same as Sprint 67 outcome but through real protocol.
4. **MM file load completes via real protocol.** Boot's `JSR $FFD5` for "MM" loads the 38KB file authentically. JMP $0400 reaches game code.
5. **Game IRQ handler runs.** After MM loads + JMPs $0400, the game's own IRQ vector at ($0314) replaces the default; CIA1 timer fires that vector instead. Within a few seconds of trace, the game-IRQ-PC has been visited.
6. **No regressions.** Sprints 60-66 smokes still green.

## Sprint plan

### Sprint 69a — CIA model + IRQ wiring (foundation)

- `src/runtime/headless/cia/cia6526.ts` clean-room implementation, informed by MOS 6526 datasheet + VICE source (no code lifted; project stays MIT).
- `src/runtime/headless/peripherals/cia1.ts` — CIA1 with keyboard + joystick stub backends.
- `src/runtime/headless/peripherals/cia2.ts` — CIA2 with iec-bus backend (replaces current cia2-stub.ts).
- IntegratedSession: instantiate both CIAs; tick per C64 instruction; IRQ wiring.
- Smoke: verify CIA1 timer A underflow → IRQ → vector dispatch → KERNAL IRQ handler runs → jiffy clock increments after N cycles.

### Sprint 69b — Remove file-IO traps + Maniac Mansion regression

- Delete trap handlers in IntegratedSession.
- Refactor scripts/sprint66-iterate.mjs to validate maniac mansion bootstrap via real KERNAL serial.
- Acceptance: MM bootstrap completes through real KERNAL bit-bang; smoke green.
- If new bugs surface (drive timing, IEC edge cases), fix in iteration.

### Sprint 69c — Polish + doc

- `docs/headless-cia-and-kernal.md` describes the full IRQ chain.
- Update `docs/headless-drive-emulation.md` to remove the "trap workaround" caveat.
- Verify Sprint 60-66 + 60-65 smokes still green.

## Out of scope

- Spec 065 VIC raster IRQ source — added in that spec's Phase 65c sub-sprint.
- Spec 063 Phase C scriptable input — keyboard backend stays "all released" for now.
- VSF: CIA module serializer added to module-mapping (mirrors VIA pattern). Save/load of CIA1+CIA2 state.

## Cross-reference

- Spec 062 — drive emulation foundation. Provides the iec-bus + drive ROM that this spec's KERNAL-via-real-IEC depends on.
- Spec 063 — full headless C64 vision. Phase A (VIC) is the next layer; this spec is the prerequisite IRQ infrastructure.
- VICE source `src/c64/cia1.c` + `src/c64/cia2.c` + `src/cia/` core — algorithmic reference for 6526 timer/IRQ semantics.
- Sprint 67 commit — current trap workaround being removed.
