import React, { useEffect, useState } from "react";
import { getClient, type ConnectionState } from "./ws-client.js";
import { LiveTab } from "./tabs/Live.js";
import { MonitorTab } from "./tabs/Monitor.js";
import { TraceTab } from "./tabs/Trace.js";
import { SnapshotsTab } from "./tabs/Snapshots.js";
import { ScenariosTab } from "./tabs/Scenarios.js";
import { MediaTab } from "./tabs/Media.js";
import { ExportTab } from "./tabs/Export.js";

const TABS = ["live", "monitor", "trace", "snapshots", "scenarios", "media", "export"] as const;
type Tab = typeof TABS[number];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [sessionId, setSessionId] = useState<string>("");
  const [cycle, setCycle] = useState<number>(0);

  useEffect(() => {
    const client = getClient();
    const offState = client.onState(setConn);
    return offState;
  }, []);

  // Auto-pick first session when WS opens (no session set yet).
  useEffect(() => {
    if (sessionId || conn !== "open") return;
    const client = getClient();
    client.call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [conn, sessionId]);

  // Poll session state every 500ms when connected.
  useEffect(() => {
    if (conn !== "open" || !sessionId) return;
    const client = getClient();
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await client.call("session/state", { session_id: sessionId });
        setCycle(s.c64Cycles ?? 0);
      } catch { /* ignore poll errors */ }
      if (alive) setTimeout(tick, 500);
    };
    tick();
    return () => { alive = false; };
  }, [conn, sessionId]);

  const renderTab = () => {
    const props = { sessionId, setSessionId };
    switch (tab) {
      case "live":      return <LiveTab {...props} />;
      case "monitor":   return <MonitorTab {...props} />;
      case "trace":     return <TraceTab {...props} />;
      case "snapshots": return <SnapshotsTab {...props} />;
      case "scenarios": return <ScenariosTab {...props} />;
      case "media":     return <MediaTab {...props} />;
      case "export":    return <ExportTab {...props} />;
    }
  };

  return (
    <div className="v3-app">
      <header className="v3-header">
        <span className="v3-title">C64RE V3</span>
        <span className={`v3-conn v3-conn-${conn}`}>{conn}</span>
        <span className="v3-session">session: {sessionId || "(none)"}</span>
        <span className="v3-cycle">cycle: {cycle.toLocaleString()}</span>
      </header>
      <nav className="v3-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`v3-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >{t}</button>
        ))}
      </nav>
      <main className="v3-main">{renderTab()}</main>
      <footer className="v3-footer">
        <span>localhost:4313 / ws:4312 — single user, no auth</span>
      </footer>
    </div>
  );
}
