# Spec 124 — Headless M5.3: VICE Swimlane

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 5, story M5.3
Depth: light
Predecessors: Spec 095, Spec 122

## Motivation

Spec 095 covers the EOF-window VICE compare. M5.3 generalises it:
headless-vs-VICE alignment as a first-class command. Every
compatibility bug should end with a small divergence artifact.

## Acceptance

- `npm run swimlane -- --headless=<jsonl> --vice=<jsonl> --align=<mode>`
  produces a markdown divergence artifact.
- Alignment modes: `cold-boot`, `eof`, `pc=<addr>`, `cycle=<n>`.
- Channel-aware compare: per-channel divergence as in Spec 095.
- New MCP tool `headless_vice_swimlane`.
- Smoke: synthetic fixture diff returns "no divergence".

## Deliverables

- EDIT `scripts/swimlane-diff.mjs` (alignment modes)
- NEW MCP tool `headless_vice_swimlane`
- Smoke fixtures.

## Dependencies

- Spec 095.
- Spec 122.

## Risks

- VICE setup cost in MCP tool. Mitigation: reuse `viceSessionManager`
  patterns from Spec 095.

## Out of scope

- Distributed VICE runs.
- Real-time live swimlane during execution.
