# SID No-Audio Boundary (Spec 132 / M7.3)

## Hard contract

**The headless emulator does not produce audio output. Ever.**

Excluded:
- Speaker / line-out
- PCM stream / `Float32Array` of samples
- WAV / OGG / MP3 export
- `AudioContext` / Web Audio API integration
- Real-time SID synthesis (reSID-style)

Included:
- All 32 SID register addresses ($D400-$D41F) write/read
- Oscillator / noise readback ($D41B) — LFSR-driven approximation
- ADSR envelope readback ($D41C) — per-voice timing
- POT readback ($D419/$D41A) — wired to paddle bridge (Spec 107/108)
- SID write trace channel — every write logged with PC + cycle for
  agent analysis
- Filter register state (latch only — no filter math)

## Why this contract

- V1 goal is *poll-correct* SID for software introspection, not
  audio synthesis. Software that polls SID for non-audio purposes
  (random numbers from osc3, paddle ramp timing, envelope-driven
  flag detection) sees correct values.
- Audio synthesis is non-trivial and would inflate runtime cost
  significantly without serving the project's RE workflow goals.
- Decoupling at this boundary means future "headless audio" work
  can extend without breaking the contract.

## Verification

`session.modeReport()` reports `audioOut: null` in every mode.
`scripts/smoke-sid-polish.mjs` includes a lint-style scan that
fails if any of `AudioContext`, `WavWriter`, `AudioOutput`,
`playSamples`, `audioBuffer` appear in active runtime code (comments
allowed; production identifiers banned).

## v2 considerations

If audio output is ever added (out of V1 scope, possibly V3), it
should be:
- Opt-in per session (`audioOut: { kind: "wav", path: "..." }` style)
- Layered on top of existing SID register model — no rewrite
- Off-by-default; existing `audioOut: null` consumers unaffected

## Files

- `src/runtime/headless/peripherals/sid.ts` — register model + LFSR
  + ADSR + POT bridge + write trace.
- `src/runtime/headless/integrated-session.ts` — `modeReport()`
  reports `audioOut: null`.
- `src/runtime/headless/c64/sid-polish-tests.ts` — 3 suites, 8
  fixture checks.
- `scripts/smoke-sid-polish.mjs` + `npm run smoke:sid-polish`.
