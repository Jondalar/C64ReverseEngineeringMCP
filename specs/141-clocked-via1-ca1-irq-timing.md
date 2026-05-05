# Spec 141 — Clocked VIA1 CA1 / IRQ Timing

**Sprint**: 112 (core sync refactor)
**Phase**: implementation
**Status**: proposed
**Depends on**: Spec 139, Spec 140

## Why

ATN edge handling currently sets VIA state immediately and also has a
drive RAM `$7C` rescue path. VICE timestamps CA1 events and applies a
deterministic interrupt-delay model. The current model can service the
drive IRQ at a timing that depends on scheduler order and current
instruction phase.

## Scope

In scope:

- timestamped CA1/CB1/CA2/CB2 edge events
- timestamped VIA timer underflow events
- deterministic IRQ-visible and IRQ-service timing
- trace output for edge clock, flag-visible clock, and service PC
- remove TrueDrive dependency on the `$7C` ATN-pending poke

Out of scope:

- full VIA shift-register fidelity
- unrelated VIA2 GCR changes
- trap-mode compatibility behavior

## Acceptance

- drive ATN handler entry aligns with VICE trace within agreed tolerance
- TrueDrive mode runs without the `$7C` poke
- existing KERNAL LOAD and IEC tests remain green

