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
import {
  MemoryMapTab, PayloadsTab, AnnotatedListingTab, FlowGraphTab,
  DiskTab, CartridgeTab, GraphicsTab, QuestionsTab, DocsTab,
} from "./tabs/ProjectViews.js";
import { AssetsTab } from "./tabs/Assets.js";

const NAV = [
  { group: "Runtime", tabs: ["live", "trace"] },
  { group: "Project", tabs: ["knowledge", "questions", "docs", "trace-files"] },
  { group: "Analysis", tabs: ["memory", "payloads", "listing", "flow"] },
  { group: "Media", tabs: ["disk", "cartridge", "graphics", "assets"] },
] as const;
type Tab = "live" | "trace" | "knowledge" | "questions" | "docs" | "trace-files"
  | "memory" | "payloads" | "listing" | "flow" | "disk" | "cartridge" | "graphics" | "assets";
const LABEL: Record<Tab, string> = {
  live: "Live", trace: "Trace", knowledge: "Knowledge", questions: "Questions", docs: "Docs",
  "trace-files": "Trace Files", memory: "Memory Map", payloads: "Payloads",
  listing: "Annotated Listing", flow: "Flow Graph", disk: "Disk", cartridge: "Cartridge", graphics: "Graphics",
  assets: "Assets / Scrub",
};

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [sessionId, setSessionId] = useState<string>("");
  const [cycle, setCycle] = useState<number>(0);
  const [runState, setRunState] = useState<"running" | "paused" | "off">("running");
  const [project, setProject] = useState<{ name?: string; path?: string }>({});
  const [runtimeHint, setRuntimeHint] = useState<string>("");

  useEffect(() => getClient().onState(setConn), []);

  // BUG-010: if the runtime WS backend is not connected, ask the HTTP API whether
  // it is reachable and surface an ACTIONABLE banner (which backend + how to start
  // it) instead of an endless "connecting". Clears once the WS connects.
  useEffect(() => {
    if (conn === "open") { setRuntimeHint(""); return; }
    let alive = true;
    const check = async () => {
      if (!alive) return;
      try {
        const s = await api.runtimeStatus();
        if (alive) setRuntimeHint(s.reachable ? "" : (s.hint ?? `Runtime backend not reachable at ${s.wsUrl}.`));
      } catch { if (alive) setRuntimeHint(""); }
      // Effect re-subscribes whenever `conn` changes (incl. → "open", which
      // returns early above), so a plain re-poll here is safe.
      if (alive) setTimeout(check, 3000);
    };
    // give the WS a moment to connect before nagging.
    const t = setTimeout(check, 1500);
    return () => { alive = false; clearTimeout(t); };
  }, [conn]);

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
      {runtimeHint && (
        <div style={{ background: "#3a1010", color: "#fbb", padding: "6px 12px", fontSize: 12, borderBottom: "1px solid #602020" }}>
          ⚠ Runtime backend not connected — the Live tab needs the Headless Runtime WS server.
          <span style={{ color: "#fdd", marginLeft: 6 }}>{runtimeHint}</span>
        </div>
      )}
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
        {tab === "questions" && <QuestionsTab />}
        {tab === "docs" && <DocsTab />}
        {tab === "trace-files" && <TraceFilesTab />}
        {tab === "memory" && <MemoryMapTab />}
        {tab === "payloads" && <PayloadsTab />}
        {tab === "listing" && <AnnotatedListingTab />}
        {tab === "flow" && <FlowGraphTab />}
        {tab === "disk" && <DiskTab />}
        {tab === "cartridge" && <CartridgeTab />}
        {tab === "graphics" && <GraphicsTab />}
        {tab === "assets" && <AssetsTab />}
      </main>
    </div>
  );
}
