// Spec 724B — Trace Files tab. Lists the project's durable trace.duckdb
// artifacts + their marks, and offers the convenience-reader query panel
// (info / top-pcs / events by channel/cycle/pc/addr). No raw SQL as the normal
// path — it calls the same readers the MCP trace_store_* tools use.
import React, { useEffect, useState, useCallback } from "react";
import { api, type TraceArtifact, type TraceInfo, type PcCount, type TraceEventRow } from "../rest-client.js";

const card: React.CSSProperties = { background: "#161616", borderRadius: 5, padding: 10, marginBottom: 10 };
const hdr: React.CSSProperties = { fontWeight: "bold", color: "#888", fontSize: 11, textTransform: "uppercase", marginBottom: 6 };
const hex = (n: number) => "$" + (n >>> 0).toString(16);

export function TraceFilesTab(): React.JSX.Element {
  const [traces, setTraces] = useState<TraceArtifact[]>([]);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<TraceArtifact | null>(null);
  const [info, setInfo] = useState<TraceInfo | null>(null);
  const [pcs, setPcs] = useState<PcCount[]>([]);
  const [events, setEvents] = useState<TraceEventRow[]>([]);
  const [family, setFamily] = useState("cpu_step");
  const [pcStart, setPcStart] = useState("");
  const [pcEnd, setPcEnd] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(() => {
    api.traces().then((r) => { setTraces(r.traces); setErr(""); }).catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(loadList, [loadList]);

  const selectTrace = useCallback(async (t: TraceArtifact) => {
    setSel(t); setInfo(null); setPcs([]); setEvents([]); setBusy(true);
    try {
      const i = await api.traceInfo(t.path);
      setInfo(i);
      const top = await api.traceTopPcs(t.path, "c64", 15);
      setPcs(top.pcs);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }, []);

  const runEvents = useCallback(async () => {
    if (!sel || !info?.meta.run_id) return;
    setBusy(true);
    try {
      const opts: Parameters<typeof api.traceEvents>[2] = { family, limit: 200 };
      const ps = parseInt(pcStart.replace(/^\$/, ""), 16), pe = parseInt(pcEnd.replace(/^\$/, ""), 16);
      if (!Number.isNaN(ps) && !Number.isNaN(pe)) { opts.pcStart = ps; opts.pcEnd = pe; }
      const r = await api.traceEvents(sel.path, info.meta.run_id, opts);
      setEvents(r.rows);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }, [sel, info, family, pcStart, pcEnd]);

  return (
    <div style={{ padding: 8, color: "#ccc", fontSize: 13, overflowY: "auto", height: "100%" }}>
      {err && <div style={{ color: "#d66", marginBottom: 8 }}>{err}</div>}

      <div style={card}>
        <div style={hdr}>Trace artifacts (project traces/)</div>
        {traces.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No trace.duckdb yet — capture one via the LLM (runtime_session_start trace_out=…).</div>}
        {traces.map((t) => (
          <div key={t.path} onClick={() => selectTrace(t)} style={{
            cursor: "pointer", padding: "5px 6px", borderRadius: 3,
            background: sel?.path === t.path ? "#1d2a3a" : "transparent", borderBottom: "1px solid #222",
          }}>
            <strong>{t.name}</strong>
            <span style={{ color: "#888", fontSize: 11, marginLeft: 8 }}>{(t.sizeBytes / 1048576).toFixed(1)}MB</span>
            {t.events !== undefined && <span style={{ color: "#9ab", fontSize: 11, marginLeft: 8 }}>{t.events.toLocaleString()} events</span>}
            {t.runId && <span style={{ color: "#666", fontSize: 10, marginLeft: 8 }}>{t.runId}</span>}
            {t.marks && t.marks.length > 0 && (
              <div style={{ marginTop: 2 }}>
                {t.marks.map((m) => (
                  <span key={m.label} title={`cycle ${m.cycle}`} style={{ display: "inline-block", marginRight: 6, fontSize: 10, padding: "0 5px", background: "#234", borderRadius: 3, color: "#cde" }}>
                    {m.label}
                  </span>
                ))}
              </div>
            )}
            {t.error && <div style={{ color: "#d66", fontSize: 11 }}>{t.error}</div>}
          </div>
        ))}
        <button onClick={loadList} style={{ marginTop: 8, fontSize: 11, padding: "2px 8px" }}>Refresh</button>
      </div>

      {sel && (
        <div style={card}>
          <div style={hdr}>Info — {sel.name}</div>
          {busy && !info && <div style={{ color: "#888" }}>reading…</div>}
          {info && (
            <>
              <div style={{ fontSize: 11, color: "#9ab", marginBottom: 6 }}>
                schema: {info.meta.schema} · run: {info.meta.run_id}
                {info.masterClockRange && <> · cycles {info.masterClockRange.min}…{info.masterClockRange.max}</>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11 }}>
                {Object.entries(info.tableCounts).map(([k, v]) => <span key={k}>{k}: <strong style={{ color: "#cde" }}>{v.toLocaleString()}</strong></span>)}
              </div>
            </>
          )}
        </div>
      )}

      {pcs.length > 0 && (
        <div style={card}>
          <div style={hdr}>Top PCs (c64)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {pcs.map((p) => (
              <span key={p.pc} style={{ fontSize: 11, padding: "1px 6px", background: "#222", borderRadius: 3 }}>
                {hex(p.pc)} <span style={{ color: "#888" }}>×{p.count.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {sel && info?.meta.run_id && (
        <div style={card}>
          <div style={hdr}>Event query (convenience reader — no raw SQL)</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ fontSize: 11 }}>family
              <select value={family} onChange={(e) => setFamily(e.target.value)} style={{ marginLeft: 4 }}>
                {["cpu_step", "mem_read", "mem_write", "drive_atn_change", "drive_clk_change", "drive_data_change"].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11 }}>pc $<input value={pcStart} onChange={(e) => setPcStart(e.target.value)} placeholder="e000" style={{ width: 56 }} /></label>
            <label style={{ fontSize: 11 }}>…$<input value={pcEnd} onChange={(e) => setPcEnd(e.target.value)} placeholder="ffff" style={{ width: 56 }} /></label>
            <button onClick={runEvents} disabled={busy} style={{ fontSize: 11, padding: "2px 8px" }}>Query</button>
          </div>
          {events.length > 0 && (
            <pre style={{ fontSize: 10, color: "#9ab", maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(events.slice(0, 50), null, 1).slice(0, 6000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
