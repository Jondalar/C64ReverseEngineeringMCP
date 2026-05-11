# Spec 214 — VIC bus stealing + IRQ timing 1:1

**Sprint:** 118
**Status:** DONE 2026-05-08 — VicIIVice in src/runtime/headless/vic/. Tests: vic-badline 8/8, vic-bus-stealing 7/7, vic-raster-irq 10/10, vic-register-rw 18/18, vic-sprite-dma 7/7 = **50/50 PASS**. Bus-steal events via kernel surface (grep-verified no direct cpu.cycles mutation). Raster IRQ scheduled via Spec 203 alarm. Title screens motm/MM/IM2 render with bitmap+multicolor+sprites — visual end-to-end confirmation.
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
