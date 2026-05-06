# Spec 206 — V2/V3 client API

**Sprint:** 122
**Status:** PROPOSED
**ADR:** §1 (V2/V3 goals), §8 Step 6
**Depends on:** 204, 205, 207

## Goal

Single stable API surface for MCP, CLI, scripts, V2 LLM workbench,
and V3 human UI. No second emulator loop anywhere.

## Scope

`MachineKernel` client API exposes:

- `run(budget)` / `pause()` / `step(...)` / `stepFrame()`.
- `snapshot()` / `restore(snap)`.
- `trace()` — event stream subscription + ring read.
- `mountMedia(slot, media)` / `queueInput(event)`.
- `monitorQuery(...)` — read-only memory/register/disasm queries.
- `export(...)` — screenshot, video frame, audio buffer (V3),
  trace bundle.

MCP tools, CLI scripts, V2 workbench, V3 UI all consume this exact
API.

## Acceptance

- ADR §10 criterion 10: V2 and V3 APIs use the same kernel session.
- No duplicate emulator loop in UI or tools (audit search).
- V3 prototype screen and input go through this API.
- Existing MCP `headless_*` tools and `vice_*` tools migrate
  cleanly.
