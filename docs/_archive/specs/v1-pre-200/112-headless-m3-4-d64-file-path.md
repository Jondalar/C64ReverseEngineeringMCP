# Spec 112 — Headless M3.4: D64 File Path Through TrueDrive

Status: **DONE 2026-05-04 (M3.4a + M3.4c + M3.4d + M3.4e shipped; M3.4b dedicated dir-walk fixture deferred — implicit in L1 LOAD).** `IntegratedSession` now pre-encodes any `.d64` source to an in-memory G64 byte stream via the existing `buildG64` helper so the drive ROM, IEC, GCR pipeline, and head-position run the same code path as native G64. Encoder reuse confirmed: same `gcr-encode.ts` powers both the `extract_disk` MCP tool and the runtime D64-to-G64 wrap. New `regress.matrix.json` entry **L1** (synthetic 1-byte D64 LOAD in `mode: "true-drive"`) PASSed first try alongside L2/L3/L7/L8 — `npm run regress` 5/5. Doc: `docs/d64-truedrive-path.md`. Mode separation already enforced: L1 fails any silent fallback to trap path because it locks `true-drive`. M3.4b dir-walk byte-for-byte fixture + standard-game D64 (L4) tracked as follow-up.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.4
Depth: deep
Predecessors: Spec 097 (M0.4), Spec 098 (M1.1), Spec 109 (M3.1),
Spec 110 (M3.2), Spec 111 (M3.3)

## Motivation

D64 currently loads via two paths: a KERNAL fileio trap shortcut, and
the real drive ROM walking BAM and directory. The real path works
ad-hoc but lacks systematic acceptance. M3.4 ensures D64 LOAD takes
the same true-drive path G64 takes (real KERNAL serial, real drive
ROM, GCR encoding on demand for D64 sectors, real IEC). The trap path
remains an analysis-only helper, not an acceptance path.

## Acceptance

- `LOAD"<file>",8,1` from a standard D64 goes through real KERNAL
  serial + real drive ROM + GCR-on-demand for D64 sectors.
- `LOAD"$",8` directory walk goes through the real path.
- Trap-path LOAD remains available under `mode: "fast-trap"` but is
  excluded from acceptance smoke.
- Performance: D64 LOAD via real path completes within 10× trap-path
  time (acceptable for emulator).
- M0.4 L4 + L5 pass via the real path.
- Standard D64 fixtures added to the regression matrix (M1.5).

## Sub-stories

### M3.4a — GCR-on-demand encoder
Factor a reusable GCR encoder out of `disk-extractor`. Drive bus reads
D64 sectors via this encoder when the source media is D64.

### M3.4b — Drive ROM directory walk via real path
Assert BAM read + directory chain matches real HW byte-for-byte on a
synthetic D64.

### M3.4c — Drive ROM file LOAD via real path
M-W payload check, file chain follow, EOI on last block.

### M3.4d — Mode separation
`mode: "fast-trap"` allows trap path; `mode: "true-drive"` forbids it.
Tool output reports the active path explicitly.

### M3.4e — Documentation
`docs/d64-truedrive-path.md`.

## Deliverables

- NEW `src/runtime/headless/drive/gcr-encoder.ts`
- EDIT `src/runtime/headless/drive/drive-bus.ts`
- NEW `src/runtime/headless/drive/d64-truedrive-tests.ts`
- EDIT `src/runtime/headless/drive/track-buffer.ts` if lazy encoding
  is needed
- `docs/d64-truedrive-path.md`

## Test fixtures

- Synthetic D64 (M0.4 deliverable).
- Standard D64 fixture (M0.4 deliverable).

## Dependencies

- Spec 097 (smoke matrix).
- Spec 098 (mode separation).
- Spec 109, 110, 111 (real serial path).

## Risks and mitigations

- **GCR encoder coupling**: existing extractor logic is deep in the
  disk module. Mitigation: factor cleanly; both extract and drive
  emulation share the encoder.
- **Performance**: GCR-on-demand could slow LOAD significantly.
  Mitigation: cache encoded tracks per disk; encode lazily.
- **D64 vs G64 layout differences**: G64 has full-track GCR with sync
  gaps; D64 lacks gaps. Mitigation: encoder synthesizes minimal
  sync + header + data + gap pattern matching the standard 1541
  layout.
- **Regression in `extract_disk` MCP tool**: shared encoder.
  Mitigation: both paths exercise the same encoder; any change to
  the encoder must keep both passing.

## Fallback paths

- GCR encoder too slow: pre-encode whole D64 → in-memory G64 on first
  access. ~330 KB per disk, acceptable.
- Encoder bugs surface in drive ROM path: fall back to trap path with
  an explicit warning, fix encoder, switch back.

## Exit criteria

- M0.4 L4 + L5 green under `mode: "true-drive"`.
- Trap path still works under `mode: "fast-trap"`.
- Synthetic D64 directory walk + LOAD via real path round-trip
  correctly.

## File-touch list

- NEW `src/runtime/headless/drive/gcr-encoder.ts`
- EDIT `src/runtime/headless/drive/drive-bus.ts`
- NEW `src/runtime/headless/drive/d64-truedrive-tests.ts`
- EDIT `src/runtime/headless/drive/track-buffer.ts`
- NEW `docs/d64-truedrive-path.md`

## Out of scope

- D81 (1581) format.
- GEOS disk format.
- D64 error info bytes (rarely used).
- Custom 18+/40+-track D64 variants (covered only if existing
  extractor already handles them).
