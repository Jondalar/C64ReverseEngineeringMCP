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

// Visible-frame → display-area origin (PAL VICE visible 384x272; display 320x200).
const BORDER_LEFT = 32;
const BORDER_TOP = 35;
const clampX = (x: number) => Math.max(0, Math.min(319, x));
const clampY = (y: number) => Math.max(0, Math.min(199, y));

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

export function ExploreOverlay({ sessionId, screenEl, selection, onSelection }: Props): JSX.Element {
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [frameMode, setFrameMode] = useState<string>("");
  const [node, setNode] = useState<VisualNode | null>(null);
  const [regionNodes, setRegionNodes] = useState<VisualNode[] | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<string>("");
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
        setStatus(`Inspect open — checkpoint ${r.checkpointId}, ${r.frame?.mode ?? "?"}${r.provenance ? " (provenance)" : ""}`);
      } catch (e: any) {
        setStatus(`vic/inspect/open failed: ${e?.message ?? e}`);
      }
    })();
    return () => {
      if (cpId) getClient().call("vic/inspect/close", { session_id: sessionId, checkpoint_id: cpId }).catch(() => {});
    };
  }, [sessionId]);

  // browser px → visible frame (0..384, 0..272)
  const toVisible = (clientX: number, clientY: number) => {
    const rect = screenEl.getBoundingClientRect();
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * 384),
      y: Math.round(((clientY - rect.top) / rect.height) * 272),
    };
  };
  // visible → display area (0..319, 0..199)
  const toDisplay = (v: { x: number; y: number }) => ({ x: clampX(v.x - BORDER_LEFT), y: clampY(v.y - BORDER_TOP) });

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
        // point resolve
        const d = toDisplay(dragging.start);
        lastTarget.current = { points: [d] };
        const r = await getClient().call<any>("vic/inspect/at", { session_id: sessionId, checkpoint_id: checkpointId, x: d.x, y: d.y });
        setNode(r.node); setRegionNodes(null);
        setStatus(`Resolved ${r.node?.type} @ display (${d.x},${d.y})`);
      } else {
        // region resolve
        const tl = toDisplay({ x: Math.min(dragging.start.x, end.x), y: Math.min(dragging.start.y, end.y) });
        const region = { x: tl.x, y: tl.y, width: Math.min(320 - tl.x, w), height: Math.min(200 - tl.y, h) };
        lastTarget.current = { region };
        const r = await getClient().call<any>("vic/inspect/region", { session_id: sessionId, checkpoint_id: checkpointId, region });
        setRegionNodes(r.nodes ?? []); setNode(null);
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

  const rect = screenEl.getBoundingClientRect();
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
              left: (selection.x / 384) * rect.width, top: (selection.y / 272) * rect.height,
              width: (selection.w / 384) * rect.width, height: (selection.h / 272) * rect.height,
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
                {node.value != null && <span> code {hex(node.value, 2)}</span>}
                {node.colorIndex != null && <span> color {node.colorIndex}</span>}
                {node.raster && <span> raster line {node.raster.line}</span>}
              </div>
            )}
            {renderRefs(node)}
          </div>
        )}
        {regionNodes && (
          <div className="wb-explore-node">
            <strong>{regionNodes.length} node(s)</strong>
            <span className="wb-muted"> {regionNodes.map((n) => n.type === "sprite_bounds" ? `sprite#${n.value}(bounds)` : (n.cell ? `${n.cell.col},${n.cell.row}` : n.type)).join(" · ")}</span>
          </div>
        )}

        {(node || regionNodes) && (
          <>
            <input placeholder="Artifact name" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button onClick={promote} disabled={!checkpointId}>Promote → Knowledge</button>
          </>
        )}
      </div>
    </>
  );
}
