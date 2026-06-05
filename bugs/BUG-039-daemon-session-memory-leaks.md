# BUG-039 — Daemon per-session memory leaks (checkpoint pins + uncleared session maps)

- **ID:** BUG-039
- **Date:** 2026-06-05
- **Reporter:** llm (leak-hunt workflow, triggered by a user FPS-drop concern)
- **Area:** runtime / checkpoint-ring / ws-server / session lifecycle
- **Severity:** medium (real unbounded growth; not crash-level on a 24 GB host, not the FPS cause)
- **Status:** fixed

## Context
User reported FPS dropped 51→45 (audio-on) "since 02.06". Investigated:
**the FPS drop is NOT memory/code** — raw emulation is identical (272b88e0 14.63 ms/frame
vs HEAD 13.97, worktree bisect), the audio/reSID/present path is unchanged since 02.06,
heap/RSS plateau flat over 12k frames, and the host has 24 GB. The drop is environmental
(thermal/background-load after a laptop crash). BUT the leak-hunt that ruled memory out
found four genuine unbounded-growth vectors, fixed here.

## Leaks found (4-agent adversarial hunt; 3 surfaces clean: trace path, present/audio, observer logs)

1. **Media-ingress checkpoint pins never released (the real one).** Every media op
   (disk swap / PRG load / CRT attach) pins the before+after checkpoints
   (`ingress.ts:244-245`) so the media-event history stays replayable — but nothing
   ever unpins them. Each op locks ~400 KB×2 (+ pooled disk image) in the 128 MiB
   ring, **immune to eviction**. `runtime_swap_disk_and_continue` (new) does
   eject+mount = 2 ops/swap → accelerates it. `undump` cleared `mediaEvents` without
   unpinning (`snapshot-persistence.ts:173-177`).
2. **`disposeMonitorShellState` never called.** The function (clears the monitor-shell
   per-session maps bankDefaults/sidefxOn/dfWalks/fsShellCwd/asmCursors) existed but
   no code path called it → one set leaks per closed session.
3. **ws-server `monitorDisasmAddr`/`monitorMemAddr`** not deleted on `session/close`.
4. **ws-server `inspectEvidence`** (frozen-inspect promote list) not cleared on close.

(2-4 only grow on session CHURN, negligible on the stable single-session daemon, but
real + cheap to fix.)

## Fix
1. **ingress.ts** — keep only the last `PINNED_MEDIA_EVENTS` (16) events' checkpoints
   pinned; unpin the checkpoints of the event that falls out of the window.
   **snapshot-persistence.ts** — unpin the outgoing events' checkpoints before
   clearing `mediaEvents` on undump.
2. **runtime-session-service.ts `close()`** — call `disposeMonitorShellState(sessionId)`.
3-4. **ws-server `session/close`** — `monitorDisasmAddr.delete` / `monitorMemAddr.delete`
   / `inspectEvidence.delete` for the closing session.

## Gate
`e2e:checkpoint-pin-leak` 3/3 — 160 media ops, pinned stays 24→24 (windowed, does NOT
grow with op count), recent anchors preserved. No regression: `probe:single-path` 25/25,
`probe:709-12` 17/17 (ingress/eject), `probe:707-dump-undump` 10/10 (undump), `e2e:bug027-swap`
8/8.

## Resolution
- **Root cause:** pins/maps with no release on their natural end-of-life (window roll-off,
  undump, session close).
- **Regression risk:** low — windowing only unpins beyond a 16-event window (replay anchors
  for recent ops preserved); the close-path deletes are for state owned by the closing session.
- **Note:** bounded-but-heavy residents (checkpoint ring 128 MiB, trace chunk pool 256 MiB)
  are correctly capped — fine on 24 GB, could pressure a low-RAM host.
