# Spec 511 — Native Default Gate

**Status:** STUB  
**Depends on:** 503-510

## Goal

Define the evidence required before native becomes the default runtime
backend for C64RE headless sessions.

## Gate Criteria

- feature matrix says native covers default workflows
- representative PRG, CRT, D64, and G64 scenarios pass
- trace artifacts are query-compatible
- VICE diff harness covers known fastloader risks
- crash and timeout behavior is acceptable for MCP sessions
- performance is measured on long trace-producing runs
- TypeScript fallback remains selectable

## Acceptance

- decision record written with pass/fail evidence.
- default backend can be flipped by config without MCP tool changes.
- rollback path is documented.

