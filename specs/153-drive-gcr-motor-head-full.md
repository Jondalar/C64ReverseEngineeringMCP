# Spec 153 — Drive GCR/motor/head full 1:1 VICE

**Sprint**: 114 (drive data-layer truedrive)
**Status**: PROPOSED — promoted from V2 backlog after motm root-cause analysis (Spec 152 finding)
**Source**: VICE 3.7.1 src/drive/* (drive.c, gcr.c, rotation.c, drivecpu.c, iec/cia1571.c, iec/via1d1541.c, iec/via2d1541.c)
**Depends on**: Sprint 113 (chip-level 1:1 VICE) ✅, Spec 147 (VIA chip core) ✅

## Why

Sprint 113 + PLA fix made our chip layer 1:1 VICE for CPU, CIA,
VIA, alarm, IEC bus formula, KERNAL serial. **Disk-data layer
remains a stub.**

motm runtime-trace diff (Spec 152) localized concrete divergence:

- **VICE drive @ $F55D** = active GCR byte-read routine:
  reads VIA2 PRA ($1C01) for GCR data, CLV after SO pin clears V.
- **HDLS drive @ $D599** = job-queue dispatch loop, no disk
  reading.

Difference: our `via2d1541.ts` ships an idle-stub backend
(`readPa: () => 0xff`, no CA1 byte-ready, no SO pin generation).
Spec 147 explicitly deferred GCR backend to "Spec 152 V2" but
that was a forward-reference — Spec 152 turned into the swimlane
diff infrastructure instead. The real GCR work has no spec yet.
This spec fixes that.

motm cannot work without this:
- motm uploads custom drive code via M-W to drive RAM ($0300-$07FF)
- Custom code reads disk via VIA2 PRA + SO-pin byte-ready
- Without GCR sim, custom code spins forever waiting for V flag
  set by SO pin
- Drive enters wrong-path loop in $07c1-$07c8 (6× more time
  than VICE per runtime-trace diff)

User-direction since multiple sessions: "100% identisches
Verhalten zu VICE". This spec closes the gap for the data layer.

## Refinement decisions (locked 2026-05-06)

### Decision 1: Implementation depth — A (bit-stream)
Full bit-stream rotation 1:1 VICE rotation.c. Cycle-accurate
GCR shifter, density zones, sync detection. No byte-level
approximation. User-doctrine "100% identisch zu VICE".

### Decision 2: Replacement strategy — C (modular, mirrors VICE)
NEW files:
- `src/runtime/headless/drive/gcr-shifter.ts` ≈ VICE rotation.c
- `src/runtime/headless/drive/sync-detector.ts` ≈ VICE gcr.c
  (sync portion)

MODIFIED:
- `src/runtime/headless/via/via2d1541.ts` — backend thin wiring
  to shifter (idle-stub backend → real GcrBackend). Small diff.
- `src/runtime/headless/cpu/cpu65xx-vice.ts` — add SO-pin input
  line (decision 4).

VICE uses identical separation: rotation.c separate from
via2d.c. Best test isolation, best modular layering.

### Decision 3: Density zones — A (full 4-zone 1:1)
4-zone bit-period 1:1 VICE rotation.c:
- Z3 (tracks 1-17): 26 drive cycles/bit
- Z2 (18-24): 28 cycles/bit
- Z1 (25-30): 30 cycles/bit
- Z0 (31-35+): 32 cycles/bit (slowest)

VIA2 PB bits 5-6 select zone via gcr-shifter.setDensity().

### Decision 4: SO-pin → CPU V flag — B (CPU input line)
Cpu65xxVice gets new `soLine: 0|1` field + edge-detect.
GCR shifter on byte-ready signals VIA2 CA1 (already wired)
AND directly transitions cpu.soLine high→low to set V flag.
Mirrors VICE 6510core.c `BYTE so` line + transition logic.

### Decision 5: Rotation timing — A (per-drive-cycle tick)
gcr-shifter.tick(cycles) called from drive-cpu.ts after each
drive instruction (same pattern as VIA1/VIA2 timers tick).
Continuous rotation, mirrors VICE rotation.c per-drive-cycle
advance. NOT alarm-driven (rotation is dense not sparse).

### Decision 6: Write-back — V3 backlog
V2-scope: read-only (motm copy-protection is read-only).
Write-back (format/write commands from drive) deferred to V3.

## Scope (in)

- `src/runtime/headless/drive/gcr-shifter.ts` (NEW): cycle-accurate
  GCR shifter sim. Reads from TrackBuffer at head position, ticks
  per drive cycle, signals byte-ready (CA1 + SO pin) when 8 GCR
  bits accumulated. Density zones honored.
- `src/runtime/headless/drive/sync-detector.ts` (NEW): detects
  SYNC pattern (10+ "1" bits in a row) per VICE behavior. Sets
  $1C00 bit 7 = SYNC# (active low) when detected.
- `src/runtime/headless/via/via2d1541.ts`: replace idle-stub
  backend with real GcrBackend that wires:
  - `readPa` → return latched GCR data byte from shifter
  - CA1 (byte-ready) → fire when shifter.byteReady transitions
  - SO pin (drive 6502 V flag) → set when CA1 fires (real HW
    wiring)
  - PB bit 7 (SYNC#) ← shifter.syncDetected (inverted)
  - PB bit 5-6 (density) → set shifter speed zone
  - PB bit 2 (motor) → enable/disable rotation
  - PB bit 0-1 (head step phase) → coordinate with HeadPosition
- Cross-wire SO pin to CPU65xxVice: drive CPU's SO input must
  source from shifter byte-ready signal. CPU's V flag set on
  SO transition.
- Update HeadPosition to integrate with rotation timing.

## Scope (out — V3)

- Write-back to disk (format / sector write).
- D71/D81 (drive 1571/1581) support.
- Drive-side fast-clock (sub-cycle modulation).

## Deliverables

1. `gcr-shifter.ts` (~400 LOC est.) — bit-stream sim with density.
2. `sync-detector.ts` (~150 LOC) — SYNC# pattern detect.
3. `via2d1541.ts` rewrite — real GCR backend (~250 LOC).
4. `cpu65xx-vice.ts` SO-pin input wiring (~30 LOC patch).
5. Tests: `tests/unit/drive/gcr-shifter.test.ts`,
   `tests/unit/drive/sync-detector.test.ts`,
   `tests/unit/drive/byte-ready-flow.test.ts`.
6. Smoke: `npm run smoke:gcr-fidelity` (NEW) — verifies byte-ready
   signaling against VICE reference timing.
7. motm acceptance: drive reaches $0412 motm-receive-loop in
   under 50M c64 cycles (matches VICE ratio).

## VICE source paths to read

- `src/drive/drive.c` — drive lifecycle, rotation hooks
- `src/drive/rotation.c` — bit-stream rotation, density zones
- `src/drive/gcr.c` — GCR encode/decode, sync patterns
- `src/drive/iec/via2d1541.c` — VIA2 backend wiring (PB bits,
  byte-ready→SO pin path)
- `src/drive/drivecpu.c` — drive CPU SO-pin input

## Acceptance

- Per-VIA2-function unit tests pass.
- gcr-shifter unit tests verify byte-ready timing matches VICE
  reference.
- New smoke `gcr-fidelity` PASS.
- motm runtime-trace diff (vs VICE) — drive PCs converge in
  $0412-$0415 at similar ratios. $07xx hot-spot count drops
  to VICE-comparable levels.
- All Sprint 113 smokes still green.
- KERNAL serial smoke:load 3/3 still passes (no regression on
  KERNAL-only path).

## Estimated effort

3-5 sessions:
- 1 session: VICE source read + design lock
- 1-2 sessions: gcr-shifter + sync-detector port
- 1 session: VIA2 backend rewrite + SO-pin wiring
- 1 session: motm validation + diff iteration

## Cross-reference

- Spec 147 (VIA): chip core complete; this spec replaces the
  idle-stub backend.
- Spec 152 (Swimlane diff): infrastructure used to localize
  the GCR-missing root cause; will be used to verify fix.
- PLAN.md V3 backlog: drive head/motor/GCR was listed there;
  promote to Sprint 114 active.
