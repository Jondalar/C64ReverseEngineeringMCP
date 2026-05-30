// Spec 724B — Knowledge tab. Read-only view of the SAME project the LLM writes
// through MCP: project status/path, counts, findings, entities, and the
// build_project_dashboard view. Sourced from /api/workspace (one project model).
import React, { useEffect, useState } from "react";
import { api, type WorkspaceSnapshot } from "../rest-client.js";

const card: React.CSSProperties = { background: "#161616", borderRadius: 5, padding: 10, marginBottom: 10 };
const hdr: React.CSSProperties = { fontWeight: "bold", color: "#888", fontSize: 11, textTransform: "uppercase", marginBottom: 6 };

export function KnowledgeTab(): JSX.Element {
  const [snap, setSnap] = useState<WorkspaceSnapshot | null>(null);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.workspace().then((s) => { setSnap(s); setErr(""); }).catch((e) => setErr(String(e.message ?? e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading && !snap) return <div style={{ padding: 12, color: "#888" }}>Loading project…</div>;
  if (err) return <div style={{ padding: 12, color: "#d66" }}>Knowledge API error: {err}</div>;
  if (!snap) return <div style={{ padding: 12, color: "#888" }}>No project data.</div>;

  const c = snap.counts ?? {};
  const findings = snap.findings ?? [];
  const entities = snap.entities ?? [];
  const dashboard = snap.views?.projectDashboard;

  return (
    <div style={{ padding: 8, color: "#ccc", fontSize: 13, overflowY: "auto", height: "100%" }}>
      <div style={card}>
        <div style={hdr}>Project</div>
        <div><strong>{snap.project?.name ?? "(unnamed)"}</strong> — {snap.project?.status ?? "?"}</div>
        <div style={{ color: "#888", fontSize: 11, wordBreak: "break-all" }}>{snap.project?.rootPath ?? ""}</div>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, color: "#9ab" }}>
          {Object.entries(c).map(([k, v]) => <span key={k}>{k}: <strong style={{ color: "#cde" }}>{v}</strong></span>)}
        </div>
        <button onClick={load} style={{ marginTop: 8, fontSize: 11, padding: "2px 8px" }}>Refresh</button>
      </div>

      <div style={card}>
        <div style={hdr}>Findings ({findings.length})</div>
        {findings.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No findings yet.</div>}
        {findings.slice(0, 50).map((f) => (
          <div key={f.id} style={{ padding: "4px 0", borderBottom: "1px solid #222" }}>
            <span style={{ color: "#6a9f2f", fontSize: 10, marginRight: 6 }}>[{f.kind}/{f.status}]</span>
            <strong>{f.title}</strong>
            {f.summary && <div style={{ color: "#999", fontSize: 11 }}>{f.summary}</div>}
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={hdr}>Entities ({entities.length})</div>
        {entities.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No entities yet.</div>}
        {entities.slice(0, 50).map((e) => (
          <div key={e.id} style={{ padding: "3px 0", borderBottom: "1px solid #222" }}>
            <span style={{ color: "#8e59c9", fontSize: 10, marginRight: 6 }}>[{e.kind}]</span>
            <strong>{e.name}</strong>
            {e.summary && <span style={{ color: "#999", fontSize: 11 }}> — {e.summary}</span>}
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={hdr}>Dashboard view (build_project_dashboard)</div>
        {dashboard ? (
          <pre style={{ fontSize: 10, color: "#9ab", maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(dashboard, null, 2).slice(0, 4000)}
          </pre>
        ) : <div style={{ color: "#555", fontStyle: "italic" }}>No dashboard view built yet (run build_project_dashboard).</div>}
      </div>
    </div>
  );
}
