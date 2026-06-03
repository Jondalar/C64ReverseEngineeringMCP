// Spec 754 — MON pop-out window. The MachineControls "MON" button does
// window.open(`?monitor=1&sessionId=<id>`); App.tsx routes that query to this
// standalone view (same bundle, separate OS window the user can drag to a second
// screen). It is its own JS context, so it makes its own WS client to the same
// ws://127.0.0.1:4312 and the same already-running daemon session — no cross-window
// state sync needed (the daemon is the source of truth). The main window's
// bottom-strip monitor keeps working independently.
import React, { useEffect, useState } from "react";
import { getClient, type ConnectionState } from "../ws-client.js";
import { MonitorPanel } from "./MonitorPanel.js";

type BpSignal = { pc: number; num: number; registers: string; seq: number };

export function MonitorPopout({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [bp, setBp] = useState<BpSignal | null>(null);

  useEffect(() => { document.title = sessionId ? `Monitor — ${sessionId}` : "C64RE Monitor"; }, [sessionId]);
  useEffect(() => getClient().onState(setConn), []);

  // Same breakpoint signal the LiveTab listens for (debug/breakpoint_hit) — so a
  // hit in the popped monitor prints "#n BREAK at $…" + focuses the input.
  useEffect(() => {
    if (!sessionId) return;
    const off = getClient().onNotification("debug/breakpoint_hit", (p: { session_id?: string; pc: number; num: number; registers: string }) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      setBp({ pc: p.pc, num: p.num, registers: p.registers, seq: Date.now() });
    });
    return off;
  }, [sessionId]);

  return (
    <div className="wb-monitor-popout" style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 0 }}>
      <div className="wb-monitor-popout-head" style={{ padding: "6px 10px", borderBottom: "1px solid var(--c64-blue, #335)", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>C64RE Monitor — session <b>{sessionId || "—"}</b></span>
        <span style={{ color: conn === "open" ? "var(--c64-green, #6c6)" : "#f88" }}>WS {conn}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {sessionId
          ? <MonitorPanel sessionId={sessionId} maximized={true} onToggleMax={() => { /* popped = always full */ }} breakpoint={bp} />
          : <div style={{ padding: 12, color: "#888" }}>no sessionId in URL (expected <code>?monitor=1&amp;sessionId=…</code>)</div>}
      </div>
    </div>
  );
}
