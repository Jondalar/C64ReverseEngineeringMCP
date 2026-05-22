# Spec 703 — SID reSID WASM Audio

Status: DRAFT (703.1 inventory DONE 2026-05-22)  
Created: 2026-05-21 CEST  
Supersedes: archived Spec 263  
Depends: Spec 216, Spec 701, Spec 623  
Owner: runtime / audio / v3 UI

## 1. Goal

Add real SID audio to the VICE-shaped runtime using reSID as a compiled WASM
engine.

The target is good, deterministic 6581 audio for live play, monitor/debugger
work, and WAV export. Exact analog perfection is not the first milestone; using
the real reSID implementation through WASM is enough and preferable to growing a
large approximate TypeScript SID synthesizer.

## 2. Existing State

Archived Spec 216 is DONE:

- `src/runtime/headless/sid/sid.ts` provides software-visible SID register
  behavior;
- `$D400-$D41C` read/write behavior, OSC3/ENV3 readback, and ADSR state are
  covered;
- it is sufficient for trace/snapshot/register tests;
- it has no authoritative audio output.

Archived Spec 263 proposed `resid + fastsid` audio and allowed either a TypeScript
port or WASM. The current code has a simplified TS `resid.ts`, but that file is
not the long-term fidelity authority.

Spec 703 makes the policy explicit:

- `sid.ts` remains the register/readback baseline;
- reSID WASM becomes the audio synthesis authority;
- simplified TS `resid.ts` is compatibility/fallback only.

Important correction from Spec 429: software-visible SID I/O readback is not an
audio-only concern. `$D419/$D41A` POTX/POTY must be VICE-shaped even when no
audible SID engine is active. reSID WASM may help long-term, but it does not
replace the need for a correct joyport/POT model.

## 3. Non-Goals

- Do not rewrite reSID in TypeScript as the primary path.
- Do not change CPU/VIC/CIA/IEC/1541 timing to make audio easier.
- Do not make audio drive emulation time. Spec 701 runtime loop remains the
  clock owner.
- Do not require exact VICE binary snapshot compatibility for internal reSID
  state in the first milestone.
- Do not implement stereo SID or exotic multi-SID hardware in this spec.
- Do not use reSID audio work as a reason to defer fixing software-visible SID
  POT readback. Games can branch on `$D419/$D41A` without using SID sound.

## 4. Engine Model

Active engines:

```ts
type SidEngineKind =
  | "fastsid-register"
  | "resid-wasm";
```

`fastsid-register`:

- current `sid.ts`;
- no audible output;
- used for trace-only, minimal test, or no-audio environments.

`resid-wasm`:

- wraps compiled reSID;
- receives the same SID register writes as the C64 bus;
- advances according to C64 cycles owned by Spec 701;
- emits PCM frames for WS live audio and WAV export.

The active runtime default remains configurable until gates prove stable:

```text
C64RE_SID_ENGINE=fastsid-register | resid-wasm
```

Long-term live UI default should become `resid-wasm`.

## 5. Source Authority

Use VICE-bundled reSID source as the behavioral reference where licensing and
build integration allow it.

Reference areas:

- `src/resid/sid.cc`
- `src/resid/pot.cc`
- `src/resid/voice.cc`
- `src/resid/wave.cc`
- `src/resid/envelope.cc`
- `src/resid/filter.cc`
- `src/resid/extfilt.cc`
- `src/sid/sid.c`
- `src/joyport/joyport.c`

The WASM wrapper must preserve:

- 6581 default model;
- PAL clock default `985248 Hz`;
- configurable sample rate, default `44100 Hz`;
- register writes with exact cycle timestamps;
- deterministic output for a fixed register-write timeline.
- VICE-shaped software-visible readback for `$D419/$D41A`, either directly in
  the WASM-backed engine or through the existing register-state SID plus a
  VICE-shaped joyport/POT model.

8580 support is a later extension unless nearly free in the chosen reSID build.

## 5.1 POT Readback Contract

`$D419/$D41A` are runtime-visible inputs. They must be correct before audio is
considered complete.

VICE evidence:

- `sid/sid.c` initializes `val_pot_x` / `val_pot_y` to `$ff`.
- `sid/sid.c::sid_read_chip()` samples POT values on a 512-cycle cadence and
  handles the first sample period after CIA1 port-mask switching specially.
- `joyport/joyport.c::read_joyport_potx()` and `read_joyport_poty()` default
  unconnected POT lines to `$ff`.
- `resid/pot.cc::Potentiometer::readPOT()` returns `$ff` when not modeled.

Therefore:

- default/unconnected POT readback must not be `0`;
- paddle input APIs may override the value, but the no-device default must stay
  VICE-shaped;
- CIA1 PA bits 6/7 must drive the POT port mask before exact 1351/paddle
  behavior can be claimed;
- LNR Spec 429 is the current regression gate for `$D419` bit 7.

## 6. Timing Contract

SID audio is generated from the same machine cycles as the runtime:

```text
CPU/CIA/VIC/SID/IEC/1541 execution -> Spec 701 runtime loop -> audio frame pump
```

Rules:

- SID register writes are timestamped with current C64 cycle.
- The audio engine advances by C64 cycle deltas, not by wall-clock deltas.
- Host pacing only controls when PCM is delivered, not what the SID computes.
- Pause stops producing new audio after already-buffered browser audio drains.
- Step/monitor commands do not auto-play audio unless explicitly requested.
- Warp may generate audio for export, but live warp may drop/mute presentation
  audio to avoid huge browser buffers.

## 7. WASM Boundary

Expose a small stable wrapper, not raw reSID internals:

```ts
interface SidWasmEngine {
  reset(model: "6581" | "8580", clockHz: number, sampleRate: number): void;
  write(cycle: number, addr: number, value: number): void;
  read(cycle: number, addr: number): number;
  clockUntil(cycle: number): void;
  render(maxSamples: number): Int16Array;
  snapshot?(): Uint8Array;
  restore?(bytes: Uint8Array): void;
}
```

`read()` is needed for `$D41B/$D41C` coherence. If reSID readback cannot replace
the current `sid.ts` readback immediately, the wrapper may use the existing
register-state SID as the readback authority while WASM is audio-only. That
must be documented as a temporary bridge, not a second behavioral source.

## 8. Live Audio Transport

Spec 701 already owns live binary WebSocket framing. Add an audio binary frame:

```text
BIN_TYPE_AUDIO_FRAME
header:
  sampleRate:u32
  channels:u8
  format:u8      // 1 = s16le
  frameNo:u32
  c64CycleEnd:u64
payload:
  interleaved PCM s16le
```

Default live chunk:

- 44.1 kHz;
- mono duplicated to stereo in browser if needed;
- 512 or 1024 samples per chunk;
- target 40-70 ms total latency;
- latest pacing owned by backend, buffer scheduling owned by browser WebAudio.

The UI must not call `session/run` for audio. It subscribes to binary audio
frames produced by the backend runtime loop.

## 9. Export

Add runtime export path:

```text
runtime/audio_export_wav {
  session_id | scenario,
  duration_cycles | duration_seconds,
  sample_rate?,
  model?
}
```

Export uses the same reSID WASM engine and the same SID register-write timeline
as live mode.

Output:

- WAV PCM s16le first;
- FLAC/MP3 are out of scope;
- deterministic repeat export: same scenario + seed + media -> byte-identical
  WAV.

## 10. Monitor / Inspect Integration

Spec 623 monitor should expose SID state:

```text
sid
sid regs
sid voice 1|2|3
sid model 6581|8580
sid engine
```

Spec 702-style paused inspection may later link a screen moment to SID state:

- current voice frequencies;
- waveform bits;
- ADSR phase;
- filter route/mode;
- recent `$D400-$D418` writes from trace/duckdb if tracing is active.

This is inspect metadata, not a requirement for first audible playback.

## 11. Implementation Phases

### 703.1 Inventory — DONE (2026-05-22 CEST)

**Source.** VICE-bundled reSID. Upstream `daglem/reSID` rejected: ~3 years
stale and itself points back to VICE.

- Repo: `git@github.com:VICE-Team/svn-mirror.git`, HEAD `e635822a93`
  ("Merge branch 'clean' into main").
- Local checkout root: `/Users/alex/Development/C64/Tools/vice`
  (git root). VICE source tree: `<root>/vice` (VICE **3.10**).
  reSID source: `<root>/vice/src/resid` — reSID subpackage **1.0-pre2**.
- Vendored into `third_party/resid/` (see License below). The build
  compiles from there; the VICE path above is the re-vendoring source
  only, not a build-time dependency.

**License — resolved by project relicense to GPLv3.** reSID is
**GPL-2.0-or-later**; this project was relicensed MIT → **GPL-3.0-or-later**
(2026-05-22), compatible via reSID's "v2 or any later" grant. See
`/LICENSE` + `/THIRD_PARTY_NOTICES.md`. Decision: **bundle reSID source
in-repo** (supersedes the earlier generate-at-build plan that the MIT
conflict had forced).

- reSID `.cc/.h` vendored unmodified into `third_party/resid/` (30 files,
  ~620K), GPL headers preserved verbatim. Provenance + pinned VICE commit
  in `third_party/resid/PROVENANCE.md`.
- Build is reproducible without an external VICE checkout; the build
  script compiles from `third_party/resid/`.
- The generated `.wasm` + emscripten glue are build artifacts and stay
  `.gitignore`d. No network fetch during `npm run build:mcp` (audio WASM
  build is a separate explicit step — see 703.2).
- `siddefs.h` is already VICE-configured (no `configure` step). Engine is
  self-contained (standard C++ headers only, no VICE-external includes).

**WASM build-set** (complete; corrects the partial list in §5 which omits
`dac.cc`, `filter8580new.cc`, and the 8 wave sample tables):

- Compile units: `sid.cc voice.cc wave.cc envelope.cc filter.cc
  filter8580new.cc extfilt.cc pot.cc dac.cc version.cc`.
- Headers pulled in: `wave6581_{PST,PS_,P_T,_ST}.h`,
  `wave8580_{PST,PS_,P_T,_ST}.h`, `spline.h`, `resid-config.h`,
  `siddefs.h`, plus the per-unit `.h`.

**Toolchain.** emscripten (`emcc`/`em++`) — **not currently installed**
in the dev env (`emcc not found`, `EMSDK` unset). Installing it is a
703.2 prerequisite (`brew install emscripten` or emsdk).

### 703.2 WASM Build

- Add deterministic local build script for the reSID WASM module.
- Keep generated binary either checked in with source/version notes or generated
  by a reproducible build step.
- No network fetch during normal `npm run build:mcp`.

### 703.3 Wrapper

- Add `sid/resid-wasm-engine.ts`.
- Keep existing `sid.ts` register-state tests green.
- Route writes from the bus into both readback state and WASM audio as needed.

### 703.4 Runtime Loop Integration

- Integrate with Spec 701 controller.
- Produce PCM chunks from C64 cycle deltas.
- Add `BIN_TYPE_AUDIO_FRAME`.
- Browser schedules WebAudio buffers.

### 703.5 Export

- Add WAV export using the same engine.
- Add deterministic export tests.

### 703.6 Cleanup

- Demote current simplified TS `resid.ts` to fallback/test-only, or remove it if
  no longer needed.
- Keep `fastsid-register` for trace-only/no-audio mode.

## 12. Gates

Required:

- existing Spec 216 SID register tests stay green;
- `npm run build:mcp` green;
- live session with `resid-wasm` plays audible sound without affecting PAL
  pacing correctness;
- pause/resume does not desync CPU cycles vs audio cycle accounting;
- WAV export of a fixed SID register-write script is byte-identical across two
  runs;
- at least one game/demo music path produces continuous audio for 30 seconds
  without underruns.

Recommended reference checks:

- compare register-write timeline against VICE for at least one SID-heavy title;
- compare exported WAV length and gross waveform envelope against VICE/reSID for
  the same register-write trace.

## 13. Deferred

- 8580 as user-facing toggle;
- filter-calibration UI;
- stereo SID / dual SID;
- VICE VSF import/export of full reSID internal state;
- MP3/FLAC export;
- audio in live warp mode beyond optional muted/drop presentation.
