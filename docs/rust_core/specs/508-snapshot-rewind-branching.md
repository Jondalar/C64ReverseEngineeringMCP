# Spec 508 — Snapshot, Rewind, and Branching

**Status:** STUB  
**Depends on:** 503, 506

## Goal

Expose native snapshots that support C64RE rewind, branch, patch, and
semantic diff workflows.

## Scope

- full machine snapshot schema
- restore validation
- deterministic replay checks
- snapshot diff bridge
- branch metadata
- patch application API
- snapshot artifact registration

## Acceptance

- snapshot/restore roundtrip is deterministic for supported slices.
- C64RE `RewindManager` can use native snapshots through the adapter.
- branch diff produces the same high-level output shape as current TS
  snapshots.

