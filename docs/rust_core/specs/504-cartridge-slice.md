# Spec 504 — Cartridge Slice

**Status:** STUB  
**Depends on:** 503

## Goal

Support RE-relevant CRT execution in the native backend.

## Scope

- CRT mount path
- mapper capability reporting
- Normal cartridge
- MagicDesk
- Ocean Type 1
- EasyFlash baseline
- GAME/EXROM and PLA interaction
- cartridge I/O trace events

## Acceptance

- existing cartridge smoke fixtures run through native backend where
  mapper is declared supported.
- session status reports mapper, active bank, GAME/EXROM, and writable
  state.
- unsupported CRT types fail with structured feature errors.

