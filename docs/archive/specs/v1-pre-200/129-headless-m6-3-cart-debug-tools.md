# Spec 129 — Headless M6.3: Cart Debug Tools

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 6, story M6.3
Depth: light
Predecessors: Spec 128 (M6.2)

## Motivation

Cartridge state is opaque without a query API. Agents need to know
cart type, active bank, EXROM/GAME state, mapped ranges, and recent
bank-switch writes.

## Acceptance

- `headless_cart_status` returns
  `{ type, activeBank, exrom, game, mappedRanges }`.
- `headless_cart_trace` returns recent bank-switch writes (PC, cycle,
  bank, mapper-specific data).
- Smoke: cart fixture produces non-empty status.

## Deliverables

- NEW MCP tools `headless_cart_status`, `headless_cart_trace`
- EDIT cart mapper modules to expose state
- Smoke fixtures.

## Dependencies

- Spec 128.

## Risks

- Trace size on heavy bank-switching. Mitigation: ring buffer with
  configurable size.

## Out of scope

- Per-bank disassembly.
- ROM patching tools.
