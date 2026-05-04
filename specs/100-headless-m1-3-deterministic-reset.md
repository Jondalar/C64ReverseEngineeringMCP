# Spec 100 — Headless M1.3: Deterministic Reset Profile

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 1, story M1.3
Depth: light
Predecessors: Spec 098 (M1.1 session modes)

## Motivation

Cold-reset state is currently inconsistent: RAM init pattern, timer
state, keyboard buffer, drive RAM, joystick neutral, and IEC line state
are not pinned to a single canonical profile. Identical inputs do not
guarantee byte-identical traces, which breaks regression and oracle
comparison.

## Acceptance

- `session.resetCold(profile)` accepts
  `profile: "pal-default" | "ntsc-default" | "custom"`.
- Each named profile fully specifies:
  - PAL/NTSC video timing and CPU clock.
  - RAM init pattern (default = real-C64 power-on `00/FF`
    checker).
  - ROM set hashes (KERNAL, BASIC, character, drive ROM).
  - Joystick neutral state.
  - Keyboard buffer empty.
  - IEC lines released.
  - Drive motor off, head at track 18, drive RAM zeroed.
- Two cold resets with the same profile and the same input sequence
  produce byte-identical state at every cycle.
- Profile manifest committed at `docs/reset-profiles.md`.

## Deliverables

- `src/runtime/headless/reset-profiles.ts`
- EDIT `src/runtime/headless/integrated-session-manager.ts`
- `docs/reset-profiles.md`
- Smoke: 5 cold resets with same profile, hash full state at cycle
  100k, all hashes equal.

## Dependencies

- Spec 098.

## Risks

- VIC raster phase: real hardware starts at random raster. Mitigation:
  profile pins raster=0; document divergence from real HW as an
  intentional deterministic choice.
- ROM set drift: if ROM bytes change, hash differs and the profile
  fails its own check. Mitigation: profile records ROM hashes; mismatch
  = explicit error rather than silent divergence.

## Out of scope

- Warm reset flows.
- Cartridge-induced reset behavior (M6).
