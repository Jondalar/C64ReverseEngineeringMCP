# VICE testprogs — License notes

This directory contains test programs vendored from the VICE C64
emulator project SVN repository
(https://sourceforge.net/p/vice-emu/code/HEAD/tree/testprogs/) for
regression testing of the headless runtime.

## Vendored subdirs

- `lorenz-2.15/` — Wolfgang Lorenz C64 Emulator Test Suite. **Public
  domain — no copyright** per upstream readme (preserved). Source:
  testprogs/general/Lorenz-2.15/
- `cia/` — CIA chip tests. Vendored from testprogs/CIA/.
  Subdirs: cia-timer, irqdelay, transactor, pb6pb7, shiftregister,
  reload0, ciavarious, dd0drw, mirrors.
- `drive/` — 1541 drive tests. Vendored from testprogs/drive/.
  Subdirs: iecdelay, diskid, format, readtest.

## License

VICE itself is GPL-2-or-later. The testprogs directory contains
contributed test programs by various authors. Each test's `readme.txt`
(preserved alongside the .prg files) documents authorship.

Treatment in this repo: these files are **test inputs** (data) for
exercising our emulator. They are not linked into our emulator code.
This is the same model VICE itself uses for Lorenz-2.15 (which is
public domain) and Klaus Dormann's 6502 tests (GPL).

Per common practice in emulator regression suites:
- Running a GPL `.prg` file as test input through a non-GPL emulator
  is not derivative work of the test program.
- The `.prg` files retain their original GPL-2+ license; they are not
  re-licensed here.
- Original `readme.txt` files preserved verbatim.

If you redistribute these files separately from the emulator, retain
the original license attribution.

## Source revision

Vendored from VICE SVN trunk @ rev 46094, on 2026-05-08.
