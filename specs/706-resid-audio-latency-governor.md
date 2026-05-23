# Spec 706 — reSID Audio Latency Governor

**Status:** DONE (2026-05-23) — headless gates green + user live-UI sign-off ("audio perfect from the timing"). See §10. (706.8 live verification still waits on 705.B's restore trigger; mechanism headless-proven.)
**Parent spec:** `specs/703-sid-resid-wasm-audio.md` (reSID WASM audio, MERGED master `fb27a7d`).
**Branch:** `claude/706-audio-latency-governor` (fresh from master 137389d).
**Scope:** the live SID audio stream path — backend reSID render → WS transport → browser AudioWorklet playback. Latency only. No codec / quality / engine changes.

## 1. Why this spec exists

reSID live audio is **glitch-free** (Spec 703 §8 ring buffer fixed the stutter) but runs **~2 s behind** the UI. The pipeline is a deep FIFO with no realtime anchoring: any moment the backend produces audio ahead of realtime drain (startup burst, fastloader CPU catch-up, loop briefly >1×, WS hiccup) banks samples that then become **permanent** latency — nothing downstream fast-forwards, the FIFO only drops at hard overflow.

**Asymmetry vs video (root design flaw):** video uses "latest frame wins" — `broadcastFrame` drops a frame when `ws.bufferedAmount > maxBuffered`, so video stays current. Audio uses `broadcastBinary` with NO backpressure and a deep FIFO, so it accumulates.

```
broadcastFrame (video):   if (ws.bufferedAmount > maxBuffered) continue;  // DROP → latest-wins
broadcastBinary (audio):  ws.send(buf)                                    // always → accumulates
```

## 2. Measured pipeline depth (2026-05-20 analysis, master)

| Stage | Capacity | File |
|---|---|---|
| SidAudioRecorder buffer | **65536 samples = 1.48 s** | `src/runtime/headless/audio/sid-audio-recorder.ts:50` (`bufferSamples ?? 65536`) |
| WS send buffer (audio) | **unbounded** (no `bufferedAmount` check) | `src/workspace-ui/v3-ws-server.ts:160` `broadcastBinary` |
| Worklet ring | 1.0 s cap; drops oldest only on hard overflow | `ui/src/v3/resid-worklet.js:18` (`ringFrames || 44100`) |

Sum ≈ 1.48 + WS + 1.0 ≈ **2.5 s** worst-case → matches the observed ~2 s.

Prebuffer (`PREBUFFER_SEC = 0.25` in `audio-player.ts:14`) is fine and stays.

## 3. Mechanism

- Backend renders reSID per emulated frame: `controller.onAudioFrame` → `recorder.flush()` → reads ALL available samples → ships all (`v3-ws-server.ts:712-719`).
- At perfect realtime (PAL 50 fps ≈ 882 samples/frame @ 1×): produce == drain, no buildup.
- Any transient lead → recorder banks up to 1.48 s → one `onAudioFrame` ships the whole backlog → worklet ring fills → latency becomes permanent (FIFO never catches up; only drops at the 1 s hard cap).
- The deep recorder buffer is the primary enabler of banking.

## 4. Fix — latency governor ("stay current" over "play every sample")

Treat audio like video: favor staying current. reSID is rendered fresh on the backend, so dropping/fast-forwarding stale samples = staying in sync with video + input, no quality loss.

### 4.1 Fix A — shrink recorder buffer (cap banking at the source)

- `SidAudioRecorder` `bufferSamples` default 65536 → small realtime value (~3-4 PAL frames ≈ 3500 samples ≈ 80 ms).
- Keep the larger buffer ONLY for the offline export path (`AudioExportSession` / `runtime_audio_export`), which legitimately needs to bank — make buffer size a per-use option, small for live, large for export.

### 4.2 Fix B — worklet latency governor (the core fix)

In `resid-worklet.js` `process()`:
- Target steady-state fill = `targetFrames` (≈ prebuffer, ~100 ms = 4410 frames).
- When `avail > targetFrames + margin` (margin ≈ 50 ms), fast-forward `read` to trim `avail` back toward `targetFrames` (drop oldest, exactly like video drops frames).
- Trim smoothly (skip in the read step, not a hard jump) to avoid an audible click — or accept a single tiny skip since stale audio is being discarded anyway.
- Underrun behavior unchanged (emit silence, keep playing on arrival — Spec 703 §8).

### 4.3 Fix C — audio backpressure in broadcastBinary (belt + braces)

- If `ws.bufferedAmount` exceeds ~200 ms of audio, the consumer is behind. Do NOT silently drop a packet (gap). Instead cap how much the recorder ships per frame, or coalesce — prevent WS-buffer growth without creating discontinuities.
- Simplest: bound recorder read-per-frame to a few frames; Fix A largely subsumes this.

## 5. Acceptance

1. **End-to-end latency < 150 ms** steady-state, measured: timestamp a backend audio frame → measure when its samples reach `ctx.currentTime` playback. Report the number.
2. **No stutter regression:** the Spec 703 §8 glitch-free property holds — boot + fastloader (motm / a fastloader title) plays continuous audio, no clicks/gaps, across a 60 s run.
3. **Recovery:** after an induced 1 s backend stall (fastloader CPU spike), audio re-syncs to < 150 ms latency within ~1 s, NOT a permanent 1 s offset.
4. **Export path unaffected:** `runtime_audio_export` / WAV output still renders full-fidelity, no dropped samples (offline path keeps the large buffer).
5. **Video/audio sync:** audio within ~100 ms of the corresponding video frame (perceptually locked).

## 6. Out of scope

- reSID engine / WASM / filter accuracy (Spec 703 core).
- Codec / compression of the audio stream.
- Multi-session audio mixing.
- The offline export buffering (only made a separate option, not redesigned).
- Video frame path (already latest-wins).

## 7. Tasks

| ID | Task | Priority | Depends | Status |
|---|---|---|---|---|
| 706.1 | Add end-to-end latency probe (backend send-timestamp → worklet playback-time) + log/report. Establishes the baseline number BEFORE fixing. | P0 | none | DONE — `scripts/probe-706-latency.mjs` |
| 706.2 | Fix A — `bufferSamples` per-use: small (~80 ms) for live stream, large for export. | P0 | 706.1 | DONE — `LIVE_RECORDER_BUFFER_SAMPLES` / `EXPORT_RECORDER_BUFFER_SAMPLES` |
| 706.3 | Fix B — worklet latency governor: target ~100 ms, fast-forward when `avail > target + margin`. | P0 | 706.1 | DONE — `resid-worklet.js` + `audio-player.ts` |
| 706.4 | Fix C — broadcastBinary backpressure / recorder read-per-frame bound. | P1 | 706.2 | DONE — `broadcastAudio` + `MAX_AUDIO_SHIP_SAMPLES` |
| 706.5 | Verify acceptance §5 #1-#5. Report measured latency before/after. | P0 | 706.2 + 706.3 + 706.4 | DONE — #1/#3/#4 headless, #2/#5 user-confirmed |
| 706.6 | Regression: 60 s motm + fastloader audio run, no stutter (Spec 703 §8 hold). | P0 | 706.5 | DONE — user: "audio perfect from the timing" |
| 706.7 | Memory note + close. | P0 | 706.6 | DONE |
| 706.8 | Restore/resume re-sync (see §9): on RuntimeCheckpoint restore, flush recorder buffer + WS audio send + worklet ring, then re-prebuffer fresh PCM from the restored reSID synthesis state. | P0 | 706.2 + 706.3 | DONE — `onRestore`→`audio/flush`→worklet flush; `probe-706-restore-resync.mjs` |

## 9. Restore/Resume Re-Sync (contract from Spec 705.A step 4)

Spec 705.A step 4 owns the **VICE-shaped reSID SYNTHESIS state** and its
checkpoint/restore (`ResidWasm.captureResidState/restoreResidState` over the
WASM `resid_read_state/write_state` = reSID `SID::State`;
`SidAudioRecorder.snapshot/restore`). Spec 706 owns the **live transport**
(recorder buffer, WS backpressure, worklet FIFO/governor). They meet at
restore:

- **reSID synthesis state = machine state** → captured in the native
  RuntimeCheckpoint (`RuntimeCheckpoint.audio`, when a recorder is registered).
- **Buffered, not-yet-played PCM (recorder ring + WS send buffer + worklet
  FIFO) = presentation/transport state** → NOT in the checkpoint. On restore it
  is **invalidated/flushed** and re-buffered from the restored reSID synthesis
  state (`SidAudioRecorder.restore` already calls `buffer.clear()`;
  `AudioRingBuffer.clear()` added in step 4).
- This mirrors VICE: reSID synthesis is serialized; the output/host buffer is
  separate (`sound_snapshot_prepare/finish`). Raw resampled PCM is therefore
  NOT byte-identical across restore (resampler sub-sample phase + FIR warmup) —
  it is the same waveform; the synthesis state is restored byte-identical.

706.8 extends the governor/transport so that on restore the WS audio send queue
+ worklet ring are also flushed and a fresh prebuffer is established, so audio
re-syncs to the restored runtime instead of replaying stale pre-restore PCM.

## 8. References

- `specs/703-sid-resid-wasm-audio.md` — reSID WASM audio (parent).
- `ui/src/v3/resid-worklet.js` — playback ring (Fix B target).
- `ui/src/v3/audio-player.ts` — worklet host, prebuffer 0.25 s.
- `src/workspace-ui/v3-ws-server.ts` — `broadcastBinary` (Fix C), `onAudioFrame` hook (lines 690-722).
- `src/runtime/headless/audio/sid-audio-recorder.ts` — recorder buffer 65536 (Fix A target, line 50).
- Memory: `project_resid_audio_architecture.md` — reSID renders on backend per-frame; browser plays via AudioWorklet ring.
- `specs/701-*` — autonomous runtime loop (frame pacing context).

## 10. Result (2026-05-23, branch `claude/706-audio-latency-governor`)

**Implemented (all four fixes + restore re-sync):**

| Fix | Where | Change |
|---|---|---|
| A | `src/runtime/headless/audio/sid-audio-recorder.ts` | `LIVE_RECORDER_BUFFER_SAMPLES = 3528` (→4096 pow2, ~93 ms) for the live stream; `EXPORT_RECORDER_BUFFER_SAMPLES = 65536` kept for offline export. `v3-ws-server` `audio/start` uses LIVE; `AudioExportSession` pins EXPORT. |
| B | `ui/src/v3/resid-worklet.js`, `ui/src/v3/audio-player.ts` | Governor in `process()`: trim ring to `governorTarget` when `avail > target + margin` (drop oldest = stale). Prebuffer 0.25→0.12 s, target 100 ms, margin 50 ms. |
| C | `src/workspace-ui/v3-ws-server.ts` | `broadcastAudio` with per-frame ship bound `MAX_AUDIO_SHIP_SAMPLES = 1764` (defers, no gap) + `AUDIO_WS_HIGH_WATER_BYTES` skip for a genuinely stuck socket only. |
| 706.8 | recorder `onRestore` → `audio/flush` broadcast → `WebAudioPlayer.flush()` → worklet `{type:"flush"}` | On RuntimeCheckpoint restore: recorder ring `clear()`, WS seq reset + new stream epoch, worklet ring dropped + prebuffer re-armed. No change to the green RuntimeCheckpoint machine contract (705.A). |

**Headless gates (GREEN):**

- `probe:706-latency` (§5 #1+#3): BEFORE 1 s stall→catch-up pins the worklet
  ring at its 980 ms hard cap and **never** recovers ≤150 ms (permanent — the
  §3 bug). AFTER: steady 100 ms / 113 ms post-stall, recovers ≤150 ms in 1
  frame (20 ms). 5/5.
- `probe:706-restore-resync` (706.8): recorder ring flushed, `onRestore` fires
  once, worklet flush empties + re-arms → only post-restore PCM plays. 4/4.
- §5 #4 export full-fidelity: large buffer preserved, 2 s export = 88206 ≈
  88200 samples (0.01 % drift), no drops.
- 705.A regression all GREEN: checkpoint 8/8, core 13/13, drive 8/8, reSID 7/7.
- `runtime:proof` 7-game gate: see commit (audio-transport-only change).

**Pending live-UI sign-off (user "gut/nicht gut"):** §5 #2 (60 s motm +
fastloader, no stutter — Spec 703 §8 holds) and §5 #5 (audio within ~100 ms of
video). These are perceptual and only measurable on the real browser audio
pipeline; the worklet governor + 120 ms prebuffer are the relevant tunables if
underrun appears.
