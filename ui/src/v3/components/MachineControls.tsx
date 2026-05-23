// Spec 351 — machine controls bar.
// Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp.
// Spec 701: Run/Pause/Step/Warp drive the BACKEND runtime loop via debug/*
// + session/set_pacing. The UI no longer owns the emulation clock.

import React, { useEffect, useRef, useState } from "react";
import { getClient, BIN_TYPE_AUDIO_BUFFER } from "../ws-client.js";
import { WebAudioPlayer } from "../audio-player.js";

interface Props {
  sessionId: string;
  runState: "running" | "paused" | "off";
  setRunState?: (s: "running" | "paused" | "off") => void;
  fps: number;
  onSnapshotTaken: () => void;
}

export function MachineControls({ sessionId, runState, setRunState, fps, onSnapshotTaken }: Props): JSX.Element {
  const c = getClient();
  const [warp, setWarp] = useState(false);
  // Power = ON/OFF toggle (NOT reset).
  //   OFF → ON: simulate plugging in C64 = cold reset + start running.
  //   ON  → OFF: simulate unplugging = stop polling, freeze state.
  // Use Reset to restart without "unplugging".
  const powerToggle = async () => {
    if (!sessionId) return;
    if (runState === "off") {
      await c.call("session/reset", { session_id: sessionId, video: "pal-default" });
      setRunState?.("running");
      onSnapshotTaken();
    } else {
      setRunState?.("off");
    }
  };
  // Reset = SYS 64738 soft reset (jump to $FCE2 KERNAL reset vector),
  // exactly like pressing the C64 RESET key / SuperReset cart. Resets
  // the C64 only (not the drive), RAM preserved.
  const reset = async () => {
    if (!sessionId) return;
    await c.call("session/reset", { session_id: sessionId, mode: "soft" });
    setRunState?.("running");
    onSnapshotTaken();
  };
  const togglePause = () => {
    if (runState === "off") return;
    setRunState?.(runState === "running" ? "paused" : "running");
  };
  // Step = exactly one instruction via the backend loop (Spec 701 §6). The
  // backend broadcasts debug/stopped, which the Live tab uses to refresh.
  const step = async () => {
    if (!sessionId) return;
    try { await c.call("debug/step", { session_id: sessionId }); } catch { /* ignore */ }
    onSnapshotTaken();
  };
  // Warp = host pacing only (Spec 701 §5.3): unthrottled, same emulated
  // cycle order. Toggles the backend pacing mode; takes effect live.
  const toggleWarp = async () => {
    if (!sessionId) return;
    const next = !warp;
    setWarp(next);
    try { await c.call("session/set_pacing", { session_id: sessionId, mode: next ? "warp" : "pal" }); } catch { /* ignore */ }
  };
  const snapshot = async () => {
    if (!sessionId) return;
    try {
      const r = await c.call<{ id: string; path: string }>("session/snapshot_save", { session_id: sessionId });
      console.log("snapshot:", r.id, r.path);
    } catch (e) { console.error("snapshot:", e); }
    onSnapshotTaken();
  };

  // Spec 703 §8 — live SID audio, ON by default. Browsers gate the
  // AudioContext behind a user gesture, so we ARM on mount (subscribe + start
  // the backend pump + create a suspended context) and resume on the first
  // interaction anywhere; frames are dropped until then (no backlog). The
  // backend runs reSID (Spec 703) for the live stream.
  const [audioOn, setAudioOn] = useState(true);
  const playerRef = useRef<WebAudioPlayer | null>(null);
  const offBinRef = useRef<(() => void) | null>(null);
  const offFlushRef = useRef<(() => void) | null>(null); // Spec 706.8 audio/flush sub
  const userMutedRef = useRef(false); // once muted by hand, don't auto-rearm

  // `audioOn` is the user's PREFERENCE (default on), toggled only by the
  // button. The stream's live/teardown state is tracked by playerRef and is
  // independent of pause: when paused the machine emits no cycles, so audio is
  // naturally silent without tearing the stream down — it resumes on continue.
  const startAudio = async () => {
    if (!sessionId || playerRef.current) return;
    const player = new WebAudioPlayer();
    playerRef.current = player;
    player.arm(); // suspended context + resume-on-first-gesture
    // Backend streams reSID PCM (BIN_TYPE_AUDIO_BUFFER); feed the worklet ring.
    offBinRef.current = c.onBinary(BIN_TYPE_AUDIO_BUFFER, (frame) => player.push(frame.payload));
    // Spec 706.8 — on a RuntimeCheckpoint restore the backend flushes its audio
    // transport and emits audio/flush; drop the stale-timeline worklet ring +
    // re-prebuffer from the restored reSID state (no old-timeline playback).
    offFlushRef.current = c.onNotification("audio/flush", () => player.flush());
    try {
      await c.call("audio/start", { session_id: sessionId });
    } catch (e) {
      console.error("audio/start failed", e);
      await stopAudio();
    }
  };

  const stopAudio = async () => {
    if (sessionId) { try { await c.call("audio/stop", { session_id: sessionId }); } catch { /* ignore */ } }
    offBinRef.current?.();
    offBinRef.current = null;
    offFlushRef.current?.();
    offFlushRef.current = null;
    await playerRef.current?.close();
    playerRef.current = null;
  };

  const toggleAudio = async () => {
    if (!sessionId) return;
    if (audioOn) { userMutedRef.current = true; setAudioOn(false); await stopAudio(); return; }
    userMutedRef.current = false;
    setAudioOn(true);
    await playerRef.current?.resume(); // explicit click is a valid gesture
    await startAudio();
  };

  // Auto-arm when a powered session is present and audio is wanted. Power-off
  // tears the stream down (machine unplugged); pause does NOT (handled above).
  useEffect(() => {
    if (sessionId && runState !== "off" && audioOn && !userMutedRef.current && !playerRef.current) {
      void startAudio();
    } else if (runState === "off" && playerRef.current) {
      void stopAudio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, runState, audioOn]);

  // Tear down only on unmount or when the session itself changes.
  useEffect(() => {
    return () => { void stopAudio(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="wb-controls">
      <button
        onClick={powerToggle}
        className={runState === "off" ? "wb-power-off" : "wb-power-on"}
        title={runState === "off" ? "Power ON (cold boot)" : "Power OFF (unplug)"}
      >⏻ Power {runState === "off" ? "OFF" : "ON"}</button>
      <button onClick={reset} disabled={runState === "off"} title="Reset (RESTORE key / cold reset, machine stays powered)">↺ Reset</button>
      <button onClick={togglePause} disabled={runState === "off"} title="Run / Pause">
        {runState === "running" ? "⏸ Pause" : "▶ Run"}
      </button>
      <button onClick={step} disabled={runState !== "paused"} title="Step one instruction">⤳ Step</button>
      <button onClick={snapshot} title="Save snapshot">📷 Snapshot</button>
      <button
        onClick={toggleWarp}
        disabled={runState === "off"}
        className={warp ? "wb-warp-on" : ""}
        title="Warp (host pacing only — unthrottled, same emulated cycles)"
      >⏩ Warp{warp ? " ●" : ""}</button>
      <button
        onClick={toggleAudio}
        disabled={runState === "off"}
        className={audioOn ? "wb-audio-on" : ""}
        title={audioOn ? "Mute live SID audio" : "Play live SID audio (reSID)"}
      >{audioOn ? "🔊 Audio" : "🔇 Audio"}</button>
      <span className="wb-controls-spacer" />
      {runState === "running" && <span className="wb-fps">{fps} fps</span>}
    </div>
  );
}
