// Spec 724B.2 — read-only v3 views for the remaining v1 screens. Each renders a
// view model already produced by the backend (the /api/workspace snapshot views
// + /api/docs + /api/graphics) — the SAME project the LLM writes via MCP. These
// are viewers, not v1's interactive editors (Scrub / in-place annotate stay v1).
import React, { useEffect, useState, useCallback } from "react";
import { api, type WorkspaceSnapshot, type DocEntry, type GraphicsItem } from "../rest-client.js";
// BUG-011/012: the REAL v1 visualizations, shared. /api/workspace returns the
// full WorkspaceUiSnapshot (buildWorkspaceUiSnapshot), so the panels get all the
// view models they need. v3 passes no-op callbacks for the cross-panel inspector
// navigation (a v1-only nicety); panel-internal selection/detail stays live.
import type { WorkspaceUiSnapshot, EntityRecord } from "../../types.js";
import { MemoryMapPanel, CartridgePanel, DiskPanel, FlowPanel, EntityInspector, Workbench } from "../../components/workspace-panels.js";
const noop = () => {};

// BUG-014: the v3 viz views keep the v1 workbench model — primary visual on the
// left, the shared Inspector on the right — with live selection. A view holds a
// local selectedEntityId; the panel's onSelectEntity sets it; the Inspector
// renders the linked details. The heavy v1-global actions (open hex/asm overlay,
// create task/question, run workflow) are not available in the v3 shell yet, so
// they pass no-op — but Inspector SELECTION + detail navigation are fully live.
function useEntitySelection(snap: WorkspaceUiSnapshot | null) {
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const entity: EntityRecord | undefined = selectedEntityId
    ? snap?.entities.find((e) => e.id === selectedEntityId) : undefined;
  return { selectedEntityId, setSelectedEntityId, entity };
}
function InspectorSide({ snap, entity, onSelectEntity }: { snap: WorkspaceUiSnapshot; entity?: EntityRecord; onSelectEntity: (id: string) => void }): React.JSX.Element {
  return (
    <EntityInspector
      snapshot={snap}
      entity={entity}
      onSelectEntity={onSelectEntity}
      onOpenDocument={noop}
      onOpenTab={noop}
      onOpenHex={noop}
      onCreateTask={noop}
      onCreateQuestion={noop}
    />
  );
}

// Load the FULL snapshot for the visualization panels (typed against the v1
// view-model contract the panels consume). The HTTP API returns exactly this.
function useFullSnapshot(): { snap: WorkspaceUiSnapshot | null; err: string } {
  const [snap, setSnap] = useState<WorkspaceUiSnapshot | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.workspace().then((s) => { setSnap(s as unknown as WorkspaceUiSnapshot); setErr(""); }).catch((e) => setErr(String(e.message ?? e))); }, []);
  return { snap, err };
}

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
  const { snap, err } = useFullSnapshot();
  const sel = useEntitySelection(snap);
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  if (!snap) return <div style={wrap}>{empty("Loading…")}</div>;
  if (!snap.views?.memoryMap?.cells?.length && !snap.views?.memoryMap?.regions?.length) {
    return <div style={wrap}>{empty("No memory-map view yet — run analyze + build_memory_map.")}</div>;
  }
  // v1 workbench: heatmap grid (left) + live Inspector (right). Selecting a cell
  // sets selectedEntityId → the Inspector shows the linked region/entity.
  return (
    <div style={{ height: "100%", padding: 8 }}>
      <Workbench
        main={<MemoryMapPanel snapshot={snap} selectedEntityId={sel.selectedEntityId} onSelectEntity={sel.setSelectedEntityId} />}
        side={<InspectorSide snap={snap} entity={sel.entity} onSelectEntity={sel.setSelectedEntityId} />}
      />
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
  const { snap, err } = useFullSnapshot();
  const sel = useEntitySelection(snap);
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  if (!snap) return <div style={wrap}>{empty("Loading…")}</div>;
  const fg = snap.views?.flowGraph;
  if (!fg?.nodes?.length) return <div style={wrap}>{empty("No flow-graph view yet — run analyze + build_flow_graph_view.")}</div>;
  // v1 workbench: SVG node/edge graph (left) + live Inspector (right).
  return (
    <div style={{ height: "100%", padding: 8 }}>
      <Workbench
        main={<FlowPanel flowGraph={fg} entities={snap.entities} relations={snap.relations} selectedEntityId={sel.selectedEntityId} onSelectEntity={sel.setSelectedEntityId} />}
        side={<InspectorSide snap={snap} entity={sel.entity} onSelectEntity={sel.setSelectedEntityId} />}
      />
    </div>
  );
}

// ---- Media group ----

export function DiskTab(): React.JSX.Element {
  const { snap, err } = useFullSnapshot();
  const sel = useEntitySelection(snap);
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  if (!snap) return <div style={wrap}>{empty("Loading…")}</div>;
  if (!snap.views?.diskLayout?.disks?.length) {
    return <div style={wrap}>{empty("No disk-layout view yet — run extract_disk + build_disk_layout_view.")}</div>;
  }
  // v1 workbench: SVG cylindrical disk geometry + file list (left) + Inspector
  // (right). Internal disk-tab + file selection stays live; selecting a file also
  // routes its entity into the Inspector. Heavy hex-overlay action = no-op (v1 global).
  return (
    <div style={{ height: "100%", padding: 8 }}>
      <Workbench
        main={<DiskPanel snapshot={snap} onSelectEntity={sel.setSelectedEntityId}
          onSelectDiskFile={(diskArtifactId, fileId) => {
            const disk = snap.views.diskLayout.disks.find((d) => d.artifactId === diskArtifactId);
            const ent = disk?.files.find((f) => f.id === fileId)?.entityId;
            if (ent) sel.setSelectedEntityId(ent);
          }}
          onOpenHex={noop} />}
        side={<InspectorSide snap={snap} entity={sel.entity} onSelectEntity={sel.setSelectedEntityId} />}
      />
    </div>
  );
}

export function CartridgeTab(): React.JSX.Element {
  const { snap, err } = useFullSnapshot();
  const sel = useEntitySelection(snap);
  if (err) return <div style={wrap}><div style={{ color: "#d66" }}>{err}</div></div>;
  if (!snap) return <div style={wrap}>{empty("Loading…")}</div>;
  if (!snap.views?.cartridgeLayout?.cartridges?.length) {
    return <div style={wrap}>{empty("No cartridge-layout view yet — run extract_crt + build_cartridge_layout_view.")}</div>;
  }
  // v1 workbench: bank/chip grid (left) + live Inspector (right). Selecting a
  // bank/chip routes its entity into the Inspector; chunk-inspector is v1-global (no-op).
  return (
    <div style={{ height: "100%", padding: 8 }}>
      <Workbench
        main={<CartridgePanel snapshot={snap} onSelectEntity={sel.setSelectedEntityId} onSelectChunk={noop} onOpenHex={noop} />}
        side={<InspectorSide snap={snap} entity={sel.entity} onSelectEntity={sel.setSelectedEntityId} />}
      />
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
