// Spec 724B.2 — read-only v3 views for the remaining v1 screens. Each renders a
// view model already produced by the backend (the /api/workspace snapshot views
// + /api/docs + /api/graphics) — the SAME project the LLM writes via MCP. These
// are viewers, not v1's interactive editors (Scrub / in-place annotate stay v1).
import React, { useEffect, useState, useCallback } from "react";
import { api, type WorkspaceSnapshot, type DocEntry, type GraphicsItem } from "../rest-client.js";

const card: React.CSSProperties = { background: "#161616", borderRadius: 5, padding: 10, marginBottom: 10 };
const hdr: React.CSSProperties = { fontWeight: "bold", color: "#888", fontSize: 11, textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" };
const wrap: React.CSSProperties = { padding: 8, color: "#ccc", fontSize: 13, overflowY: "auto", height: "100%" };
const th: React.CSSProperties = { textAlign: "left", color: "#777", fontWeight: "normal", fontSize: 10, textTransform: "uppercase", padding: "2px 8px 4px 0", borderBottom: "1px solid #2a2a2a" };
const td: React.CSSProperties = { padding: "2px 8px 2px 0", borderBottom: "1px solid #1d1d1d", verticalAlign: "top" };
const hex = (n: number, w = 4) => "$" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const bytes = (n?: number) => n === undefined ? "—" : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`;

// A structured card with an optional raw-JSON details toggle (debug only).
function Panel({ title, count, raw, children }: { title: string; count?: number; raw?: unknown; children: React.ReactNode }): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div style={card}>
      <div style={hdr}>
        <span>{title}{count !== undefined ? ` (${count})` : ""}</span>
        {raw !== undefined && raw !== null && (
          <button onClick={() => setShowRaw((v) => !v)} style={{ fontSize: 9, padding: "1px 6px", color: "#888" }}>
            {showRaw ? "hide raw" : "raw JSON"}
          </button>
        )}
      </div>
      {children}
      {showRaw && (
        <pre style={{ fontSize: 10, color: "#789", maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", marginTop: 8, borderTop: "1px solid #222", paddingTop: 6 }}>
          {JSON.stringify(raw, null, 2).slice(0, 20000)}
        </pre>
      )}
    </div>
  );
}

const empty = (msg: string) => <div style={{ color: "#555", fontStyle: "italic" }}>{msg}</div>;
const confBar = (c?: number) => c === undefined ? null : (
  <span style={{ display: "inline-block", width: 36, height: 6, background: "#222", borderRadius: 3, overflow: "hidden", verticalAlign: "middle" }}>
    <span style={{ display: "block", height: "100%", width: `${Math.round(c * 100)}%`, background: c > 0.66 ? "#6a9f2f" : c > 0.33 ? "#d4a000" : "#a55" }} />
  </span>
);

function useSnapshot(): { snap: WorkspaceSnapshot | null; err: string; reload: () => void } {
  const [snap, setSnap] = useState<WorkspaceSnapshot | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(() => { api.workspace().then((s) => { setSnap(s); setErr(""); }).catch((e) => setErr(String(e.message ?? e))); }, []);
  useEffect(reload, [reload]);
  return { snap, err, reload };
}

// ---- Analysis group ----

export function MemoryMapTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const view = snap?.views?.memoryMap;
  const regions = view?.regions ?? [];
  return (
    <div style={wrap}>
      <Panel title="Memory Map regions" count={regions.length} raw={view}>
        {regions.length === 0 ? empty("No memory-map view yet — run build_memory_map.") : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr><th style={th}>range</th><th style={th}>title</th><th style={th}>kind</th><th style={th}>status</th><th style={th}>conf</th></tr></thead>
            <tbody>
              {[...regions].sort((a, b) => a.start - b.start).map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, fontFamily: "monospace", color: "#9ab", whiteSpace: "nowrap" }}>{hex(r.start)}–{hex(r.end)}</td>
                  <td style={td}><strong>{r.title}</strong>{r.summary && <div style={{ color: "#888", fontSize: 11 }}>{r.summary}</div>}</td>
                  <td style={{ ...td, color: "#bca" }}>{r.kind}</td>
                  <td style={{ ...td, color: "#999" }}>{r.status}</td>
                  <td style={td}>{confBar(r.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

export function PayloadsTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const payloads = (snap?.artifacts ?? []).filter((a) => ["prg", "payload", "raw"].includes(a.kind));
  return (
    <div style={wrap}>
      <Panel title="Payloads" count={payloads.length} raw={payloads}>
        {payloads.length === 0 ? empty("No payload artifacts.") : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr><th style={th}>kind</th><th style={th}>title</th><th style={th}>status</th><th style={th}>path</th></tr></thead>
            <tbody>
              {payloads.map((p) => (
                <tr key={p.id}>
                  <td style={{ ...td, color: "#6a9f2f" }}>{p.kind}</td>
                  <td style={td}><strong>{p.title}</strong></td>
                  <td style={{ ...td, color: "#999" }}>{p.status ?? "—"}</td>
                  <td style={{ ...td, color: "#666", fontFamily: "monospace", fontSize: 11 }}>{p.relativePath ?? p.path ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Load sequence" raw={snap?.views?.loadSequence}>
        {empty("Load sequence detail is in the raw view (build_load_sequence_view).")}
      </Panel>
    </div>
  );
}

export function AnnotatedListingTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const view = snap?.views?.annotatedListing;
  const entries = view?.entries ?? [];
  return (
    <div style={wrap}>
      <Panel title="Annotated listing" count={entries.length} raw={view}>
        {entries.length === 0 ? empty("No annotated-listing view yet — run build_annotated_listing_view.") : (
          <div style={{ fontFamily: "monospace", fontSize: 12 }}>
            {[...entries].sort((a, b) => a.start - b.start).map((e, i) => (
              <div key={e.id ?? i} style={{ padding: "3px 0", borderBottom: "1px solid #1d1d1d" }}>
                <span style={{ color: "#9ab" }}>{hex(e.start)}–{hex(e.end)}</span>{" "}
                <span style={{ color: "#d4a000", fontSize: 10 }}>[{e.kind}/{e.status}]</span>{" "}
                <strong style={{ color: "#ddd" }}>{e.title}</strong>
                {e.comment && <span style={{ color: "#888" }}>  ; {e.comment}</span>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export function FlowGraphTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const view = snap?.views?.flowGraph;
  const nodes = view?.nodes ?? [];
  const edges = view?.edges ?? [];
  const nodeTitle = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;
  return (
    <div style={wrap}>
      <Panel title="Flow nodes" count={nodes.length} raw={view}>
        {nodes.length === 0 ? empty("No flow-graph view yet — run build_flow_graph_view.") : (
          nodes.map((n) => (
            <div key={n.id} style={{ padding: "3px 0", borderBottom: "1px solid #1d1d1d" }}>
              <span style={{ color: "#7c9", fontSize: 10 }}>[{n.kind}]</span> <strong>{n.title}</strong> {confBar(n.confidence)}
              {n.summary && <div style={{ color: "#888", fontSize: 11 }}>{n.summary}</div>}
            </div>
          ))
        )}
      </Panel>
      {edges.length > 0 && (
        <Panel title="Flow edges" count={edges.length}>
          {edges.map((e, i) => (
            <div key={e.id ?? i} style={{ padding: "2px 0", borderBottom: "1px solid #1d1d1d", fontSize: 12 }}>
              <span style={{ color: "#9ab" }}>{nodeTitle(e.from)}</span>
              <span style={{ color: "#666" }}> →[{e.kind}]→ </span>
              <span style={{ color: "#9ab" }}>{nodeTitle(e.to)}</span>
              {e.title && <span style={{ color: "#888" }}>  {e.title}</span>}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

// ---- Media group ----

export function DiskTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  const [selected, setSelected] = useState<string>("");
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const view = snap?.views?.diskLayout;
  const disks = view?.disks ?? [];
  if (disks.length === 0) return <div style={wrap}><Panel title="Disk layout" raw={view}>{empty("No disk-layout view yet — run extract_disk + build_disk_layout_view.")}</Panel></div>;
  // BUG-008-safe: selection is keyed by stable artifactId and only defaults
  // when nothing is chosen, so it doesn't snap back on data refresh.
  const cur = disks.find((d) => d.artifactId === selected) ?? disks[0];
  return (
    <div style={wrap}>
      <Panel title="Disks" count={disks.length} raw={view}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {disks.map((d) => (
            <button key={d.artifactId} onClick={() => setSelected(d.artifactId)}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid " + (d.artifactId === cur.artifactId ? "#4a90d9" : "#333"), background: d.artifactId === cur.artifactId ? "#1d2a3a" : "#1a1a1a", color: "#ccc", cursor: "pointer" }}>
              {d.imageFileName ?? d.diskName ?? d.title}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "#9ab", marginBottom: 6 }}>
          {cur.format} · {cur.diskName ?? cur.title} · {cur.trackCount} tracks · {cur.fileCount} files
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr><th style={th}>name</th><th style={th}>type</th><th style={th}>t/s</th><th style={th}>load</th><th style={th}>size</th></tr></thead>
          <tbody>
            {cur.files.map((f) => (
              <tr key={f.id}>
                <td style={td}><strong>{f.title}</strong></td>
                <td style={{ ...td, color: "#bca" }}>{f.type}</td>
                <td style={{ ...td, fontFamily: "monospace", color: "#9ab" }}>{f.track ?? "?"}/{f.sector ?? "?"}</td>
                <td style={{ ...td, fontFamily: "monospace", color: "#9ab" }}>{f.loadAddress !== undefined ? hex(f.loadAddress) : "—"}</td>
                <td style={{ ...td, color: "#888" }}>{bytes(f.sizeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export function CartridgeTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const view = snap?.views?.cartridgeLayout;
  const carts = view?.cartridges ?? [];
  return (
    <div style={wrap}>
      <Panel title="Cartridges" count={carts.length} raw={view}>
        {carts.length === 0 ? empty("No cartridge-layout view yet — run extract_crt + build_cartridge_layout_view.") : (
          carts.map((c) => (
            <div key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid #222" }}>
              <strong>{c.cartridgeName ?? c.title}</strong>
              <span style={{ color: "#9ab", fontSize: 11, marginLeft: 8 }}>
                {c.hardwareType !== undefined ? `hw=${c.hardwareType} ` : ""}{c.exrom !== undefined ? `exrom=${c.exrom} ` : ""}{c.game !== undefined ? `game=${c.game}` : ""}
              </span>
              <div style={{ color: "#888", fontSize: 11 }}>{c.chips.length} chips · {c.banks.length} banks</div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

export function GraphicsTab(): React.JSX.Element {
  const [items, setItems] = useState<GraphicsItem[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { api.graphics().then((r) => { setItems(r.items ?? []); setErr(""); }).catch((e) => setErr(String(e.message ?? e))); }, []);
  const hex = (n: unknown) => typeof n === "number" ? "$" + n.toString(16) : "?";
  return (
    <div style={wrap}>
      {err && <div style={{ color: "#d66", marginBottom: 8 }}>{err}</div>}
      <div style={card}>
        <div style={hdr}>Graphics / Asset candidates ({items.length})</div>
        {items.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No graphics candidates — run scan_graphics_candidates.</div>}
        {items.map((it, i) => (
          <div key={(it.id as string) ?? i} style={{ padding: "3px 0", borderBottom: "1px solid #222", fontSize: 12 }}>
            <span style={{ color: "#d47f00", fontSize: 10, marginRight: 6 }}>[{String(it.kind ?? "?")}]</span>
            <strong>{String(it.label ?? it.title ?? `asset ${i}`)}</strong>
            <span style={{ color: "#888", marginLeft: 8 }}>{hex(it.start)}–{hex(it.end)}</span>
            {it.confirmed ? <span style={{ color: "#6a9f2f", marginLeft: 8, fontSize: 10 }}>confirmed</span> : null}
          </div>
        ))}
        <div style={{ color: "#555", fontSize: 10, marginTop: 6 }}>Pixel preview is the v1 interactive Graphics editor (dev-only); this is the read-only candidate list.</div>
      </div>
    </div>
  );
}

// ---- Project group (Questions + Docs) ----

export function QuestionsTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const qs = snap?.openQuestions ?? [];
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={hdr}>Open Questions ({qs.length})</div>
        {qs.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No open questions.</div>}
        {qs.map((q) => (
          <div key={q.id} style={{ padding: "4px 0", borderBottom: "1px solid #222" }}>
            <span style={{ color: "#d4a000", fontSize: 10, marginRight: 6 }}>[{q.status ?? "open"}{q.kind ? "/" + q.kind : ""}]</span>
            {q.question ?? q.title ?? q.id}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DocsTab(): React.JSX.Element {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string>("");
  const [body, setBody] = useState<string>("");
  useEffect(() => { api.docs().then((r) => { setDocs(r.docs ?? []); setErr(""); }).catch((e) => setErr(String(e.message ?? e))); }, []);
  const open = useCallback((rel: string) => {
    setSel(rel);
    api.document(rel).then(setBody).catch((e) => setBody(`(error: ${(e as Error).message})`));
  }, []);
  return (
    <div style={{ ...wrap, display: "flex", gap: 8 }}>
      <div style={{ ...card, width: 240, flex: "0 0 auto", overflowY: "auto" }}>
        <div style={hdr}>Docs ({docs.length})</div>
        {err && <div style={{ color: "#d66" }}>{err}</div>}
        {docs.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No project docs (run render_docs).</div>}
        {docs.map((d) => {
          const rel = d.relativePath ?? d.path ?? "";
          return <div key={rel} onClick={() => open(rel)} style={{ cursor: "pointer", padding: "3px 4px", borderRadius: 3, background: sel === rel ? "#1d2a3a" : "transparent", fontSize: 12 }}>{d.title ?? rel}</div>;
        })}
      </div>
      <div style={{ ...card, flex: 1, overflowY: "auto" }}>
        <div style={hdr}>{sel || "Select a document"}</div>
        <pre style={{ fontSize: 11, color: "#cde", whiteSpace: "pre-wrap" }}>{body}</pre>
      </div>
    </div>
  );
}
