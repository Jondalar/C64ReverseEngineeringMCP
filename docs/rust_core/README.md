# Rust Core Planning

This folder defines the Rust-native emulator core plan for C64RE.

The Rust core is not a new MCP server and not a replacement for C64RE's
project workflow. It is an internal execution engine under the existing
TypeScript MCP, project-knowledge, trace, UI, and agent APIs.

## Documents

- [EPIC.md](EPIC.md) — product and architecture epic.
- [high-level-plan.md](high-level-plan.md) — staged migration plan.
- [vsf-inspired-snapshot-contract.md](vsf-inspired-snapshot-contract.md)
  — post-VIC-FIX snapshot contract derived from VICE VSF lessons.
- [specs/](specs/) — implementation spec stubs.

## Core Decision

C64RE remains the owner of:

- MCP tools
- project knowledge
- artifact registration
- VICE oracle integration
- workspace UI and V3 emulator workbench
- agent-facing runtime workflows

Rust owns the hot deterministic emulator kernel:

- C64 CPU, memory, PLA, CIA/VIC/SID integration points
- IEC bus, 1541 CPU, VIA1/VIA2, GCR rotation, media
- snapshots, trace production, monitor primitives
- deterministic run control

The boundary must be coarse-grained. Do not call Rust once per emulated
cycle from TypeScript.
