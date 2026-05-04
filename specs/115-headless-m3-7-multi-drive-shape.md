# Spec 115 — Headless M3.7: Multi-Drive Shape (Nice-to-Have)

Status: **DONE 2026-05-04 (v1: shape + validation shipped; M3.7b/c second-drive runtime deferred to v2).** API: `IntegratedSessionOptions.drives: DriveConfig[]` (max 2, ids ∈ {8, 9}). `validateDrives` enforces the rules; invalid configs throw at session start. v1 instantiates the device-8 entry; device 9 is reported via `session.multiDriveDeferred[]`. Tests: 20/20 — `runValidationTest` (9), session-manager fold + order-independence (8), invalid-config throws (3). Doc: `docs/multi-drive-architecture.md`. Smoke: `npm run smoke:multi-drive`. Real second-drive runtime + IEC routing (M3.7b) + 2-drive fixture (M3.7c) are tracked as v2 follow-up — covers nice-to-have shape now without blocking on the deeper refactor.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.7
Depth: deep (scoped down)
Predecessors: Spec 110 (M3.2 device ID jumper), Spec 112 (M3.4)

## Motivation

The runtime currently models a single drive on the IEC bus (device 8).
A small number of games and utilities need a second drive on device 9.
Supporting drives 10 and 11 is explicitly out of scope: 8 + 9 covers
the realistic acceptance set, and the smaller cap keeps the IEC
routing logic simple.

This is a nice-to-have. The acceptance ladder for MM and the M3
acceptance set do not require a second drive. Implementation can
defer if M3.1-M3.6 and M3.8 complete the rest.

## Acceptance

- Session config shape:
  `startIntegratedSession({ drives: [{ id: 8, disk: "..." },
   { id: 9, disk: "..." }] })`.
- Maximum two drives. Attempting to add a third or to set ID outside
  {8, 9} returns a clean validation error.
- Each drive instance has independent CPU, VIA1, VIA2, TrackBuffer,
  HeadPosition, ROM banks.
- IEC bus routes LISTEN / TALK to the addressed device by jumper-set
  ID (Spec 110); other devices stay idle.
- LOAD from drive 9 works while drive 8 has a different disk attached.
- Synthetic 2-drive fixture passes.

## Sub-stories

### M3.7a — Session manager refactor
`integrated-session-manager.ts` accepts an array of drive configs.
Validates length ≤ 2 and IDs ∈ {8, 9}.

### M3.7b — IEC bus multi-device routing
Bus tracks both drives. Only the addressed device responds; others
stay quiescent.

### M3.7c — Two-drive fixture
Synthetic D64 #1 attached to drive 8, D64 #2 to drive 9.
`LOAD"<file>",9` reads from drive 9 without disturbing drive 8 state.

### M3.7d — Validation errors
`drives: [{id:10}]` and `drives: [{},{},{}]` both reject with clear
error messages.

### M3.7e — Documentation
`docs/multi-drive-architecture.md`.

## Deliverables

- EDIT `src/runtime/headless/integrated-session-manager.ts`
- EDIT `src/runtime/headless/iec/iec-bus.ts`
- New synthetic D64 fixtures (two)
- `docs/multi-drive-architecture.md`

## Dependencies

- Spec 110 (device ID jumper).
- Spec 112 (D64 truedrive path).

## Risks and mitigations

- **Single-drive assumptions in scheduler**: years of single-drive
  code paths. Mitigation: stage refactor; ship architecture (drive
  array shape) even if the second drive is never instantiated by
  default. Smoke matrix stays single-drive until 2-drive fixture
  lands.
- **IEC routing complexity**: cap at two drives keeps routing
  trivial — match by jumper ID, fall through to "not present".
- **Test fixture need**: requires two D64s. Mitigation: synthetic
  fixtures are cheap to generate.

## Out of scope

- Drives 10 and 11.
- IEEE-488 expansion beyond drive 9.
- Hot-swap during a running session beyond the existing single-drive
  disk-change path.

## File-touch list

- EDIT `src/runtime/headless/integrated-session-manager.ts`
- EDIT `src/runtime/headless/iec/iec-bus.ts`
- NEW `samples/synthetic/multi-drive/disk1.d64`
- NEW `samples/synthetic/multi-drive/disk2.d64`
- NEW `docs/multi-drive-architecture.md`
