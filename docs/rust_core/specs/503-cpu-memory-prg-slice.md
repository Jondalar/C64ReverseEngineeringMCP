# Spec 503 — CPU, Memory, PRG Slice

**Status:** STUB  
**Depends on:** 502

## Goal

Implement the first useful native emulator slice: CPU + memory +
processor port + PRG load + deterministic run control.

## Scope

- 6510-compatible CPU core
- RAM and ROM mapping baseline
- processor port `$0000/$0001`
- minimal PLA sufficient for PRG tests
- PRG loader
- run by instruction/cycle budget
- stop on PC
- register and memory monitor
- CPU trace ring
- CPU+memory snapshot/restore

## Acceptance

- native run can load a PRG and stop at a requested PC.
- register/memory reads match expected values.
- trace output imports into a small C64RE fixture.
- documented illegal-opcode policy exists.

