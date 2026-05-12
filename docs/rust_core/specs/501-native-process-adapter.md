# Spec 501 — Native Process Adapter

**Status:** STUB  
**Depends on:** 500

## Goal

Add a `NativeMachineKernel` TypeScript adapter that launches and speaks
to the Rust engine process while preserving the existing C64RE runtime
surface.

## Scope

- `native-machine-kernel.ts`
- backend selection option
- process lifecycle
- stdio framing
- timeout and crash handling
- structured error mapping
- version/capability reporting

## Initial Transport

Use a subprocess over stdio with length-delimited JSON or MessagePack.
Do not use MCP between C64RE and the engine.

## Acceptance

- C64RE can create and close a native placeholder session.
- failure to launch reports a useful tool error.
- TypeScript backend remains default.
- no public MCP tool name changes.

