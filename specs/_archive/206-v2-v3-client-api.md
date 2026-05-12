# Spec 206 — V2/V3 client API

**Sprint:** 122
**Status:** DONE 2026-05-08 — `KernelClient` interface defined in
src/runtime/headless/kernel/kernel-client.ts. Surface: lifecycle
(resetCold/stop), run/pause/step/stepFrame, snapshot/restore, trace,
status/mode/clocks, mountMedia/unmountMedia, queueInput/typeText,
readMemory/readRegisters, renderToPng/exportTraceBundle.
IntegratedSession is the production implementation; no second
emulator loop. Smoke `scripts/smoke-kernel-client.mjs` exercises 11
client-API operations end-to-end via `npm run smoke:kernel-client`
— **11/11 PASS**. MCP tools (headless_*) and CLI scripts already
consume IntegratedSession; migration to KernelClient interface is
incremental (existing surface stays compatible).
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
