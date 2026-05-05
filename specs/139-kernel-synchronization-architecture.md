# Spec 139 — Kernel Synchronization Architecture

**Sprint**: 112 (core sync refactor)
**Phase**: architecture
**Status**: proposed
**Depends on**: `docs/headless-core-synchronization-refactor.md`, Spec 137

## Why

The motm fastloader investigation suggests the headless runtime has a
core synchronization problem, not just a bad IEC bit mask. The current
runtime mixes cycle-lockstep, VICE-style `executeToClock`, live bus
getters, optional flush hooks, and debug rescue hooks.

Before adding more local patches, define the central machine-kernel
contract.

## Scope

In scope:

- define C64 and drive clock domains
- define which component owns time advancement
- define how bus accesses carry timestamps/context
- map `IntegratedSession`, `CycleLockstepScheduler`, `DriveCpu`, IEC,
  CIA, VIA, VIC, SID, GCR, input, and traps into the new ownership model

Out of scope:

- large code migration
- motm-specific fixes
- copying VICE code

## Deliverables

- architecture note for `MachineKernel` or equivalent coordinator
- migration plan from current scheduler/session code
- explicit hot-path access contract for `$DD00`, `$1800`, `$1C00`, CIA,
  VIA, memory mapped I/O, and GCR
- list of invariants future specs must preserve

## Acceptance

- the design says exactly where every emulated chip ticks
- no component can independently advance another clock in TrueDrive mode
- follow-up implementation specs can be cut without inventing new timing
  models

