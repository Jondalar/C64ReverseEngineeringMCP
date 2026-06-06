// Spec 351 — machine controls bar.
// Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp.
// Spec 701: Run/Pause/Step/Warp drive the BACKEND runtime loop via debug/*
// + session/set_pacing. The UI no longer owns the emulation clock.

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { getClient, BIN_TYPE_AUDIO_BUFFER } from "../ws-client.js";
import { WebAudioPlayer } from "../audio-player.js";

interface Props {
  sessionId: string;
  runState: "running" | "paused" | "off";
  setRunState?: (s: "running" | "paused" | "off") => void;
  fps: number;
  onSnapshotTaken: () => void;
  // BUG-018 (relocation) — optional status content rendered at the right of the
  // controls bar (next to Audio / fps). The v1 product passes the runtime
  // connection/session chip here; the standalone v3 shell omits it (it has its
  // own header status).
  statusSlot?: ReactNode;
}

export function MachineControls({ sessionId, runState, setRunState, fps, onSnapshotTaken, statusSlot }: Props): React.JSX.Element {
  const c = getClient();
  const [warp, setWarp] = useState(false);
  // Power = ON/OFF toggle (NOT reset).
  //   OFF → ON: simulate plugging in C64 = cold reset + start running.
  //   ON  → OFF: simulate unplugging = stop polling, freeze state.
  // Use Reset to restart without "unplugging".
  // Spec 746.x — Power = cold power-cycle, AND a session-recycle if the session is
  // wedged. A hung session won't answer session/state; we probe it with a short
  // timeout and, responsive or not, drive a cold reset (resetWarm via session/reset)
  // to recover — even from a JAMmed game / frozen loop. (A DEAD DAEMON PROCESS is a
  // different failure: the MCP-side stall-heal kills+respawns it; this button talks
  // WS to the daemon, so it can only recycle the SESSION, not the process.)
  const probeSession = async (timeoutMs = 2000): Promise<boolean> => {
    try {
      await Promise.race([
        c.call("session/state", { session_id: sessionId }),
        new Promise((_r, rej) => setTimeout(() => rej(new Error("probe timeout")), timeoutMs)),
      ]);
      return true;
    } catch { return false; }
  };
  const powerToggle = async () => {
    if (!sessionId) return;
    if (runState === "off") {
      // OFF → ON: cold power-cycle. If the session was wedged, the cold reset
      // recovers it; probe is informational (we reset either way).
      const alive = await probeSession();
      if (!alive) console.warn("[power] session not responding — recycling via cold reset");
      await c.call("session/reset", { session_id: sessionId, video: "pal-default" });
      setRunState?.("running");
      onSnapshotTaken();
    } else {
      // ON → OFF: stop polling. But if the session is WEDGED while "on" (frozen
      // screen, no frames), a plain OFF leaves it stuck — so recycle it with a cold
      // reset first, then mark off, so the next ON comes up clean.
      const alive = await probeSession();
      if (!alive) {
        console.warn("[power] session wedged — recycling (cold reset) before power-off");
        try { await c.call("session/reset", { session_id: sessionId, video: "pal-default" }); } catch { /* ignore */ }
        onSnapshotTaken();
      }
      setRunState?.("off");
      // Spec 761 — power-off drops the checkpoint ring (scrub bar empties).
      // Fire-and-forget: never await it, so an old daemon without the verb
      // can't hang the power toggle.
      c.call("checkpoint/clear", { session_id: sessionId }).catch(() => { /* ignore */ });
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

  // Spec 746.9 — Trace AN/AUS, the third control gate (UI + API + Monitor). Starts/
  // stops a streaming trace on the SHARED session (full domains: cpu + drive + iec +
  // memory). The default session is built producers-on (746.1), so a mid-session
  // start captures everything; the store path is daemon-resolved under runtime/<sess>/.
  const [tracing, setTracing] = useState(false);
  const [traceStore, setTraceStore] = useState<string>("");
  useEffect(() => {
    // reflect actual backend trace state on mount / session change.
    if (!sessionId) return;
    let alive = true;
    c.call<{ active?: boolean; outputPath?: string }>("trace/run/status", { session_id: sessionId })
      .then((s) => { if (alive) { setTracing(!!s?.active); if (s?.outputPath) setTraceStore(s.outputPath); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [sessionId]);
  const toggleTrace = async () => {
    if (!sessionId) return;
    try {
      if (tracing) {
        const r = await c.call<{ run?: { evidenceRef?: string } }>("trace/run/stop", { session_id: sessionId });
        setTracing(false);
        if (r?.run?.evidenceRef) setTraceStore(r.run.evidenceRef);
      } else {
        const r = await c.call<{ outputPath?: string }>("trace/start_domains", { session_id: sessionId, domains: ["c64-cpu", "drive8-cpu", "iec", "memory"] });
        setTracing(true);
        if (r?.outputPath) setTraceStore(r.outputPath);
      }
    } catch (e) { console.error("trace toggle:", e); }
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
      <button
        onClick={() => {
          if (!sessionId) return;
          // Spec 754 — open the monitor in a separate OS window (drag it to your
          // second screen). Same bundle, ?monitor=1 routes App → MonitorPopout.
          const url = `${window.location.pathname}?monitor=1&sessionId=${encodeURIComponent(sessionId)}`;
          window.open(url, `c64re_monitor_${sessionId}`, "width=820,height=640,left=20,top=80");
        }}
        disabled={!sessionId}
        title="Open the monitor in a separate window (drag it to a second screen)"
      >▣ MON</button>
      <button onClick={reset} disabled={runState === "off"} title="Reset (RESTORE key / cold reset, machine stays powered)">↺ Reset</button>
      <button onClick={togglePause} disabled={runState === "off"} title="Run / Pause">
        {runState === "running" ? "⏸ Pause" : "▶ Run"}
      </button>
      <button onClick={step} disabled={runState !== "paused"} title="Step one instruction">⤳ Step</button>
      <button onClick={snapshot} title="Save snapshot">📷 Snapshot</button>
      <button
        onClick={toggleTrace}
        disabled={runState === "off"}
        className={tracing ? "wb-trace-on" : ""}
        title={tracing ? `Stop trace${traceStore ? " → " + traceStore : ""}` : "Start trace (cpu+drive+iec+memory) on the live session"}
      >{tracing ? "⏺ Trace ●" : "⏺ Trace"}</button>
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
      {statusSlot}
    </div>
  );
}
