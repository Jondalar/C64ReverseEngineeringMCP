# Spec 134 — Headless M8.2: Snapshot/Resume

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 8, story M8.2
Depth: light
Predecessors: Spec 101 (M1.4)

## Motivation

Spec 101 ships in-memory snapshots. M8.2 adds persistent
snapshot/resume to a file: full session state including drive RAM,
disk head position, and (optionally) trace ring buffers.

## Acceptance

- `session.saveSnapshot(path, opts)` writes a binary or JSON file.
- `loadSession(path)` reconstructs a session from file.
- Optional `includeTraces: boolean` to include / exclude trace rings.
- Format documented at `docs/snapshot-file-format.md`; version field
  in header.
- Smoke: save → load → continue execution → state hash equals.

## Deliverables

- NEW `src/runtime/headless/snapshot-file.ts`
- `docs/snapshot-file-format.md`
- Smoke fixtures.

## Dependencies

- Spec 101.

## Risks

- Snapshot size with traces 50 MB+. Mitigation: traces optional;
  default off in `saveSnapshot`.
- Format drift across releases. Mitigation: version field; refuse to
  load mismatched versions.

## Out of scope

- VICE VSF compatibility.
- Distributed snapshot store.
