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
  // Power = ON/OFF toggle (NOT reset) — Spec 786, a first-class daemon primitive.
  //   OFF → ON: session/power {op:"on"} = full init (fresh machine, inserted
  //             media re-attached), comes up RUNNING. Recovers a wedged/JAMmed
  //             session inherently (it rebuilds the machine from scratch).
  //   ON  → OFF: session/power {op:"off"} = everything off, no live state. The
  //             daemon blanks the machine, drops the checkpoint ring + flushes
  //             audio server-side. (A DEAD DAEMON PROCESS is a different failure:
  //             the MCP-side stall-heal kills+respawns it; this button talks WS
  //             to the daemon, so it can only recycle the SESSION, not the process.)
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
      // OFF → ON: full power-on. probe is informational (power_on re-inits either way).
      const alive = await probeSession();
      if (!alive) console.warn("[power] session not responding — power-on will re-init it");
      try { await c.call("session/power", { session_id: sessionId, op: "on" }); } catch (e) { console.error("[power] on:", e); }
      // power_on comes up running server-side; also drive debug/run so the pump
      // pacing is armed (idempotent) and the loop can't sit paused.
      try { await c.call("debug/run", { session_id: sessionId, pacing: { mode: "pal" } }); } catch { /* ignore */ }
      setRunState?.("running");
      onSnapshotTaken();
    } else {
      // ON → OFF: real power-off. The daemon blanks the machine + drops the ring
      // (scrub bar empties) + flushes audio — no client-side cleanup needed.
      try { await c.call("session/power", { session_id: sessionId, op: "off" }); } catch (e) { console.error("[power] off:", e); }
      setRunState?.("off");
    }
  };
  // Reset = SYS 64738 soft reset (jump to $FCE2 KERNAL reset vector),
  // exactly like pressing the C64 RESET key / SuperReset cart. Resets
  // the C64 only (not the drive), RAM preserved.
  const reset = async () => {
    if (!sessionId) return;
    await c.call("session/reset", { session_id: sessionId, mode: "soft" });
    // Reset leaves the loop in whatever state it was; restart it so the machine
    // comes back RUNNING (no reliance on a run-state echo effect — that is gone).
    try { await c.call("debug/run", { session_id: sessionId, pacing: { mode: "pal" } }); } catch { /* ignore */ }
    setRunState?.("running");
    onSnapshotTaken();
  };
  const togglePause = async () => {
    if (runState === "off" || !sessionId) return;
    // The button is the COMMAND source — send the backend loop verb directly,
    // then mirror local state. (There is no run-state→backend echo effect; see
    // Live.tsx.) The debug/running|paused broadcast confirms it for every other
    // view (App-level button, MON pop-out).
    const next = runState === "running" ? "paused" : "running";
    try {
      if (next === "running") await c.call("debug/run", { session_id: sessionId, pacing: { mode: "pal" } });
      else await c.call("debug/pause", { session_id: sessionId });
    } catch { /* ignore */ }
    setRunState?.(next);
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
  // Spec 769.5 — the top button is "Dump" (a durable .c64re state dump), not a
  // camera screenshot. Dumps the current machine state (= the scrubbed-to anchor
  // when the user clicked a filmstrip frame, since that restores the machine).
  const snapshot = async () => {
    if (!sessionId) return;
    try {
      const path = `dumps/dump-${Date.now()}.c64re`;
      const r = await c.call<{ path: string; fileBytes: number }>("snapshot/dump", { session_id: sessionId, path });
      console.log("dump →", r.path, `(${r.fileBytes} bytes)`);
    } catch (e) { console.error("dump:", e); }
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
      >⏻ Power {runState === "off" ? "ON" : "OFF"}</button>
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
      <button onClick={reset} disabled={runState === "off"} title="Reset (RESET key → $FCE2 warm reset; RAM + media kept, machine stays powered)">↺ Reset</button>
      <button onClick={togglePause} disabled={runState === "off"} title="Run / Pause">
        {runState === "running" ? "⏸ Pause" : "▶ Run"}
      </button>
      <button onClick={step} disabled={runState !== "paused"} title="Step one instruction">⤳ Step</button>
      <button onClick={snapshot} title="Dump machine state to a durable .c64re file">⬇ Dump</button>
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
