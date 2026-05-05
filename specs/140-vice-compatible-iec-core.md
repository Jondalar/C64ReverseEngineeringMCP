# Spec 140 — VICE-Compatible IEC Core

**Sprint**: 112 (core sync refactor)
**Phase**: implementation
**Status**: proposed
**Depends on**: Spec 139, Spec 137

## Why

VICE makes IEC behavior observable through a small set of cached bus
ports and explicit drive flushes at C64-side IEC accesses. Headless
currently computes IEC line state live and only installs the C64 flush
hook outside lockstep mode.

Fastloaders need VICE-compatible observable semantics.

## Scope

In scope:

- authoritative IEC state equivalent to VICE `cpu_bus`, `cpu_port`,
  `drv_bus`, `drv_data`, `drv_port`
- C64 `$DD00` read/write flush contract in TrueDrive mode
- drive `$1800` read/write contract against authoritative IEC state
- synthetic IEC tests for KERNAL and custom bit-bang edge cases

Out of scope:

- VIA interrupt-delay refactor (Spec 141)
- VICE trace importer (Spec 143)
- multi-drive beyond preserving the shape

## Acceptance

- existing IEC matrix remains green
- Maniac Mansion real KERNAL LOAD remains green
- motm first 24-bit receive command bytes match VICE for at least the
  first three receives
- TrueDrive mode reports the IEC synchronization contract used

