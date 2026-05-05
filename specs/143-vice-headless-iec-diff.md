# Spec 143 — VICE / Headless IEC Diff

**Sprint**: 112 (core sync refactor)
**Phase**: tooling
**Status**: proposed
**Depends on**: Spec 142

## Why

VICE is the current behavioral oracle. To avoid speculative IEC fixes,
headless traces must be compared against VICE at bus-event level, not
only through final PC/state snapshots.

## Scope

In scope:

- VICE capture adapter for C64 `$DD00` and drive `$1800` windows
- normalized event schema shared with Spec 142
- first-divergence report by logical send/receive index
- classification of divergence cause:
  C64 output, drive sample, cached port state, IRQ timing, or dispatch
  logic

Out of scope:

- GUI debugger
- generic whole-machine trace diff
- replacing the existing VICE runtime tools

## Acceptance

- motm trace report identifies the first differing bus event
- report is concise enough for an LLM to consume without raw trace
  scanning
- artifacts link back to both raw traces

