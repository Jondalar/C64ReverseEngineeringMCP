# Sprint 113 progress: chip-level 1:1 VICE port

## Done

### MM-LOAD GREEN without \$7C poke 🎯

Per user directive "Pokes die einzelnen Spiele 'enablen' sind verboten":
- \$7C poke removed permanently from setC64Output
- Root causes fixed:
  1. CA1 input INVERSION (real 1541 schematic 7406 inverter
     between ATN line and CA1 pin). Drive ROM PCR=\$01 matches
     VICE convention with inverted CA1.
  2. After resetCold, drive.reset() restores via.lastCa1Pin =
     true. CA1 input baseline = !atnLine = false (ATN released).
     Mismatch caused first ATN-assert edge to be missed. Added
     IecBus.syncDriveCa1Baseline() called from
     IntegratedSession.resetCold AFTER drive.reset().

### Commits

- 0fc8fec: \$7C poke removed permanently
- 34310b8: ciat.ts (CIA timer state-machine 1:1 VICE port,
  not yet integrated into cia6526.ts)
- 39b6c99: Spec 145 plan doc
- afc4b23: 🎯 MM-LOAD GREEN without \$7C poke

### Empirical evidence

Drive instruction trajectory in motm stage-1:
- VICE: drive in \$0410-\$04FF range (real motm receive loop)
- Headless: drive in \$0700-\$07FF range (wrong path)
- BUT: starting from \$0372, drive bit-perfect for 3959
  instructions match VICE exactly.

Drive RAM diff at \$07A1 arm:
- 10 bytes differ in 2KB drive RAM
- 6 are stack contents (\$012b-\$0143) = different call-depth
  from earlier JSRs in ATN service
- \$0763, \$07b9 differ = motm code area written by stage-1
  setup with different register state
- Indicates divergence happens BEFORE drive reaches \$0372

### Regression status

- smoke:load 3/3 PASS (MM-LOAD WITHOUT \$7C poke)
- smoke:cpu-fidelity 31/31 PASS
- smoke:serial-matrix 22/22 PASS
- smoke:via1-iec 22/24 (2 expected fails:
  - M3.2b "initial IRQ" tests OLD non-inverted CA1 convention
  - M3.2d "DDR=input releases line" tests real-HW DDR-gating;
    VICE doesn't gate, we follow VICE)

## Remaining for motm boot

motm fastloader path divergence happens BEFORE drive's \$0300 entry.
Likely sources:
1. Drive 6502 IRQ entry cycle accounting (real 6502 does dummy
   reads at PC + PC+1 before pushing). Spec 146 territory.
2. CIA2 timer T1/T2 state-machine — ciat.ts ported but NOT YET
   integrated into cia6526.ts. KERNAL serial bit-bang phasing
   could subtly differ.
3. VIA1 timer state-machine — same approach needed (ciat-style port).
4. Drive ROM IRQ handler path through \$E853 → \$E85B+ ATN service
   has subtle differences in stack manipulation that lead to 6
   stack-byte diffs.

Next sessions:
- Spec 145 part 2: integrate ciat.ts into cia6526.ts replacing
  legacy timer
- Spec 146: drive 6502 cycle audit (per-instruction cycle counts
  vs VICE 6510core.c dummy reads)
- Spec 147: VIA1 timer state-machine port (similar to ciat.ts)
- VICE binmon trace ATN service \$E853→\$E85B side-by-side to
  pinpoint first instruction divergence

## Tools committed

- scripts/bus-trace-motm.mjs (Spec 142)
- scripts/vice-iec-capture.mjs (Spec 143)
- scripts/vice-iec-diff.mjs (Spec 143)
- scripts/probe-motm.mjs (Spec 138)
- scripts/diag-iec-divergence.mjs (Spec 140 v2)
- scripts/diff-drive-pc.mjs (drive PC trajectory diff)
- scripts/diff-drive-ram.mjs (drive RAM diff)

These tools = systematic 1:1 VICE comparison infrastructure.
Future investigations mechanical not forensic.
