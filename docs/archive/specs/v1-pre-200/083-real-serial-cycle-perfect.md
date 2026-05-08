# Spec 083 — Real serial bit-bang cycle-perfect (VICE-style)

## Problem

Headless KERNAL serial via traps short-circuits real bit-bang. Result: drive ROM never sees real ATN→LISTEN→SECOND→CIOUT bytes, custom drive code (M-W) never installed, MM stage-2 stuck in `$46A7` fastloader handshake wait. Without traps, KERNAL bit-bang doesn't complete byte-rotation reliably because CIA timer + IEC bus state is not cycle-precise.

VICE default = "true drive emulation" ON: real KERNAL serial code runs, real drive 1541 ROM responds, real CIA timer fires at exact cycle boundaries, IEC line state edge-driven. Fast-mode IEC traps are opt-in for speed (compatibility off in default).

## Decision

Match VICE behaviour. Real CIA timer model is cycle-perfect, IEC bus state changes drive CA1 edges + drive PB reads exactly at the cycle they happen, drive ROM ATN handler runs and drives bus back. Both KERNAL ACPTR receive loop ($EE5A) and KERNAL IECOUT send loops complete byte-by-byte without traps.

KERNAL serial traps (Sprint 72) are kept as **opt-in fast-mode** (`enableKernalSerialTraps: true`) for tests / quick-load scenarios. Default OFF.

## Scope

### CIA cycle-precise timer model (extension to current Cia6526)

- `tick(cycles)` already decrements timers; verify each underflow is detected at the EXACT cycle boundary (current model decrements per-cycle, so accurate, but verify with cycle-stamped IEC trace).
- IRQ assertion timestamp stored: when timer A underflows, mark `irqPendingAtCycle = totalCycles`; CPU services IRQ before next instruction step.
- CIA Timer B "count Timer A underflow" mode (control reg bit 5+6) — implement (KERNAL serial uses Timer B for some delays).

### IEC bus per-cycle state

- `IecBus.setC64Output()` already updates instantly. Verify drive `via1.pulseCa1` is called ON every ATN edge (check both edges, current code does this).
- Drive VIA1 PB read returns CURRENT line state — already correct (Sprint 81 PB4 polarity fix).
- Add: cycle-stamped change log (optional debug) for IEC ATN/CLK/DATA transitions, useful for diff vs VICE trace.

### Drive ROM execution

- Drive runs at 1MHz, C64 at 985.248kHz (PAL) → drive cycles per C64 cycle = 1.0149.
- Already integrated via `driveCycleAccumulator`. Verify each drive instruction executes at the right C64-cycle boundary.
- Drive's IRQ check (`driveCpu.serviceInterrupt`) already happens before each drive step.

### KERNAL serial routines run unmodified

- $ED36 ATN+LISTEN setup — runs raw.
- $EDB9 SECOND — runs raw.
- $EDDD CIOUT byte tx — runs raw, bit-bangs $DD00 + reads $DD00 for handshake.
- $EE13 ACPTR byte rx — runs raw, $EE5A wait-for-CLK-high loop polls real bus state.
- $EDFE UNLSN — runs raw.

### Default trap state change

- `enableKernalSerialTraps`: default → `false`.
- `enableKernalIoTraps`: default → `false`.
- `enableKernalFileIoTraps`: default → `false` (unchanged).
- All three remain available for opt-in fast-mode.

### Test bootstrap rework

- Existing tests that use auto-load via FFD5 trap need replacement.
- Add: `loadPrgViaTrap` helper for direct file injection (NOT through KERNAL — for unit tests).
- Add: `loadDiskNative` smoke test that types `LOAD"*",8,1` + `RUN` via keyboard buffer poke + waits for game to start.
- BASIC ROM input handling: verify keyboard buffer at $0277 + $C6 length is read by BASIC's GETIN loop; if not, scripted matrix presses via Sprint 79 keyboard backend.

### LucasArts smoke (acceptance gate)

- Boot MM via real KERNAL LOAD → real CBM-DOS file serve from drive ROM → game initialises → reaches title screen (character select).
- Tolerate ~30-60 sec emulated time (matches real C64 disk load).

## Out of scope

- IEC fast-mode protocols beyond standard CBM-DOS (custom fastloaders are game/drive-code dependent and run as data once installed via M-W).
- Tape (1531) serial.
- RS232 via CIA2 PB.

## Acceptance

- MM real-KERNAL boot reaches title screen (character select) without any traps.
- VICE trace diff: KERNAL serial PCs ($EE5A, $EE13, $EDDD, etc.) hit in similar pattern as VICE.
- Headless trap-on mode still works (back-compat).
- VSF snapshot during real-KERNAL load can be taken + restored; load resumes correctly.
