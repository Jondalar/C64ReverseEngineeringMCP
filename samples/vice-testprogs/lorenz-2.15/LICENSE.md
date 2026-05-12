# Wolfgang Lorenz C64 Emulator Test Suite — Public Domain

The C64 Emulator Test Suite by Wolfgang Lorenz (Disk1.d64, Disk2.d64,
Disk3.d64, Disk4.d64) is **Public Domain — no copyright** per
upstream `readme.txt`:

> ///////////////////////////////////////////////////////////////////////////////
> C64 Emulator Test Suite - Public Domain, no Copyright
> ///////////////////////////////////////////////////////////////////////////////

Vendored 2026-05-08 from VICE SVN trunk:
- Source: https://sourceforge.net/p/vice-emu/code/HEAD/tree/testprogs/general/Lorenz-2.15/
- Mirror: https://github.com/VICE-Team/svn-mirror

Files vendored: Disk{1,2,3,4}.d64, readme.txt, refactoring-wip.txt.

## Purpose in this repo

Regression coverage for the headless C64 + 1541 runtime emulator
(`src/runtime/headless/`). Tests cover:
- All 6502 documented + undocumented opcodes
- Addressing modes
- Flag behavior
- IRQ / NMI delay + edge timing
- CIA1 / CIA2 timer A/B + ICR
- VIC-II raster + sprite collision
- Lots of edge cases that hand-written tests miss

Run via:
```
npm run test:lorenz:disk1
```

The runner (`scripts/run-lorenz-suite.mjs`) boots the headless C64 in
true-drive mode with the disk attached, types `LOAD"START",8` + `RUN`,
samples the screen RAM periodically, looks for "OK" / "WRONG" / "ERROR"
patterns to detect pass/fail per test.
