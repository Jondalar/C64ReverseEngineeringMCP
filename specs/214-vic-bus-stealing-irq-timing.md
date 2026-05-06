# Spec 214 — VIC bus stealing + IRQ timing 1:1

**Sprint:** 118
**Status:** PROPOSED (parallel-eligible)
**Maps from:** legacy 150 (vic-bus-stealing-irq-timing) — superseded
**Depends on:** 203 (alarm + IRQ stamps)
**Write scope:** `src/runtime/headless/vic/*` only (no CPU bumps)

## Goal

VIC reports bus stealing through kernel, not by directly bumping CPU
cycles from a backend callback. Raster IRQ stamped through 203
surface.

## Scope

- Bad-line + sprite DMA bus-steal events emitted to kernel.
- Kernel applies CPU stall via clock-domain bookkeeping.
- Raster IRQ scheduled as alarm in c64 clock domain.
- Lightpen, sprite-sprite, sprite-bg collisions remain B-level for
  V1 (deferred to V3 vicii*.c full port — see EPIC_ROADMAP V3
  backlog).

## Acceptance

- ADR §10 criterion 6 trace shows bus-steal events with
  source=VIC, target=c64-CPU, edgeClock, servicedClock.
- M2.3 VIC-II per-char-row dispatch tests stay green.
- Raster IRQ tests stay green.
- No direct CPU.cycles mutation from VIC module (search proof).
