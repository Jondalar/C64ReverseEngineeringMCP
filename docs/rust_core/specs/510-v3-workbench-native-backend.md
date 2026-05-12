# Spec 510 — V3 Workbench Native Backend

**Status:** STUB  
**Depends on:** 501, 503, 508

## Goal

Allow the V3 emulator workbench to drive native-backed sessions through
the existing C64RE runtime APIs.

## Scope

- session backend selection in V3 API
- live status polling
- monitor registers and memory
- keyboard/joystick command bridge
- screenshot/frame export policy
- unsupported-feature reporting in UI-facing status

## Acceptance

- V3 can start a native session and display status.
- monitor operations work for native sessions.
- unsupported UI actions report clear feature errors.
- TypeScript sessions remain available.

