// Spec 350 + 724B — One UI shell. Two backend transports, one project model:
//   - Runtime group (WS :4312): Live + Trace (live runtime workbench).
//   - Project group (HTTP /api): Knowledge + Trace Files (the SAME project the
//     LLM writes through MCP — findings/entities/dashboard + durable trace.duckdb
//     artifacts with the convenience-reader query panel).
// The project name/path comes from /api/config (the 724A resolver), never a
// hardcoded "Murder" or a repo/cwd assumption.

import React, { useEffect, useState } from "react";
import { getClient, type ConnectionState } from "./ws-client.js";
import { api } from "./rest-client.js";
import { LiveTab } from "./tabs/Live.js";
import { TraceTab } from "./tabs/Trace.js";
import { KnowledgeTab } from "./tabs/Knowledge.js";
import { TraceFilesTab } from "./tabs/TraceFiles.js";

const NAV = [
  { group: "Runtime", tabs: ["live", "trace"] },
  { group: "Project", tabs: ["knowledge", "trace-files"] },
] as const;
type Tab = "live" | "trace" | "knowledge" | "trace-files";
const LABEL: Record<Tab, string> = { live: "Live", trace: "Trace", knowledge: "Knowledge", "trace-files": "Trace Files" };

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [sessionId, setSessionId] = useState<string>("");
  const [cycle, setCycle] = useState<number>(0);
  const [runState, setRunState] = useState<"running" | "paused" | "off">("running");
  const [project, setProject] = useState<{ name?: string; path?: string }>({});

  useEffect(() => getClient().onState(setConn), []);

  // Project identity from the resolver (no hardcoded project).
  useEffect(() => {
    let alive = true;
    api.config()
      .then((c) => { if (alive) setProject({ path: c.defaultProjectDir }); return api.workspace(); })
      .then((w) => { if (alive) setProject((p) => ({ ...p, name: w.project?.name, path: w.project?.rootPath ?? p.path })); })
      .catch(() => { /* HTTP API may be absent in pure-WS dev — leave blank */ });
    return () => { alive = false; };
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
      try { const s = await getClient().call("session/state", { session_id: sessionId }); setCycle(s.c64Cycles ?? 0); } catch { /* ignore */ }
      if (alive) setTimeout(tick, 500);
    };
    tick();
    return () => { alive = false; };
  }, [conn, sessionId]);

  return (
    <div className="wb-app">
      <header className="wb-header">
        <span className="wb-title">C64RE Workbench</span>
        <span className="wb-meta">project: <strong>{project.name ?? "(none)"}</strong></span>
        {project.path && <span className="wb-meta" style={{ color: "#666", fontSize: 11 }} title={project.path}>{project.path}</span>}
        <span className="wb-meta">session: {sessionId || "(none)"}</span>
        <span className={`wb-conn wb-conn-${conn}`}>{conn}</span>
        <span className="wb-meta">{runState}</span>
        <span className="wb-meta">cycle: {cycle.toLocaleString()}</span>
      </header>
      <nav className="wb-tabs" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        {NAV.map((g) => (
          <span key={g.group} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginRight: 2 }}>{g.group}</span>
            {g.tabs.map((t) => (
              <button key={t} className={`wb-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t as Tab)}>
                {LABEL[t as Tab]}
              </button>
            ))}
          </span>
        ))}
      </nav>
      <main className="wb-main">
        {tab === "live" && <LiveTab sessionId={sessionId} setSessionId={setSessionId} runState={runState} setRunState={setRunState} />}
        {tab === "trace" && <TraceTab sessionId={sessionId} setSessionId={setSessionId} />}
        {tab === "knowledge" && <KnowledgeTab />}
        {tab === "trace-files" && <TraceFilesTab />}
      </main>
    </div>
  );
}
