# Spec 505 — Trace Store Bridge

**Status:** STUB  
**Depends on:** 503

## Goal

Make native traces first-class C64RE trace artifacts.

## Scope

- native trace channel configuration
- file-backed trace export
- normalized event schema
- DuckDB import adapter
- compact window queries for LLM workflows
- cross-backend trace metadata

## Event Families

- CPU instruction
- memory access
- I/O access
- cartridge bank/I/O
- interrupt edge/service
- snapshot marker

Later specs add IEC, GCR, VIC, SID, and input events.

## Acceptance

- `queryEvents`, `swimlaneSlice`, and `followPath` can read native
  trace artifacts.
- trace metadata identifies backend, engine version, mode, media, and
  schema version.

