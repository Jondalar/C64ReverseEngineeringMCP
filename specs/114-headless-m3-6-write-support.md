# Spec 114 — Headless M3.6: Write Support

Status: **DONE 2026-05-04 (v1: M3.6b + M3.6c + M3.6f shipped; M3.6a + M3.6d + M3.6e deferred to v2).** v1 locks down `TrackBuffer.writeByte` → `modifiedTracks` → `persistTrackBuffer` round-trip via 13/13 fixture suite (`npm run smoke:write-support`). Side-file `<image>_session.g64` written; original image untouched; explicit `output_path` override works. SAVE through real KERNAL + drive ROM (M3.6a/d) and scratch/rename DOS-command parsing (M3.6e) are gated on the write-side BYTE-READY shifter loop, deferred to v2 — workflows that need SAVE today should use `mode: "fast-trap"`. Doc: `docs/drive-write-support.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.6
Depth: deep
Predecessors: Spec 109 (M3.1), Spec 110 (M3.2), Spec 112 (M3.4 GCR
encoder), Spec 113 (M3.5)

## Motivation

Drive emulation is currently read-only. Real-drive acceptance includes
SAVE, scratch, and rename, plus write-back of modified G64 tracks
without mutating the original image. `TrackBuffer.modifiedTracks()`
already partially supports the persistence path.

## Acceptance

- BASIC SAVE writes a file via the real drive ROM path; bytes are
  verifiable on a subsequent LOAD.
- Drive write logic — VIA2 BYTE READY on the write side, motor
  active, head positioned — emulated correctly.
- Modified G64 tracks persist to a separate write-back file (default
  `<disk>.modified.g64`); original image is untouched.
- Scratch (file delete) updates BAM correctly.
- Rename updates the directory entry.
- Synthetic SAVE-then-LOAD round-trip fixture passes.

## Sub-stories

### M3.6a — Write-side BYTE READY
VIA2 byte-ready signal on write side; drive ROM write loop exits at
correct cycle.

### M3.6b — Track-buffer write
TrackBuffer accepts writes through the GCR shifter; modified tracks
flagged.

### M3.6c — Write-back file
Persist modified tracks to a side-file; default location next to the
disk image.

### M3.6d — SAVE round-trip fixture
SAVE a synthetic file; LOAD it back; assert bytes match.

### M3.6e — Scratch + rename fixtures
Synthetic disk with files; scratch one, rename another, assert BAM +
directory state.

### M3.6f — Documentation
`docs/drive-write-support.md`.

## Deliverables

- EDIT `src/runtime/headless/drive/track-buffer.ts` (write through
  shifter)
- NEW `src/runtime/headless/drive/write-back.ts`
- NEW `src/runtime/headless/drive/save-load-tests.ts`
- `docs/drive-write-support.md`
- New synthetic fixtures.

## Dependencies

- Spec 112 (GCR encoder shared for write).
- Spec 113 (motor + WP).

## Risks and mitigations

- **Drive write path is complex**: VIA2 PB write side, motor, head,
  sector-write commands all coordinated. Mitigation: incremental
  build; SAVE first, then scratch, then rename.
- **SAVE semantics**: SAVE writes via TALK; the C64 KERNAL becomes
  the talker, drive becomes listener. Mitigation: test under both
  trap mode (regression baseline) and true-drive mode.
- **Write-back persistence format**: pick a gitignored side-file
  by default; document and make path configurable.

## Out of scope

- Format command (NEW disk).
- Validate command.
- Bad-sector emulation.
- Copy-protection write detection.

## File-touch list

- EDIT `src/runtime/headless/drive/track-buffer.ts`
- NEW `src/runtime/headless/drive/write-back.ts`
- NEW `src/runtime/headless/drive/save-load-tests.ts`
- NEW `samples/synthetic/drive/save-load/*.bin`
- NEW `docs/drive-write-support.md`
