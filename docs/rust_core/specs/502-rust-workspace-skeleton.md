# Spec 502 — Rust Workspace Skeleton

**Status:** STUB  
**Depends on:** 500

## Goal

Create the native Rust workspace and minimal engine binary.

## Proposed Layout

```text
native/
  Cargo.toml
  c64re-core/
  c64re-engine/
  c64re-engine-cli/
  c64re-protocol/
```

## Crates

- `c64re-protocol`: versioned request/response schemas.
- `c64re-core`: emulator core data structures and pure logic.
- `c64re-engine`: session manager and engine API.
- `c64re-engine-cli`: stdio process entry point.

## Acceptance

- `cargo test` passes in `native/`.
- `c64re-engine-cli --version` works.
- engine can answer `engine.version` and `capabilities`.

