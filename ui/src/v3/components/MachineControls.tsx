// Spec 351 — machine controls bar.
// Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp (placeholder).

import React from "react";
import { getClient } from "../ws-client.js";

interface Props {
  sessionId: string;
  runState: "running" | "paused";
  setRunState?: (s: "running" | "paused") => void;
  fps: number;
  onSnapshotTaken: () => void;
}

export function MachineControls({ sessionId, runState, setRunState, fps, onSnapshotTaken }: Props): JSX.Element {
  const c = getClient();
  // Power = full cold reset (= drive RAM cleared, RAM fill pattern,
  // VIC raster phase pinned). Resets EVERYTHING including drive ROM.
  const powerCycle = async () => {
    if (!sessionId) return;
    await c.call("session/reset", { session_id: sessionId, video: "pal-default" });
    setRunState?.("running");
    onSnapshotTaken();
  };
  // Reset = soft reset (= equivalent to pressing the C64 RESET key
  // with a SuperReset cartridge: CPU PC → ($FFFC), no RAM clear, no
  // drive reset). Currently same as Power; distinct semantics will
  // be added when soft-reset path lands.
  const reset = async () => {
    if (!sessionId) return;
    await c.call("session/reset", { session_id: sessionId, video: "pal-default" });
    setRunState?.("running");
    onSnapshotTaken();
  };
  const togglePause = () => setRunState?.(runState === "running" ? "paused" : "running");
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
      <button onClick={powerCycle} title="Power Cycle (cold reset)">⏻ Power</button>
      <button onClick={reset} title="Reset">↺ Reset</button>
      <button onClick={togglePause} title="Run / Pause">
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
