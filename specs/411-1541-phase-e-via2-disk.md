# Spec 411 — 1541 Phase E: VIA2 (disk controller)

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 410
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring drive VIA2 in line with `docs/vice-1541-arch.md §13 Phase E`
(steps 16–21) and §7.

## Doc anchor

- §13 Phase E
- §7.1 pin mapping
- §7.2 BYTE-READY → SO line trick
- §7.3 stepper motor
- §7.4 motor and density
- §7.5 write protect
- §7.6 shift register
- §14 invariants 2, 6, 7

## Canonical content (verbatim §13 Phase E)

16. VIA2 PA: parallel byte to/from rotation. On read, return last
    rotation-decoded byte; on write, latch for next byte-boundary.
17. VIA2 PB write: decode stepper phase change →
    `drive_move_head(±1)`. Decode density bits → set rotation
    speed_zone. Decode motor on/off. Decode LED bit → drive LED.
18. VIA2 PB read: SYNC bit (PB.7) from rotation; WPS (PB.4) from
    drive→read_only; LED + motor + density + stepper bits read
    back from output latch (DDR=1) or return open-collector pull
    (DDR=0).
19. VIA2 CA1 = BYTE-READY: pulsed by rotation on each byte
    boundary. PCR & 0x01 = 0 for falling-edge.
20. VIA2 CA2 = SOE: when high, BYTE-READY is also routed to CPU
    SO line. Implement via `drive->byte_ready_edge` latch consumed
    by 6510core at instruction boundary → sets V flag.
21. VIA2 CB2 = R/W: 0 = write to disk, 1 = read. Used by rotation
    to choose direction.

## VICE source cite

- VIA2 1541: `src/drive/iec/via2d1541.c`.
- Drive head: `src/drive/drive.c` `drive_move_head()`.
- VIA core: `src/core/viacore.c`.

## Audit — current TS state

Files:

- `src/runtime/headless/drive/via2d1541.ts`
- `src/runtime/headless/drive/head-position.ts` (or similar)
- `src/runtime/headless/drive/drive-cpu.ts` (SO latch consumer)

Status:

- Stepper, motor, density, LED bits decoded (1541 boot works).
- BYTE-READY → SO V flag: present (motm boots, requires this).
- Half-track support: implemented (motm fastloader half-track at
  track 35+ per memo `motm-via1-ca1.md`).

Deviations to verify:

1. **PB write decode** (§7.3, §7.4, §13 step 17):
   - Required: stepper 2-bit Gray code single-step only (§14
     invariant 7); density 2-bit speed_zone; motor on/off; LED.
   - **TODO**: cite VICE PB store byte-by-byte vs TS.

2. **PB read** (§7.5, §13 step 18):
   - Required: SYNC, WPS, latch readback per DDR.
   - **TODO**: verify formula.

3. **CA1 BYTE-READY** (§14 invariant 2, §13 step 19):
   - Required: pulsed once per byte boundary; falling-edge IRQ;
     also routed to SO when CA2 high.
   - **TODO**: verify rotation pulses CA1 + SO latch is consumed
     at CPU instruction boundary.

4. **CB2 R/W direction** (§13 step 21):
   - Required: rotation reads byte (CB2=1) or writes byte (CB2=0).
   - **TODO**: verify rotation respects CB2.

## TS extras to DELETE

- Any custom "fastloader-aware" VIA2 behavior. VICE has none.

## NTSC stub

- VIA2 + rotation are clock-independent at chip level. No stub.

## Producer changes

1. Pin PB write decoder to VICE exact (Gray code, density, etc.).
2. Pin PB read formula (SYNC, WPS, DDR mask).
3. Verify CA1 BYTE-READY pulse + SO latch.
4. Verify CB2 R/W path.

## Consumer changes

- Rotation reads CB2 from VIA2 to choose read vs write direction
  (= spec 412 / Phase F).
- SO latch consumed by `Cpu65xxVice` at instruction boundary (=
  spec 401 verifies SO handling).

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-411-via2-stepper.mjs`: step head 1
  half-track inward and outward via Gray code transitions; assert
  `headPosition.currentTrack` advances correctly.
- New smoke `scripts/smoke-411-via2-byte-ready.mjs`: rotation byte
  boundary → CA1 pulse + SO V flag set on next 6502 instruction.
- MM + Scramble unchanged.

## Open Questions

- **OQ-411-1**: 1541 stepper Gray code table — confirm exact
  sequence from `via2d1541.c`.
- **OQ-411-2**: SOE bit default — at reset, is SO routing on or
  off? DOS ROM probably sets it on; verify.

## Files touched

- `src/runtime/headless/drive/via2d1541.ts` (modify)
- `src/runtime/headless/drive/head-position.ts` (verify)
- 2 new smokes
- `specs/411-1541-phase-e-via2-disk.md` (this)

## Next spec

Spec 412 — 1541 Phase F: Rotation.
