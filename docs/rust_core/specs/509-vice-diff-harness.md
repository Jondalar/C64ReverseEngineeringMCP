# Spec 509 — VICE Diff Harness for Native Runs

**Status:** STUB  
**Depends on:** 505, 506

## Goal

Normalize native runtime evidence into the existing VICE-diff workflow.

## Scope

- event normalization between VICE, TS headless, and native
- first-divergence reports
- bus-access windows for `$DD00`, `$1800`, `$1c00`
- CPU PC/opcode alignment windows
- compact LLM-readable diff summaries

## Acceptance

- native-vs-VICE diff can identify first divergent event in an IEC
  window.
- native-vs-TS diff can be used during backend migration.
- reports include backend version and trace schema version.

