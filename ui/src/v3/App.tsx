// Spec 350 — Emulator Workbench master.
// 2 top-level tabs: Live + Trace. Other surfaces (scenarios, export,
// snapshots, media, monitor) folded into Live or removed entirely.

import React, { useEffect, useState } from "react";
import { getClient, type ConnectionState } from "./ws-client.js";
import { LiveTab } from "./tabs/Live.js";
import { TraceTab } from "./tabs/Trace.js";

const TABS = ["live", "trace"] as const;
type Tab = typeof TABS[number];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [sessionId, setSessionId] = useState<string>("");
  const [cycle, setCycle] = useState<number>(0);
  const [runState, setRunState] = useState<"running" | "paused">("running");

  useEffect(() => {
    const off = getClient().onState(setConn);
    return off;
  }, []);

  useEffect(() => {
    if (sessionId || conn !== "open") return;
    getClient().call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [conn, sessionId]);

  useEffect(() => {
    if (conn !== "open" || !sessionId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await getClient().call("session/state", { session_id: sessionId });
        setCycle(s.c64Cycles ?? 0);
      } catch { /* ignore poll errors */ }
      if (alive) setTimeout(tick, 500);
    };
    tick();
    return () => { alive = false; };
  }, [conn, sessionId]);

  const project = "Murder";  // TODO: derive from route/session

  return (
    <div className="wb-app">
      <header className="wb-header">
        <span className="wb-title">C64 Emulator</span>
        <span className="wb-meta">project: <strong>{project}</strong></span>
        <span className="wb-meta">session: {sessionId || "(none)"}</span>
        <span className={`wb-conn wb-conn-${conn}`}>{conn}</span>
        <span className="wb-meta">{runState}</span>
        <span className="wb-meta">cycle: {cycle.toLocaleString()}</span>
      </header>
      <nav className="wb-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`wb-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >{t}</button>
        ))}
      </nav>
      <main className="wb-main">
        {tab === "live"
          ? <LiveTab sessionId={sessionId} setSessionId={setSessionId} runState={runState} setRunState={setRunState} />
          : <TraceTab sessionId={sessionId} setSessionId={setSessionId} />}
      </main>
    </div>
  );
}
