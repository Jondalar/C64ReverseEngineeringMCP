# Spec 263 — SID audio playback (resid + fastsid)

**Sprint:** 137
**Status:** PROPOSED 2026-05-09
**Master:** 260

## Goal

resid 1:1 VICE audio for live playback + WAV export. fastsid
fallback for trace-only mode (= no audio backend). 50ms target
latency.

## resid implementation

Port VICE `src/resid/sid.cc` to TypeScript or compile to WASM.
Recommendation: TypeScript port — keeps determinism, no WASM
build step in build chain.

Components:
- 3 voices (waveform generator + envelope + ADSR)
- Filter (low-pass / band-pass / high-pass / mix)
- Master volume + voice mix
- Mode 6581 (default) + 8580 (later toggle)

## fastsid (existing)

Already shipped in src/runtime/headless/sid/sid.ts. Register-
state only, no audio. Used in:
- VSF round-trip (Spec 251)
- Trace-mode runs (= no audio backend, just register snapshots
  for taint analysis)

## Audio path

Live:
1. resid runs in node MCP, generates 44.1kHz stereo s16le
2. PCM chunks (1024 samples = ~23ms) → WebSocket binary frame
3. Browser WebAudio AudioContext.scheduleBuffer
4. 2-3 buffers in flight = 46-69ms total latency

Export:
- Same PCM ringbuffer
- Server-side write to WAV file via `runtime_export_audio`
- WAV header: 44 bytes RIFF + PCM data
- FLAC: deferred (V3.x), use `node-flac` if added

## Sub-tools (V3 MCP additions)

- `runtime_audio_start` — begin streaming to WebSocket
- `runtime_audio_stop` — pause stream
- `runtime_audio_export` — dump WAV for scenario+duration
- `runtime_sid_engine_select` — switch resid / fastsid
- `runtime_sid_model_select` — 6581 / 8580 (resid only)

## Acceptance

- Play SID tune from ROM: audible + clean
- Play motm intro music: matches VICE byte-equal at register
  level (= same SID writes), audio quality matches resid
- Export 30s WAV: file plays in QuickTime/audacity
- Live latency ≤50ms measured (audio playback delay vs visual)
- Determinism: same scenario twice → byte-equal WAV export

## Out of scope

- 8580 model (defer to V3.1, 6581 default)
- ReSIDfp floating-point variant
- Stereo SID dual-chip cards (rare hardware)
