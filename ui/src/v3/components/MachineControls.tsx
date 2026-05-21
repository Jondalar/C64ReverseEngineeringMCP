// Spec 351 — machine controls bar.
// Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp.
// Spec 701: Run/Pause/Step/Warp drive the BACKEND runtime loop via debug/*
// + session/set_pacing. The UI no longer owns the emulation clock.

import React, { useState } from "react";
import { getClient } from "../ws-client.js";

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
      <span className="wb-controls-spacer" />
      {runState === "running" && <span className="wb-fps">{fps} fps</span>}
    </div>
  );
}
