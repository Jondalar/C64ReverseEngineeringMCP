# Spec 113 — Headless M3.5: G64 GCR Shifter Fidelity

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.5
Depth: deep
Predecessors: Sprint 96 (free-running shifter), Spec 109 (M3.1)

## Motivation

Sprint 96 shipped the bit-level free-running shifter, byte-ready/SO,
density zones, and head stepping. Edge cases remain: motor on/off,
DENSITY-bit override (drive programs density independently of head
position), half-track reads, write-protect line, sync detection at
zone boundaries, and variable G64 track lengths.

## Acceptance

- Motor on/off via VIA2 PB2: motor off → shifter stalls and
  byte-ready never fires.
- DENSITY override via VIA2 PB5 + PB6: drive can force a zone
  independent of head position (e.g. head at track 18, density forced
  to zone 0 → 32 cyc/byte timing).
- Half-track reads: head at track 18.5 returns deterministic garbage;
  movement to an integer track resumes valid GCR.
- Write-protect: VIA2 PB4 reflects WP line; a G64 fixture with WP=1
  fails write attempts.
- Sync detection consistent across zone boundaries
  (17→18, 24→25, 30→31).
- G64 parser handles variable track length (7140-7900 bytes per zone).

## Sub-stories

### M3.5a — Motor gating
Wire VIA2 PB2 to TrackBuffer; motor off freezes shifter advance.

### M3.5b — DENSITY override
Wire VIA2 PB5/PB6 to track zone selection. Override beats head
position.

### M3.5c — Half-track read behavior
Half-track returns deterministic garbage; integer track resumes.

### M3.5d — Write-protect line
VIA2 PB4 read returns WP state from G64 metadata.

### M3.5e — Cross-zone sync
Test fixtures move head across zone boundaries; assert sync detection
remains correct.

### M3.5f — Documentation
`docs/g64-gcr-fidelity-notes.md`.

## Deliverables

- EDIT `src/runtime/headless/drive/track-buffer.ts` (motor, density,
  WP)
- EDIT `src/runtime/headless/drive/head-position.ts` (half-track)
- NEW `src/runtime/headless/drive/g64-fidelity-tests.ts`
- New synthetic G64 fixtures
- `docs/g64-gcr-fidelity-notes.md`

## Dependencies

- Spec 109.

## Risks and mitigations

- **Motor currently always-on**: changing to gated may break Sprint 96
  LOAD. Mitigation: motor defaults on at session start; verify Sprint
  96 LOAD path remains green.
- **DENSITY override rarely used by standard software**: low coverage
  in real-game testing. Mitigation: cover for completeness; mark
  follow-up if scope blows.
- **Half-track read behavior is HW-implementation-defined**: real
  drives differ. Mitigation: pick deterministic garbage and document.

## Out of scope

- Weak-bit / copy-protection emulation.
- Speed-zone-cross at non-zone-boundary tracks (custom-format disks).
- Full track flux modeling (real-time bit jitter).

## File-touch list

- EDIT `src/runtime/headless/drive/track-buffer.ts`
- EDIT `src/runtime/headless/drive/head-position.ts`
- NEW `src/runtime/headless/drive/g64-fidelity-tests.ts`
- NEW `samples/synthetic/g64/*.g64`
- NEW `docs/g64-gcr-fidelity-notes.md`
