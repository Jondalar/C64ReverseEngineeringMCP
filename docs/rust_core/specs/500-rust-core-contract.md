# Spec 500 — Rust Core Contract

**Status:** STUB  
**Depends on:** current `MachineKernel` interface  
**Epic:** Native Rust Emulator Core

## Goal

Define the stable contract between C64RE TypeScript runtime code and a
native Rust emulator engine.

## Scope

- command protocol
- session lifecycle
- media mount commands
- run control commands
- monitor commands
- status schema
- snapshot schema
- trace event schema
- error schema
- feature capability reporting

## Non-Goals

- Implementing emulation behavior.
- Replacing MCP tools.
- Choosing N-API vs subprocess permanently.

## Proposed Shape

Commands:

- `engine.version`
- `session.create`
- `session.close`
- `session.status`
- `media.mount`
- `run.cycles`
- `run.instructions`
- `run.until`
- `snapshot.save`
- `snapshot.restore`
- `monitor.registers`
- `monitor.memory.read`
- `monitor.memory.write`
- `trace.configure`
- `trace.export`
- `capabilities`

## Acceptance

- TypeScript mock adapter implements the contract.
- Schema tests reject unknown or malformed native responses.
- Existing TypeScript backend can be described by the same capability
  model.

