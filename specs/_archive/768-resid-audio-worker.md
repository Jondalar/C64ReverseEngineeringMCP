# Spec 768 — reSID audio on a backend worker thread (off the emu budget)

**Status:** 768.1–768.3 DONE + on master (merged 91586119), **DEFAULT ON**
(`C64RE_RESID_WORKER=0` reverts to the inline recorder). USER-CONFIRMED: stable
50 fps with synced audio, byte-identical PCM. The write-stream ring (768.1), the
off-thread worker (768.2, probe-768-worker), and the live wiring + default-on
(768.3, probe-768-host) are shipped. REMAINING: **768.4** — sample-exact
scrub/restore (the worker reSID-state round-trip; today a scrub flushes + re-syncs
from current state = a brief blip, no desync) + 768.5 (already met live). Prior:
PROPOSED → IN PROGRESS.
**Why now:** the live fps dip with audio is the backend reSID render competing in
the single emulation thread. Measured (probe-resid-cost.mjs, M4 Pro): reSID render
= **~2.1 ms/frame**; baseline (no audio) 14.7 ms/frame, +reSID 16.8 ms/frame. In
isolation that's under the 20 ms PAL budget, but LIVE adds the WS frame ship
(~102 KiB/frame), the audio ship, present, and machine contention — so the 2.1 ms
is the marginal cost that tips a live frame over 20 ms (audio-off 50/51 fps →
audio-on < 48). The fps dip is **not** the client and **not** VIC rendering.
**Pairs with / reuses:** 766 (shared-memory SPSC ring + worker — the pattern to
copy), 703 (reSID-on-backend audio architecture), 705.A (audio checkpoint state),
706 (browser AudioWorklet ring + latency cushion).
**Non-goal:** reSID in the browser. Rejected — 4 prior browser-side approaches
stuttered (see [[project_resid_audio_architecture]]); reSID stays on the backend.
This spec moves it to a backend WORKER thread, not the browser.

## 0. The model — reSID off the emulation thread (766 pattern, for audio)

```
  EMU THREAD (producer)            SHARED RINGS (SAB)          reSID WORKER (consumer)
  ───────────────────────          ──────────────────         ───────────────────────
  per SID register write:          SID write-stream ring  ───► drain writes (timed)
    push (cycle, reg, value)  ───►  (cheap, ~handful/frame)    replay into reSID, render
  per frame: push a                                            882 stereo samples/frame
    FRAME-BOUNDARY marker          audio PCM ring (SAB)   ◄───  write PCM into the ring
  fire-and-forget, NO render.                              ───► WS layer ships to browser
```

The emu thread no longer calls `recorder.flush()` (the ~2.1 ms reSID render).
It only stamps SID writes into a ring (a few int32s per frame) and marks frame
boundaries. The worker owns the `Resid` engine, renders each frame's PCM on its
own core, and fills the audio ring the WS audio path already ships. Emu per-frame
work drops ~2.1 ms → back to ~14.7 ms → **stable 50 fps WITH audio**, no quality
change (same reSID, same 44100 Hz).

**Invariant (the whole point):** the emu thread NEVER renders reSID. It only
memcpy's `(cycle, reg, value)` + boundary markers into the shared ring.

## 1. Why a worker is the only quality-neutral fix

Measured reSID = 2.1 ms/frame for 882 stereo samples through 3 voices + filter
(reSID-wasm). The cheaper alternatives all lose quality or don't help:

| option | verdict |
|---|---|
| fastsid instead of reSID | cheaper, lower quality — **no** (SID fidelity is sacred) |
| lower sample rate (22050) | halves cost, audible quality loss — **no** |
| render every N frames (bigger chunks) | same total work amortized — **no saving** |
| **reSID on a backend worker** | same quality, OFF the 20 ms budget — **yes** |

## 2. Timing fidelity — the producer must stamp writes

reSID is cycle-accurate: it needs each SID register write at its exact sub-frame
cycle, not just the end-of-frame register values. So the producer pushes
`(cycle, reg, value)` per `$D4xx` write (the CPU clock is in hand at the write
site), and a frame-boundary marker carrying the frame's end cycle. The worker
replays the writes at their cycle offsets and renders exactly `cyclesPerFrame`
worth of samples per boundary — identical synthesis to today's inline `flush()`.

## 3. Sync / latency — already absorbed (706)

Decoupling audio render from the video frame means the audio lags video by a few
frames (the worker drains async). This is fine: the browser AudioWorklet ring
already runs a 100–180 ms cushion (Spec 706). The current frame-lock is a design
choice, not a requirement; the cushion was built precisely so audio render timing
need not be frame-exact. No new latency the user can hear.

## 4. No real backpressure

The worker does ~2.1 ms of work per 20 ms budget on its own core — huge headroom,
keeps up trivially at 50 fps (and even at warp the ring buffers a burst). Audio
must NOT be lossy (a drop = an audible glitch), so the PCM ring is **no-drop**,
bounded; with the worker's headroom it never fills. (Contrast the 766 recorder,
which IS lossy/fps-first — audio is the opposite: never drop a sample.)

## 5. The real work — checkpoint/restore round-trip (705.A)

This is the fiddly part, not the ring. Scrub/rewind snapshots the reSID synthesis
state (Spec 705.A `AudioCheckpointProvider.snapshot/restore` — VICE-shaped state,
no register replay). With reSID in the worker, that state lives in the worker, so:

- **snapshot:** the controller must fetch the worker's reSID state (async
  request/response to the worker, like the recorder's query API). Snapshot capture
  is at an instruction boundary; the worker must be drained to the boundary first.
- **restore:** push the saved reSID state into the worker + flush its rings + the
  706.8 transport flush (drop pre-restore buffered audio, re-prebuffer). The worker
  must re-sync its replay clock to the restored machine clock.

This is the bulk of the effort and the main risk — get the boundary/flush ordering
right so a scrub doesn't desync audio.

## 6. Build slices

- **768.1** — SID write-stream: a shared ring (reuse `recorder-ring.ts` shapes) +
  a producer hook at the `$D4xx` write site that pushes `(cycle, reg, value)`;
  per-frame boundary marker. Gate: producer is zero-alloc / never blocks; the
  byte stream round-trips a known write sequence.
- **768.2** — `resid-worker.ts`: loads reSID-wasm, drains the write ring, replays
  timed writes, renders per-frame PCM into the audio PCM ring. Gate: worker PCM is
  byte-identical to the current inline `recorder.flush()` output for a fixed
  scenario (the fidelity bar — same samples, just off-thread).
- **768.3** — wire: emu thread stops calling `flush()`, spawns the worker, points
  the WS audio ship at the worker's PCM ring. Gate: probe-resid-cost shows the emu
  per-frame back to baseline (~14.7 ms); audio plays.
- **768.4** — checkpoint/restore round-trip (§5): worker reSID get/setState +
  drain-to-boundary on snapshot + flush+resync on restore. Gate: e2e-761 scrub +
  probe-705b/707 stay green WITH the worker; a scrub does not desync audio.
- **768.5** — perf + ear acceptance: live, EF game, stable ~50 fps WITH audio,
  no underrun/glitch over 60 s (user ear). The fps-dip bar.

## 7. Acceptance

- Emu per-frame cost with audio ON ≈ the no-audio baseline (probe-resid-cost:
  the A→B delta collapses from ~2.1 ms to ~0).
- reSID PCM byte-identical to today's inline render on the fidelity scenario
  (768.2) — no quality regression.
- Scrub/restore audio stays in sync (768.4); 705b/707/761 green.
- Live: stable 50 fps WITH audio, no audible glitch (768.5).

## 8. Open questions

- OQ1: one worker per session, or a shared audio worker for the single-machine
  process? (Single-machine-per-process → one worker is enough.)
- OQ2: warp mode — the worker must render the burst faster than realtime; does the
  no-drop PCM ring need to be sized for a warp burst, or is warp audio muted today?
  (Check the current warp-audio behaviour before sizing.)
- OQ3: does the SID write site already have a clean single choke point for the
  producer hook, or is it spread across memory-bus + sid.ts? (Audit before 768.1.)

Cross-link: [[project_resid_audio_architecture]] [[project_bug049_audio_stutter]]
[[project_spec766_runtime_recorder]] [[project_spec706_audio_latency]].
