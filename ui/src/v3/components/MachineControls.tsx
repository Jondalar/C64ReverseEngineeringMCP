// Spec 351 — machine controls bar.
// Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp (placeholder).

import React from "react";
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
  // Reset = cold reset, keep powered. Equivalent to pressing the C64
  // RESET key (or SuperReset cart). Re-runs KERNAL boot to READY.
  const reset = async () => {
    if (!sessionId) return;
    await c.call("session/reset", { session_id: sessionId, video: "pal-default" });
    setRunState?.("running");
    onSnapshotTaken();
  };
  const togglePause = () => {
    if (runState === "off") return;
    setRunState?.(runState === "running" ? "paused" : "running");
  };
  const step = async () => {
    if (!sessionId) return;
    try { await c.call("session/step", { session_id: sessionId }); } catch { /* monitor TBD */ }
    onSnapshotTaken();
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
      <button disabled title="Warp (not yet implemented)">⏩ Warp</button>
      <span className="wb-controls-spacer" />
      {runState === "running" && <span className="wb-fps">{fps} fps</span>}
    </div>
  );
}
