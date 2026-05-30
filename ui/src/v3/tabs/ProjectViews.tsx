// Spec 724B.2 — read-only v3 views for the remaining v1 screens. Each renders a
// view model already produced by the backend (the /api/workspace snapshot views
// + /api/docs + /api/graphics) — the SAME project the LLM writes via MCP. These
// are viewers, not v1's interactive editors (Scrub / in-place annotate stay v1).
import React, { useEffect, useState, useCallback } from "react";
import { api, type WorkspaceSnapshot, type DocEntry, type GraphicsItem } from "../rest-client.js";

const card: React.CSSProperties = { background: "#161616", borderRadius: 5, padding: 10, marginBottom: 10 };
const hdr: React.CSSProperties = { fontWeight: "bold", color: "#888", fontSize: 11, textTransform: "uppercase", marginBottom: 6 };
const wrap: React.CSSProperties = { padding: 8, color: "#ccc", fontSize: 13, overflowY: "auto", height: "100%" };

function ViewJson({ title, value, empty }: { title: string; value: unknown; empty: string }): React.JSX.Element {
  const has = value !== undefined && value !== null && (typeof value !== "object" || Object.keys(value as object).length > 0);
  return (
    <div style={card}>
      <div style={hdr}>{title}</div>
      {has
        ? <pre style={{ fontSize: 10, color: "#9ab", maxHeight: 480, overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(value, null, 2).slice(0, 20000)}</pre>
        : <div style={{ color: "#555", fontStyle: "italic" }}>{empty}</div>}
    </div>
  );
}

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
  return <div style={wrap}><ViewJson title="Memory Map (build_memory_map)" value={snap?.views?.memoryMap} empty="No memory-map view yet — run build_memory_map." /></div>;
}

export function PayloadsTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const payloads = (snap?.artifacts ?? []).filter((a) => ["prg", "payload", "raw"].includes(a.kind));
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={hdr}>Payloads ({payloads.length})</div>
        {payloads.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No payload artifacts.</div>}
        {payloads.map((p) => (
          <div key={p.id} style={{ padding: "3px 0", borderBottom: "1px solid #222" }}>
            <span style={{ color: "#6a9f2f", fontSize: 10, marginRight: 6 }}>[{p.kind}]</span>
            <strong>{p.title}</strong>
            {p.path && <span style={{ color: "#666", fontSize: 11, marginLeft: 8 }}>{p.path}</span>}
          </div>
        ))}
      </div>
      <ViewJson title="Load sequence (build_load_sequence_view)" value={snap?.views?.loadSequence} empty="No load-sequence view yet." />
    </div>
  );
}

export function AnnotatedListingTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  return <div style={wrap}><ViewJson title="Annotated Listing (build_annotated_listing_view)" value={snap?.views?.annotatedListing} empty="No annotated-listing view yet — run build_annotated_listing_view." /></div>;
}

export function FlowGraphTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  const flows = snap?.flows ?? [];
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={hdr}>Flows ({flows.length})</div>
        {flows.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No flows recorded.</div>}
        {flows.map((f) => <div key={f.id} style={{ padding: "3px 0", borderBottom: "1px solid #222" }}><strong>{f.name ?? f.title ?? f.id}</strong>{f.summary && <span style={{ color: "#999", fontSize: 11 }}> — {f.summary}</span>}</div>)}
      </div>
      <ViewJson title="Flow Graph (build_flow_graph_view)" value={snap?.views?.flowGraph} empty="No flow-graph view yet." />
    </div>
  );
}

// ---- Media group ----

export function DiskTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  return <div style={wrap}><ViewJson title="Disk Layout (build_disk_layout_view)" value={snap?.views?.diskLayout} empty="No disk-layout view yet — run build_disk_layout_view." /></div>;
}

export function CartridgeTab(): React.JSX.Element {
  const { snap, err } = useSnapshot();
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  return <div style={wrap}><ViewJson title="Cartridge Layout (build_cartridge_layout_view)" value={snap?.views?.cartridgeLayout} empty="No cartridge-layout view yet — run build_cartridge_layout_view." /></div>;
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
