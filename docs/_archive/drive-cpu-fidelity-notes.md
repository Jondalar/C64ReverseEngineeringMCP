# Drive CPU Fidelity Notes (Spec 109 / M3.1)

## Summary

The 1541 drive runs on `Cpu6510Cycled` (microcoded, sub-cycle bus
access) by default in real-serial / true-drive modes. The legacy
`Cpu6510` path remains for whole-instruction execution where cycle
precision is not needed.

This document records what the drive CPU equivalence harness covers
and the residual divergences after Spec 109's M3.1 hardening pass.

## Equivalence harness

`src/runtime/headless/drive/drive-cpu-equiv-tests.ts` walks the 1541
DOS ROM from the reset vector for 50 000 instructions on both
implementations side-by-side. After every instruction boundary it
diffs `pc / a / x / y / sp / flags` (B + unused bits masked) and the
total cycle count.

Run: `npm run smoke:drive-equiv`

State equivalence: 0 divergences in 50 K instructions.
Cycle equivalence: 2-cycle residual gap (legacy 181 844 vs micro
181 842) traced to one IRQ-service entry path during startup; not
yet split out, tracked as M3.1 follow-up.

## Sub-stories status

- **M3.1a — Drive equivalence harness**: shipped. 50 K-instruction
  ROM walk, register + flag equality at every boundary.
- **M3.1b — SO pin test**: shipped. `runSoPinTest` pre-fires the
  V flag (real 6502 SO pin) and asserts `BVS +offset` is taken on
  the next instruction. Microcoded core wires
  `trackBuffer.onByteReady` → `cpu.flags |= 0x40` so drive ROM's
  `BVC $XX` byte-ready wait loops pick up the edge.
- **M3.1c — Indexed cross-page bus access**: shipped as
  `runIndyCrossPageBusTrace`. `LDA ($10),Y` with $10/$11=$00FF and
  Y=$01 → ea=$0100, page cross. The microcoded `indy_read` pattern
  emits 5 bus accesses (no unfixed dummy read — the `read_ea_pgy`
  micro-op skips the silicon dummy and adds +1 internal cycle on
  page cross). Test pins this exact sequence so any future change
  to indy semantics surfaces as a smoke fail.
- **M3.1d — Stack ops bus access**: shipped as `runPhaBusTrace`,
  `runJsrBusTrace`, `runRtsBusTrace`. PHA pins push-to-$01ff. JSR
  $1234 pins both PCH/PCL pushes (return addr = $0202, last byte
  of JSR per 6502 spec) and final pc=$1234, sp=$fd. RTS pins pull
  sequence and final pc=$1234, sp=$ff. Per-instruction equivalence
  on these opcodes was already covered by Sprint 94 across 1880
  synthetic cases; M3.1d adds the per-cycle bus pattern lock-in.
- **M3.1e — Drive-ROM opcode coverage**: shipped. The 50 K equiv
  walk visits 17 documented opcodes — limited because the 1541
  reset path enters its job-poll idle loop within ~10 instructions
  and stays there until something stimulates the IEC bus or the
  job table. Coverage will broaden once Spec 110 (M3.2 — VIA1 IEC
  contract) and Spec 111 (M3.3 — KERNAL serial byte matrix) drive
  the ROM through full LISTEN/TALK/READ command paths.
- **M3.1f — Documentation**: this file.

## Spec 109 byproduct: Bug 41 (legacy CPU cycle accounting)

The equivalence harness immediately surfaced a 1-cycle-per-instruction
over-count in legacy `Cpu6510.step()`. Root cause: `cyclesBefore` was
captured *after* the opcode-fetch `read()` had already ticked the
cycle counter. End-of-step top-up therefore double-charged the fetch
cycle. Fix: move `cyclesBefore` capture to before the opcode fetch.
See BUGREPORT.md Bug 41 for full detail.

## Open follow-ups (post-Spec 109)

- IRQ-service startup 2-cycle delta — investigate whether
  microcoded path is missing the +1 wrapper cycle or legacy is
  shorting an irrelevant cycle.
- Equivalence walk through the full LOAD command path (post Spec
  110+111) to broaden opcode coverage beyond the idle loop.
- Undocumented-opcode cycle accounting in `stepUndocumented` —
  currently relies on per-bus-access counting only with no
  end-of-step top-up; opcodes whose table cycles exceed bus
  access count silently undercount.
- Indy page-cross bus pattern — current implementation skips the
  silicon dummy read at the unfixed address. Drive ROM has not
  been observed reading the dummy bus address, but if a test
  fixture surfaces it the `read_ea_pgy` micro-op should be split
  into `dummy_addr_unfixed` + `read_ea` to mirror real silicon.
