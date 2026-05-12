# Spec 132 — Headless M7.3: No-Audio Boundary

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 7, story M7.3
Depth: light
Predecessors: Spec 130

## Motivation

The runtime must clearly state that audio output is out of scope.
SID register state and traces remain queryable, but no audio path
exists in any mode.

## Acceptance

- `docs/sid-no-audio-boundary.md` states the boundary explicitly:
  no speaker, no audio stream, no WAV export.
- `session.modeReport()` includes `audioOut: null` in every mode.
- A smoke check asserts that no audio path is wired into the runtime
  (no `AudioContext`, `WavWriter`, etc. imported in active code).

## Deliverables

- `docs/sid-no-audio-boundary.md`
- Smoke check (lint-style scan or test that imports the runtime and
  asserts the absence of audio APIs).

## Dependencies

- Spec 130.

## Risks

- Future contributor wires up audio "for debugging". Mitigation: lint
  rule that fails the build on audio-API imports.

## Out of scope

- Any audio synthesis or output.
- WAV / ogg / mp3 export.
