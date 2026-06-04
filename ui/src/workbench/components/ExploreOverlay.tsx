// Spec 710.3 — Frozen-VIC inspect overlay + inspector panel.
// Active only while the VM is paused. Opens a checkpoint-bound inspect session
// (vic/inspect/open), resolves clicked pixels / dragged regions to exact VIC/RAM
// provenance (vic/inspect/at|region), and promotes a selection to a durable
// knowledge artifact: vic/inspect/promote returns the FrozenInspectEvidence, then
// the record is POSTed to the workspace knowledge API (/api/vic-inspect-evidence).
//
// The WS (V3WsServer) is the live-runtime transport only; persistence goes through
// the HTTP workspace/knowledge API (Spec 710.3 ONE-UI architecture).
//
// Coordinates: the overlay works in the visible frame (384x272); the resolver
// works in the C64 DISPLAY area (320x200). Convert by subtracting the border
// origin. BORDER_* are PAL VICE-visible offsets and may need a small visual tune.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";

type Selection = { x: number; y: number; w: number; h: number };

// NOTE: visible-frame → display-area → cell conversion is the BACKEND's job
// (Spec 710.3 option 2). This component only maps browser px → visible-frame px
// (accounting for the canvas border + object-fit:contain) and sends raw
// visible coords to vic/inspect/{at,region,promote}.

interface MemoryRef { kind: string; addr: number; length: number; value?: number; bank?: number; note?: string }
interface VisualNode {
  type: string;
  pixel: { x: number; y: number };
  cell?: { col: number; row: number; index: number };
  raster?: { line: number };
  mode: string;
  value?: number;
  colorIndex?: number;
  refs: MemoryRef[];
}

interface Props {
  sessionId: string;
  screenEl: HTMLCanvasElement; // Spec 701 §7 — live frame is a <canvas>
  selection: Selection | null;
  onSelection: (s: Selection | null) => void;
}

const hex = (n: number | undefined, w = 4) => (n == null ? "?" : `$${(n >>> 0).toString(16).padStart(w, "0")}`);

// C64 screen-code → readable glyph (so the panel is human-judgable).
const glyphOf = (code: number | undefined): string => {
  if (code == null) return "";
  const c = code & 0x7f; // ignore reverse-video bit
  if (c === 0x00) return "@";
  if (c >= 0x01 && c <= 0x1a) return String.fromCharCode(64 + c); // A-Z
  if (c >= 0x20 && c <= 0x3f) return String.fromCharCode(c);      // space ! " # … 0-9 …
  return "·";
};

// Reconstruct the readable text of a resolved region (rows of glyphs).
function regionText(nodes: VisualNode[]): string[] {
  const rows = new Map<number, { col: number; ch: string }[]>();
  const sprites: number[] = [];
  for (const n of nodes) {
    if (n.type === "sprite_bounds") { if (n.value != null) sprites.push(n.value); continue; }
    if (!n.cell) continue;
    const r = rows.get(n.cell.row) ?? [];
    r.push({ col: n.cell.col, ch: glyphOf(n.value) });
    rows.set(n.cell.row, r);
  }
  const lines = [...rows.keys()].sort((a, b) => a - b).map((row) => {
    const cells = rows.get(row)!.sort((a, b) => a.col - b.col);
    return `r${row}: ${cells.map((c) => c.ch).join("")}`;
  });
  if (sprites.length) lines.push(`sprites(bounds): ${[...new Set(sprites)].join(", ")}`);
  return lines;
}

export function ExploreOverlay({ sessionId, screenEl, selection, onSelection }: Props): React.JSX.Element {
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [frameMode, setFrameMode] = useState<string>("");
  const [node, setNode] = useState<VisualNode | null>(null);
  const [regionNodes, setRegionNodes] = useState<VisualNode[] | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<string>("");
  const [origin, setOrigin] = useState<any>(null); // Spec 721 Visual-Origin Join result
  const [dragging, setDragging] = useState<{ start: { x: number; y: number } } | null>(null);
  // last resolved display-area target (point or region) for promote
  const lastTarget = useRef<{ points?: { x: number; y: number }[]; region?: { x: number; y: number; width: number; height: number } } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Open a checkpoint-bound inspect session on mount; close on unmount.
  useEffect(() => {
    let cpId: string | null = null;
    (async () => {
      try {
        const r = await getClient().call<any>("vic/inspect/open", { session_id: sessionId });
        cpId = r.checkpointId;
        setCheckpointId(r.checkpointId);
        setFrameMode(r.frame?.mode ?? "");
        setStatus(`Inspect open — checkpoint ${r.checkpointId}, ${r.frame?.mode ?? "?"}${r.provenance ? ` · provenance ${r.provenance.lines?.length ?? 0} lines` : " · no provenance"}`);
      } catch (e: any) {
        setStatus(`vic/inspect/open failed: ${e?.message ?? e}`);
      }
    })();
    return () => {
      if (cpId) getClient().call("vic/inspect/close", { session_id: sessionId, checkpoint_id: cpId }).catch(() => {});
    };
  }, [sessionId]);

  // The actual displayed-IMAGE rectangle inside the canvas element box. The
  // canvas is width/height:100% with object-fit:contain + a 2px border, so the
  // 384x272 frame is letterboxed/centred — getBoundingClientRect (the element
  // box) is NOT the image rect. Compute the true image origin + scale here so
  // browser px map exactly to visible-frame px. (Coordinate→cell conversion is
  // the backend's job — Spec 710.3 option 2; we only send visible-frame px.)
  const imageRect = () => {
    const rect = screenEl.getBoundingClientRect();
    const cs = getComputedStyle(screenEl);
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    const cw = rect.width - bl - br, ch = rect.height - bt - bb;
    const scale = Math.min(cw / 384, ch / 272) || 1;
    return {
      left: rect.left + bl + (cw - 384 * scale) / 2,
      top: rect.top + bt + (ch - 272 * scale) / 2,
      scale,
    };
  };
  // browser px → visible-frame px (0..384, 0..272), fractional.
  const toVisible = (clientX: number, clientY: number) => {
    const r = imageRect();
    return { x: (clientX - r.left) / r.scale, y: (clientY - r.top) / r.scale };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const p = toVisible(e.clientX, e.clientY);
    setDragging({ start: p });
    onSelection({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const p = toVisible(e.clientX, e.clientY);
    onSelection({
      x: Math.min(dragging.start.x, p.x), y: Math.min(dragging.start.y, p.y),
      w: Math.abs(p.x - dragging.start.x), h: Math.abs(p.y - dragging.start.y),
    });
  };
  const onMouseUp = async (e: React.MouseEvent) => {
    if (!dragging || !checkpointId) { setDragging(null); return; }
    const end = toVisible(e.clientX, e.clientY);
    const w = Math.abs(end.x - dragging.start.x), h = Math.abs(end.y - dragging.start.y);
    setDragging(null);
    try {
      if (w < 4 && h < 4) {
        // point — send VISIBLE-frame px; the backend converts to the C64 cell.
        const v = dragging.start;
        lastTarget.current = { points: [{ x: v.x, y: v.y }] };
        const r = await getClient().call<any>("vic/inspect/at", { session_id: sessionId, checkpoint_id: checkpointId, x: v.x, y: v.y });
        setNode(r.node); setRegionNodes(null); setOrigin(null);
        setStatus(`Resolved ${r.node?.type}${r.node?.cell ? ` cell (${r.node.cell.col},${r.node.cell.row})` : ""}`);
      } else {
        const region = { x: Math.min(dragging.start.x, end.x), y: Math.min(dragging.start.y, end.y), width: w, height: h };
        lastTarget.current = { region };
        const r = await getClient().call<any>("vic/inspect/region", { session_id: sessionId, checkpoint_id: checkpointId, region });
        setRegionNodes(r.nodes ?? []); setNode(null); setOrigin(null);
        setStatus(`Resolved ${r.nodes?.length ?? 0} node(s) in region`);
      }
    } catch (err: any) {
      setStatus(`inspect resolve failed: ${err?.message ?? err}`);
    }
  };

  const promote = async () => {
    if (!checkpointId || !lastTarget.current) { setStatus("nothing selected to promote"); return; }
    try {
      const r = await getClient().call<any>("vic/inspect/promote", {
        session_id: sessionId, checkpoint_id: checkpointId,
        points: lastTarget.current.points, region: lastTarget.current.region,
        name: name || undefined, notes: notes || undefined,
      });
      // Persist via the workspace knowledge HTTP API (NOT the WS transport).
      const resp = await fetch("/api/vic-inspect-evidence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence: r.evidence, name: name || undefined, notes: notes || undefined }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const { artifact } = await resp.json();
      setStatus(`Saved knowledge artifact ${artifact?.id ?? "?"} (${r.evidence?.selectedNodes?.length ?? 0} node(s))`);
    } catch (e: any) {
      setStatus(`promote/persist failed: ${e?.message ?? e}`);
    }
  };

  // Spec 721 — resolve the clicked node to its ORIGIN (exact_asset / derived /
  // runtime_generated): match the frozen bytes against the mounted medium's
  // extracted assets, return classification + chain + knowledge.
  const resolveOrigin = async () => {
    const pt = lastTarget.current?.points?.[0];
    if (!checkpointId || !pt) { setStatus("click a point first, then resolve origin"); return; }
    try {
      const r = await getClient().call<any>("vic/inspect/origin", {
        session_id: sessionId, checkpoint_id: checkpointId, x: pt.x, y: pt.y,
      });
      setOrigin(r);
      setStatus(`Origin: ${r.classification} (medium ${r.medium?.ref ?? "none"}, ${r.medium?.candidateCount ?? 0} candidates)`);
    } catch (e: any) {
      setStatus(`origin resolve failed: ${e?.message ?? e}`);
    }
  };

  // Spec 721.J3 — persist the origin (entities + relation chain + finding) via the
  // workspace knowledge HTTP API (NOT the WS transport).
  const persistOrigin = async () => {
    if (!origin?.knowledge) { setStatus("nothing to persist"); return; }
    try {
      const resp = await fetch("/api/asset-join", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledge: origin.knowledge, artifactId: sessionId }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const out = await resp.json();
      setStatus(`Persisted origin: ${out.entityIds?.length ?? 0} entities, ${out.relationIds?.length ?? 0} relations, finding ${out.findingId ?? "?"}`);
    } catch (e: any) {
      setStatus(`persist origin failed: ${e?.message ?? e}`);
    }
  };

  const rect = screenEl.getBoundingClientRect();
  const img = imageRect(); // true displayed-image rect (border + object-fit)
  const renderRefs = (n: VisualNode) => (
    <table className="wb-regs"><tbody>
      {n.refs.map((rf, i) => (
        <tr key={i}>
          <td>{rf.kind}</td><td>{hex(rf.addr)}</td>
          <td>{rf.length}b</td><td>{rf.value != null ? hex(rf.value, 2) : ""}</td>
          <td className="wb-muted">{rf.note ?? ""}</td>
        </tr>
      ))}
    </tbody></table>
  );

  return (
    <>
      <div
        ref={overlayRef}
        className="wb-explore-overlay"
        style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, cursor: "crosshair" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        {selection && selection.w > 0 && selection.h > 0 && (
          <div
            className="wb-explore-selection"
            style={{
              position: "absolute",
              left: (img.left - rect.left) + selection.x * img.scale,
              top: (img.top - rect.top) + selection.y * img.scale,
              width: selection.w * img.scale, height: selection.h * img.scale,
            }}
          />
        )}
      </div>
      <div className="wb-explore-toolbar">
        <strong>Inspect (frozen{frameMode ? ` · ${frameMode}` : ""}):</strong>
        <span className="wb-muted">{status}</span>

        {node && (
          <div className="wb-explore-node">
            {node.type === "sprite_bounds" ? (
              <div>
                <span className="wb-badge">SPRITE BOUNDS</span> sprite #{node.value}
                <span className="wb-muted"> — bounding box, NOT pixel-exact (no transparency/priority)</span>
              </div>
            ) : (
              <div>
                <strong>{node.type}</strong>
                {node.cell && <span> cell ({node.cell.col},{node.cell.row})</span>}
                {node.value != null && <span> char <strong className="wb-glyph">‘{glyphOf(node.value)}’</strong> code {hex(node.value, 2)}</span>}
                {node.colorIndex != null && <span> color {node.colorIndex}</span>}
                {node.raster && <span> raster line {node.raster.line}</span>}
              </div>
            )}
            {renderRefs(node)}
            <button onClick={resolveOrigin} disabled={!checkpointId}>Resolve origin →</button>
          </div>
        )}
        {origin && (
          <div className="wb-explore-node">
            <div>
              <span className="wb-badge">{String(origin.classification ?? "?").toUpperCase()}</span>
              {origin.result?.candidate && (
                <span className="wb-muted">
                  {" "}{origin.result.candidate.kind} {origin.result.candidate.format} @ {origin.result.candidate.source?.mediumRef ?? origin.result.candidate.source?.fileRef ?? "?"}
                  {" +"}{hex(origin.result.candidate.source?.offset ?? 0)}
                </span>
              )}
            </div>
            <div className="wb-explore-text wb-muted">{origin.result?.evidence}</div>
            {Array.isArray(origin.knowledge?.relations) && origin.knowledge.relations.length > 0 && (
              <table className="wb-regs"><tbody>
                {origin.knowledge.relations.map((rl: any, i: number) => (
                  <tr key={i}><td>{rl.from?.kind}</td><td>{rl.relation}</td><td>{rl.to?.kind}</td></tr>
                ))}
              </tbody></table>
            )}
            <button onClick={persistOrigin}>Persist origin → Knowledge</button>
          </div>
        )}
        {regionNodes && (
          <div className="wb-explore-node">
            <strong>{regionNodes.length} node(s)</strong>
            {regionText(regionNodes).map((line, i) => (
              <div key={i} className="wb-explore-text">{line}</div>
            ))}
          </div>
        )}

        {(node || regionNodes) && (
          <>
            <input placeholder="Artifact name" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); promote(); } }} />
            <input placeholder="Notes" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); promote(); } }} />
            <button onClick={promote} disabled={!checkpointId}>Promote → Knowledge ⏎</button>
          </>
        )}
      </div>
    </>
  );
}
