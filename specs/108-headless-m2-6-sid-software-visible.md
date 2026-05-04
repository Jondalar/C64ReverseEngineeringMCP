# Spec 108 — Headless M2.6: SID Software-Visible Behavior

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.6
Depth: deep
Predecessors: Spec 098 (M1.1), Spec 107 (M2.5 paddle bridge)

## Motivation

Goal: poll-correct SID without audio output. Software that polls
oscillator readback, envelope readback, or POT pins must see correct
values. Audio synthesis is explicitly out of scope.

## Acceptance

- All 29 SID register writes accepted; each write logged with PC and
  cycle for trace.
- Oscillator readback at `$D41B` returns waveform-state per voice
  (triangle, saw, pulse, noise) computed from a per-cycle phase
  accumulator.
- Envelope readback at `$D41C` returns ADSR envelope value computed
  per cycle.
- ADSR timing matches HW counter values (release time, attack rate
  per data sheet).
- POT readback `$D419 / $D41A` reflects last paddle line state from
  Spec 107.
- 6581 vs 8580 differences documented; no implementation split needed
  for software polling.
- No audio synthesis. Explicit `audioOut: null` in
  `session.modeReport()`.

## Sub-stories

- **M2.6a** Phase accumulator + waveform readback per voice.
- **M2.6b** ADSR envelope counter per voice.
- **M2.6c** POT readback wired to paddle (Spec 107).
- **M2.6d** SID write-trace channel (extends Spec 094 schema).
- **M2.6e** Documentation: `docs/sid-software-visible-notes.md`.

## Deliverables

- EDIT or NEW `src/runtime/headless/c64/sid.ts`
- NEW SID write-trace channel in Spec 094 schema
- New synthetic fixtures `samples/synthetic/sid/*.prg`
- `docs/sid-software-visible-notes.md`

## Test fixtures

- 3-4 fixtures: oscillator readback per waveform, envelope ADSR
  timing, POT readback, write trace.

## Dependencies

- Spec 098.
- Spec 107 (paddle bridge).
- Spec 094 (trace channel extension).

## Risks and mitigations

- **Phase accumulator math**: nontrivial. Mitigation: reference
  reSID-fp's polled-state path without importing audio synthesis.
- **Software polling rare**: most games never read SID. Mitigation:
  ship core readback; expand only if a target game requires more.
- **6581 vs 8580 polling differences**: minor. Mitigation: pick a
  default chip, document, allow override per profile.

## Out of scope

- Audio output of any kind.
- WAV export.
- reSID-grade audio synthesis.
- Stereo SID, multiple SID chips.

## File-touch list

- EDIT or NEW `src/runtime/headless/c64/sid.ts`
- EDIT `src/runtime/headless/trace/eof-trace.ts` (sid_writes channel)
- NEW `samples/synthetic/sid/*.prg`
- NEW `docs/sid-software-visible-notes.md`
