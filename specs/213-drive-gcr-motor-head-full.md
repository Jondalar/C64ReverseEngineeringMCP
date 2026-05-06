# Spec 213 — Drive GCR / motor / head full 1:1 VICE

**Sprint:** 117
**Status:** PROPOSED (parallel-eligible)
**Maps from:** legacy 153 (drive-gcr-motor-head-full) — reframed under
ADR §4.5
**Depends on:** 202 (catch-up private), 211 (VIA2 surface)
**Write scope:** `src/runtime/headless/drive/gcr/*`,
`src/runtime/headless/drive/rotation/*`, drive-VIA2 backend hookup

## Goal

Implement full disk-rotation backend 1:1 from VICE `src/drive/gcr.c`
+ `rotation.c`. Provides GCR data byte-stream, SYNC detection,
byte-ready signal, SO/V flag behavior to drive CPU and VIA2.

This is the V1 disk-data layer that motm and every custom-fastloader
title needs. Sprint 114 had three commits on this (Steps 1-3) under
the legacy spec — code stays, spec header/scope reframed to land
under ADR §4.5 with kernel ownership of rotation timing.

## Scope (kernel §4.5)

- Motor state.
- Density zone.
- Head position.
- Bit rotation (free-running shifter, already implemented Step 1).
- SYNC detection (Step 1 + Step 2 wiring).
- Byte-ready event (Step 2 wiring, gated by feature flag → flag
  removed by this spec).
- SO/V flag behavior (Step 3 fix landed; verify under kernel
  ownership).

VIA2 PA exposes `gcr_data`; VIA2 CA1 carries byte-ready edge. Drive
CPU receives SO line directly per VICE.

Rotation timing is owned by kernel (clock-domain ratio + alarm),
**not** by VIA2 ticking itself.

## Acceptance

- motm boot trace shows drive at `$F55D` GCR routine (not idle
  `$D599` job-queue loop) — closes Sprint 113 root-cause.
- Real-G64 boot ladder for MM and motm reaches title screen.
- Byte-ready and SO/V behavior pass VICE rotation.c fixtures.
- Feature flag from Steps 1-3 removed; rotation always-on in
  `true-drive` and `real-kernal`.

## Notes

Sprint 114 commits f38461f, a8c98bd, ebdf2d7, 3977302, 42f67c2 stay.
Spec 153 (legacy) gets SUPERSEDED stamp pointing here.
