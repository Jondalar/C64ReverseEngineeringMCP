# Spec 101 — Headless M1.4: Structured State Snapshots

Status: **DONE 2026-05-04 (v1).** `src/runtime/headless/snapshot.ts` ships `snapshot(session, opts)` + `restore(session, snap)` + `snapshotToString` + `SNAPSHOT_SCHEMA_VERSION = 1`. v1 covers C64 CPU + IEC line state + drive CPU + drive RAM + VIA1 + VIA2 regs + drive head track + keyboard matrix + joystick2 + cycle counters + mode. Optional `include: ["ram"]` adds 64KB RAM as base64. New MCP tool `headless_integrated_session_snapshot`. `npm run smoke:snapshot` PASS — snap1 → run → snap2 (different) → restore(snap1) → snap3 (== snap1). Schema documented in `docs/snapshot-schema.md`. VIC pixel pipeline mid-cycle + SID envelope phase + tracks deferred to schema v2.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 1, story M1.4
Depth: light
Predecessors: Spec 098 (M1.1 session modes)

## Motivation

Each subsystem currently has its own dump shape. MCP tool calls return
mixed strings, numbers, and booleans. Agents and tools need a single
canonical JSON snapshot covering everything software-visible.

## Acceptance

- `session.snapshot()` returns one JSON document:
  `{ cpu, memBanks, vic, cia1, cia2, sid, iec,
     drive: { cpu, via1, via2, gcr, head, disk },
     keyboard, joystick, traps, mode, cycles }`.
- Schema versioned (`schema_version: 1`); documented at
  `docs/snapshot-schema.md`.
- Snapshot is round-trippable: `session.restore(snapshot)` produces a
  session for which a subsequent `snapshot()` returns an equal payload.
- New MCP tool `headless_session_snapshot` exposes it.
- Default snapshot fits under 500 KB JSON. Bigger payloads (full RAM
  dumps, full track buffers) are opt-in via
  `snapshot({ include: ["ram", "tracks"] })`.

## Deliverables

- `src/runtime/headless/snapshot.ts`
- `docs/snapshot-schema.md`
- NEW MCP tool `headless_session_snapshot`
- Smoke: snapshot → restore → snapshot returns equal payload.

## Dependencies

- Spec 098.

## Risks

- Restore fidelity: VIC pixel pipeline mid-cycle and CPU bus state
  mid-instruction are hard to capture. Mitigation: snapshot only at
  instruction boundary; document the boundary contract.
- Schema bloat over time. Mitigation: versioned schema with optional
  sections; clear policy for breaking changes.

## Out of scope

- Persistent disk snapshots (Milestone 8 snapshot/resume).
- VICE VSF compatibility.
