// Spec 860 — the frozen frame as a view (built on Spec 710.3 / 843 / 859).
//
// Mounted only while the machine is paused AND the "VIC view" toggle is on. Three outputs,
// and none of them text over the picture:
//
//   * a translucent GRID over the screen — one column per cycle, one row per raster line,
//     each cell coloured by what the VIC and the CPU did in it, every store that reached the
//     VIC marked where it lands, the techniques the record shows as bars in the left border,
//     and (option "Objects") frames around the things on the screen;
//   * the INSPECTOR in the right-hand column (a portal): what is under the pointer, what is
//     selected, where its bytes are, and the door into the graph;
//   * the LINE STRIP (859) in a dock under the screen (a portal).
//
// Everything drawn comes from `vic/frame_map` — one replay of the frame on screen in a
// clone of the machine. Nothing is computed from a timing table here.
//
// The 843 behaviours stay as they were: the checkpoint is pinned while the view is open and
// released when it closes (a ref, so StrictMode cannot leak it), a scrub re-opens it, a
// point resolves through `vic/inspect/at`, a framed area through `vic/inspect/region`, and
// Promote writes findings with address ranges.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getClient } from "../ws-client.js";
import { VicLineView } from "./VicLineView.js";

// Where the 384×272 visible window sits in the VIC's 520×312 framebuffer (render.rs
// CANVAS_X0 / CANVAS_Y0). A visible pixel's raster line is y + 16.
const FB_ORIGIN = { x: 104, y: 16 };

type Selection = { x: number; y: number; w: number; h: number };

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

interface Range { addr: number; length: number }
interface FrameObject {
  kind: "display" | "sprite";
  label: string;
  x: number; y: number; w: number; h: number;
  mode?: string;
  sprite?: number;
  lines?: [number, number];
  ranges: Record<string, Range[]>;
}
interface Technique { rule: string; name: string; lines: [number, number]; detail: string; source: string }
interface Write { line: number; cycle: number; reg: number; addr: number; value: number; x: number | null; midLine: boolean; shapesPicture: boolean }
interface FrameMap {
  frame: { which: "displayed" | "next"; verified: boolean | null };
  geometry: { cycleX: (number | null)[] };
  cellBits: Record<string, number>;
  cells: number[][];
  lines: { line: number; badLine: boolean; ba: number; stalled: number; vicOwned: number; spriteDma: number }[];
  writes: Write[];
  objects: FrameObject[];
  techniques: Technique[];
}

interface Props {
  sessionId: string;
  screenEl: HTMLCanvasElement; // Spec 701 §7 — live frame is a <canvas>
  selection: Selection | null;
  onSelection: (s: Selection | null) => void;
  /** Spec 860 — the right-hand column while the view is on. */
  sideSlot: HTMLElement | null;
  /** Spec 860 — the dock under the screen. */
  dockSlot: HTMLElement | null;
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

// The grid's colours. One per question a cell answers; the legend in the side panel uses
// the same table.
const CELL_FILL: { key: string; label: string; rgb: string }[] = [
  { key: "sAccess", label: "sprite fetch (s)", rgb: "255,159,67" },
  { key: "cAccess", label: "c-access (bad line)", rgb: "76,175,80" },
  { key: "stall", label: "CPU halted", rgb: "239,83,80" },
  { key: "ba", label: "BA down, CPU still runs", rgb: "255,213,79" },
];
const RULE_COLOR: Record<string, string> = {
  split: "#4dd0e1", fli: "#ff7043", fld: "#ab47bc", linecrunch: "#ec407a", dma_delay: "#ffa726",
  side_border: "#66bb6a", tb_border: "#9ccc65", multiplexer: "#e040fb", sprite_height: "#f06292", mid_line: "#ef5350",
};

const readPref = (k: string, d: string) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const writePref = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export function ExploreOverlay({ sessionId, screenEl, selection, onSelection, sideSlot, dockSlot }: Props): React.JSX.Element {
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [frameMode, setFrameMode] = useState<string>("");
  // Spec 843 D3 — the frame's memory map, kept instead of discarded.
  const [frame, setFrame] = useState<any | null>(null);
  const [node, setNode] = useState<VisualNode | null>(null);
  const [regionNodes, setRegionNodes] = useState<VisualNode[] | null>(null);
  // Spec 843 D6 — contiguous source ranges the rectangle is a view of.
  const [regionRanges, setRegionRanges] = useState<Array<{ kind: string; addr: number; length: number; bank?: number }>>([]);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<string>("");
  const [origin, setOrigin] = useState<any>(null); // Spec 721 Visual-Origin Join result
  const [dragging, setDragging] = useState<{ start: { x: number; y: number } } | null>(null);
  const lastTarget = useRef<{ points?: { x: number; y: number }[]; region?: { x: number; y: number; width: number; height: number } } | null>(null);

  // Spec 860 — the view.
  const [fmap, setFmap] = useState<FrameMap | null>(null);
  const [objectsOn, setObjectsOn] = useState(() => readPref("c64re.vicView.objects", "1") === "1");
  const [opacity, setOpacity] = useState(() => Number(readPref("c64re.vicView.opacity", "0.55")) || 0.55);
  const [seeThrough, setSeeThrough] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [selCell, setSelCell] = useState<{ line: number; cycle: number | null; fbX: number | null } | null>(null);
  const [selObject, setSelObject] = useState<FrameObject | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setLayoutTick] = useState(0);

  // Spec 843 D5 — the pin lives in a ref: written synchronously, so every cleanup can read
  // it, and no checkpoint is left pinned under StrictMode.
  const openCpRef = useRef<string | null>(null);
  // Spec 843 D4 — re-open when the machine moves under us (a Filmstrip scrub).
  const [reopenNonce, setReopenNonce] = useState(0);
  useEffect(() => {
    const onMoved = () => {
      setNode(null);
      setRegionNodes(null);
      setOrigin(null);
      setSelCell(null);
      setSelObject(null);
      setFmap(null);
      setStatus("the machine moved — re-opening the inspect checkpoint");
      setReopenNonce((n) => n + 1);
    };
    window.addEventListener("c64re:machine-moved", onMoved);
    return () => window.removeEventListener("c64re:machine-moved", onMoved);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getClient().call<any>("vic/inspect/open", { session_id: sessionId });
        if (cancelled) {
          getClient().call("vic/inspect/close", { session_id: sessionId, checkpoint_id: r.checkpointId }).catch(() => {});
          return;
        }
        openCpRef.current = r.checkpointId;
        setCheckpointId(r.checkpointId);
        setFrameMode(r.frame?.mode ?? "");
        setFrame(r.frame ?? null);
        setStatus("recording the frame on screen…");
        // Spec 860 — one replay of the frame on screen serves the grid, the frames and the
        // line strip.
        const fm = await getClient().call<FrameMap>("vic/frame_map", { session_id: sessionId, checkpoint_id: r.checkpointId });
        if (cancelled) return;
        setFmap(fm);
        setStatus(fm.frame.which === "next"
          ? "the ring does not reach back — showing the frame after the one on screen"
          : fm.frame.verified === false ? "the replay drew a different picture (input during the replay window?)" : "");
      } catch (e: any) {
        setStatus(`VIC view failed: ${e?.message ?? e}`);
      }
    })();
    return () => {
      cancelled = true;
      const cpId = openCpRef.current;
      openCpRef.current = null;
      if (cpId) {
        getClient().call("vic/inspect/close", { session_id: sessionId, checkpoint_id: cpId })
          .catch((e: any) => console.warn("[inspect] close failed — a checkpoint stays pinned:", e?.message ?? e));
      }
    };
  }, [sessionId, reopenNonce]);

  // Keep the grid on the picture when the window or the layout moves.
  useEffect(() => {
    const bump = () => setLayoutTick((t) => t + 1);
    const ro = new ResizeObserver(bump);
    ro.observe(screenEl);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => { ro.disconnect(); window.removeEventListener("resize", bump); window.removeEventListener("scroll", bump, true); };
  }, [screenEl]);

  // D6 — hold Alt to look through the overlay.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setSeeThrough(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setSeeThrough(false); };
    const blur = () => setSeeThrough(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  // The displayed-image rectangle inside the canvas element (object-fit: contain + border).
  const imageRect = () => {
    const rect = screenEl.getBoundingClientRect();
    const cs = getComputedStyle(screenEl);
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    const cw = rect.width - bl - br, ch = rect.height - bt - bb;
    const scale = Math.min(cw / 384, ch / 272) || 1;
    return { left: rect.left + bl + (cw - 384 * scale) / 2, top: rect.top + bt + (ch - 272 * scale) / 2, scale };
  };
  const toVisible = (clientX: number, clientY: number) => {
    const r = imageRect();
    return { x: (clientX - r.left) / r.scale, y: (clientY - r.top) / r.scale };
  };

  const cycleX = fmap?.geometry.cycleX ?? [];
  // The grid is the whole line, all 63 cycles. 48 of them draw the visible picture, left
  // border to right border (8 pixels each, where the draw put them). The other 15 — cycles
  // 1–14 and 63 — are in horizontal blanking and have no pixel, but they are where sprite
  // pointers, refresh, the start of a bad line's BA and many $D011 stores happen. They are
  // drawn beside the picture, 1–14 to the left and 63 to the right, at half width.
  const HB_W = 4;
  const nLanes = fmap ? new Set(fmap.techniques.map((t) => t.rule)).size : 0;
  const LANES_W = nLanes > 0 ? nLanes * 3 + 2 : 0;
  const EXT_L = 14 * HB_W + LANES_W;
  const EXT_R = HB_W;
  const colOf = useCallback((c: number): { x: number; w: number } => {
    const cx = cycleX[c - 1];
    if (cx != null) return { x: cx, w: 8 };
    if (c <= 14) return { x: -(15 - c) * HB_W, w: HB_W };
    return { x: 384 + (c - 63) * HB_W, w: HB_W };
  }, [cycleX]);
  /** The cycle whose column holds x (visible-frame x; negative is the blanking at the left). */
  const cycleAt = useCallback((x: number): number | null => {
    if (!fmap) return null;
    for (let c = 1; c <= 63; c++) {
      const col = colOf(c);
      if (x >= col.x && x < col.x + col.w) return c;
    }
    return null;
  }, [colOf, fmap]);

  const objectAt = (x: number, y: number): FrameObject | null => {
    if (!fmap || !objectsOn) return null;
    const hits = fmap.objects.filter((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
    hits.sort((a, b) => a.w * a.h - b.w * b.h);
    return hits[0] ?? null;
  };

  // ── pointer ──
  const onMouseDown = (e: React.MouseEvent) => {
    const p = toVisible(e.clientX, e.clientY);
    setDragging({ start: p });
    onSelection({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const p = toVisible(e.clientX, e.clientY);
    setHover(p);
    if (!dragging) return;
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
        const v = dragging.start;
        const line = Math.floor(v.y) + FB_ORIGIN.y;
        const cyc = cycleAt(v.x);
        if (v.x < 0 || v.x >= 384) {
          // Horizontal blanking: a cycle with no pixel. It has a line and a cycle, not a
          // byte on the screen — select the cell and open the line strip on it.
          setSelCell({ line, cycle: cyc, fbX: null });
          onSelection(null);
          setStatus(`line ${line}, cycle ${cyc ?? "?"} — horizontal blanking, no pixel`);
          return;
        }
        setSelCell({ line, cycle: cyc, fbX: Math.floor(v.x) + FB_ORIGIN.x });
        const obj = objectAt(v.x, v.y);
        setSelObject(obj);
        onSelection(null);
        // The cell under the pointer, always — an object is the answer to "what is this",
        // the cell to "which byte drew this pixel".
        lastTarget.current = obj ? { region: { x: obj.x, y: obj.y, width: obj.w, height: obj.h } } : { points: [{ x: v.x, y: v.y }] };
        const r = await getClient().call<any>("vic/inspect/at", { session_id: sessionId, checkpoint_id: checkpointId, x: v.x, y: v.y });
        setNode(r.node); setRegionNodes(null); setOrigin(null);
        setRegionRanges([]);
        setStatus(obj ? `Selected: ${obj.label}` : `Resolved ${r.node?.type}${r.node?.cell ? ` cell (${r.node.cell.col},${r.node.cell.row})` : ""}`);
      } else {
        const region = { x: Math.min(dragging.start.x, end.x), y: Math.min(dragging.start.y, end.y), width: w, height: h };
        lastTarget.current = { region };
        setSelObject(null);
        const r = await getClient().call<any>("vic/inspect/region", { session_id: sessionId, checkpoint_id: checkpointId, region });
        setRegionNodes(r.nodes ?? []); setNode(null); setOrigin(null);
        // Spec 843 D6 — the ranges are the answer; the node list is the sampling.
        setRegionRanges(r.ranges ?? []);
        const rs = (r.ranges ?? []).length;
        setStatus(`Region: ${rs} source range(s) across ${r.nodes?.length ?? 0} sampled node(s)`);
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
      // Spec 843 D7 — send the SOURCE RANGES; they become findings with an `addressRange`.
      // A selected object brings its own ranges (from the frame map); a point its refs.
      const objRanges = selObject
        ? Object.entries(selObject.ranges).flatMap(([kind, rs]) => rs.map((x) => ({ kind, addr: x.addr, length: x.length })))
        : [];
      const ranges = regionRanges.length > 0
        ? regionRanges
        : objRanges.length > 0
          ? objRanges
          : (node?.refs ?? []).map((rf) => ({ kind: rf.kind, addr: rf.addr, length: rf.length, bank: (rf as any).bank }));
      const resp = await fetch("/api/vic-inspect-evidence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence: r.evidence, name: name || undefined, notes: notes || undefined, ranges }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const { artifact, findingIds } = await resp.json();
      const n = findingIds?.length ?? 0;
      setStatus(n > 0
        ? `In the graph: ${n} finding(s) with an address range · evidence artifact ${artifact?.id ?? "?"}`
        : `Evidence artifact ${artifact?.id ?? "?"} saved — but NO findings: nothing had a source range, so this is not in the graph`);
    } catch (e: any) {
      setStatus(`promote/persist failed: ${e?.message ?? e}`);
    }
  };

  // Spec 721 — resolve the clicked node to its ORIGIN.
  const resolveOrigin = async () => {
    const pt = lastTarget.current?.points?.[0] ?? (selCell && hover ? hover : null);
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

  // Spec 721.J3 — persist the origin via the workspace knowledge HTTP API.
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

  // ── drawing ──
  const img = imageRect();
  const hoverLine = hover ? Math.floor(hover.y) + FB_ORIGIN.y : null;
  const hoverCycle = hover ? cycleAt(hover.x) : null;
  const hoverObj = hover ? objectAt(hover.x, hover.y) : null;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !fmap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round((EXT_L + 384 + EXT_R) * img.scale * dpr), H = Math.round(272 * img.scale * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const k = img.scale * dpr;
    // C64 visible-frame coordinates: x = 0 is the first pixel of the left border.
    g.setTransform(k, 0, 0, k, EXT_L * k, 0);
    const px = 1 / k; // one device pixel, in C64 pixels
    const b = fmap.cellBits;
    const a = opacity;

    // Cells.
    for (let vy = 0; vy < 272; vy++) {
      const row = fmap.cells[vy + FB_ORIGIN.y];
      if (!row) continue;
      for (let i = 0; i < 63; i++) {
        const col = colOf(i + 1);
        const v = row[i];
        const fill = v & b.sAccess ? CELL_FILL[0] : v & b.cAccess ? CELL_FILL[1] : v & b.stall ? CELL_FILL[2] : v & b.ba ? CELL_FILL[3] : null;
        if (!fill) continue;
        // c-accesses fill a bad line from cycle 15 to 54 and nothing else; drawn at full
        // strength they read as the raster line itself and seem to end mid-picture.
        const alpha = fill === CELL_FILL[1] ? 0.3 : 0.55;
        g.fillStyle = `rgba(${fill.rgb},${(alpha * a).toFixed(3)})`;
        g.fillRect(col.x, vy, col.w, 1);
      }
    }
    // The blanking columns get a faint ground, so they read as part of the line.
    g.fillStyle = `rgba(120,120,160,${(0.12 * a).toFixed(3)})`;
    g.fillRect(-14 * HB_W, 0, 14 * HB_W, 272);
    g.fillRect(384, 0, EXT_R, 272);
    // Guide lines: every cycle, and at every character row (the frame's own bad lines).
    g.strokeStyle = `rgba(200,200,230,${(0.28 * a).toFixed(3)})`;
    g.lineWidth = px;
    g.beginPath();
    for (let c = 1; c <= 63; c++) {
      const col = colOf(c);
      g.moveTo(col.x, 0); g.lineTo(col.x, 272);
    }
    g.stroke();
    // Character rows: a line across the WHOLE raster line, blanking included, at every row
    // start (the frame's own bad lines; every 8th line where there are none). Stronger than
    // the cycle lines, so the rows read as running from cycle 1 to cycle 63.
    const bad = fmap.lines.filter((l) => l.badLine).map((l) => l.line);
    const rows = bad.length > 0 ? bad : Array.from({ length: 40 }, (_, i) => i * 8);
    g.strokeStyle = `rgba(210,210,240,${Math.min(0.9, 0.25 + 0.5 * a).toFixed(3)})`;
    g.beginPath();
    for (const l of rows) {
      const vy = l - FB_ORIGIN.y;
      if (vy < 0 || vy > 272) continue;
      g.moveTo(-14 * HB_W, vy); g.lineTo(384 + EXT_R, vy);
    }
    g.stroke();
    // Where the picture begins and ends.
    g.strokeStyle = `rgba(220,220,255,${Math.min(1, 0.25 + 0.5 * a).toFixed(3)})`;
    g.lineWidth = 1.5 * px;
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(0, 272);
    g.moveTo(384, 0); g.lineTo(384, 272);
    g.stroke();
    // Techniques: bars in the left border, one lane per rule. A mid-line change is not a
    // range of lines — it happens on the lines that carry a store — so it gets a tick on
    // each of those lines, not a bar from the first to the last.
    const lanes = [...new Set(fmap.techniques.map((t) => t.rule))];
    g.globalAlpha = Math.min(1, 0.4 + a);
    fmap.techniques.forEach((t) => {
      const lane = lanes.indexOf(t.rule);
      g.fillStyle = RULE_COLOR[t.rule] ?? "#ffffff";
      if (t.rule === "mid_line") return;
      const y0 = t.lines[0] - FB_ORIGIN.y, y1 = t.lines[1] - FB_ORIGIN.y + 1;
      if (y1 < 0 || y0 > 272) return;
      g.fillRect(-EXT_L + 1 + lane * 3, Math.max(0, y0), 2, Math.max(1, Math.min(272, y1) - Math.max(0, y0)));
    });
    const midLane = lanes.indexOf("mid_line");
    if (midLane >= 0) {
      g.fillStyle = RULE_COLOR.mid_line;
      for (const w of fmap.writes) {
        if (!w.midLine) continue;
        const vy = w.line - FB_ORIGIN.y;
        if (vy >= 0 && vy < 272) g.fillRect(-EXT_L + 1 + midLane * 3, vy - 1, 2, 3);
      }
    }
    g.globalAlpha = 1;
    // Stores that reached the VIC, where they land.
    for (const w of fmap.writes) {
      const vy = w.line - FB_ORIGIN.y;
      if (vy < 0 || vy >= 272) continue;
      g.fillStyle = w.midLine ? "rgba(239,83,80,0.95)" : `rgba(255,255,255,${Math.min(1, 0.3 + a).toFixed(3)})`;
      g.fillRect(colOf(w.cycle).x, vy - 1, 1.5, 3);
    }
    // Objects.
    if (objectsOn) {
      for (const o of fmap.objects) {
        const sel = selObject && o.x === selObject.x && o.y === selObject.y && o.w === selObject.w && o.h === selObject.h;
        const hov = hoverObj === o;
        g.strokeStyle = sel ? "#ffd54f" : o.kind === "sprite" ? "#e040fb" : "#4dd0e1";
        g.globalAlpha = sel || hov ? 1 : Math.min(1, 0.35 + a);
        g.lineWidth = (sel ? 2.5 : hov ? 2 : 1.2) * px;
        g.strokeRect(o.x + px / 2, o.y + px / 2, o.w - px, o.h - px);
        g.globalAlpha = 1;
      }
    }
    // The selected cell and the cell under the pointer.
    const outline = (line: number, cyc: number | null, color: string) => {
      const vy = line - FB_ORIGIN.y;
      g.strokeStyle = color;
      g.lineWidth = 1.5 * px;
      if (cyc != null) {
        const col = colOf(cyc);
        g.strokeRect(col.x, vy, col.w, 1);
      }
      g.globalAlpha = 0.35;
      g.fillStyle = color;
      g.fillRect(-14 * HB_W, vy, 14 * HB_W + 384 + EXT_R, 1 / Math.max(1, img.scale) + 0.2);
      g.globalAlpha = 1;
    };
    if (selCell) outline(selCell.line, selCell.cycle, "#ffd54f");
    if (hoverLine != null && !dragging) outline(hoverLine, hoverCycle, "#ffffff");
    // The ruler, while the pointer is on the grid: cycle numbers along the top, line numbers
    // down the left.
    if (hover) {
      // A fixed size on screen (~11 px), whatever the zoom.
      const fs = Math.max(3, 11 / img.scale);
      g.font = `${fs}px monospace`;
      g.textBaseline = "top";
      for (let c = 1; c <= 63; c++) {
        if (c !== 1 && c % 5 !== 0 && c !== hoverCycle) continue;
        const col = colOf(c);
        const label = String(c);
        const w = g.measureText(label).width + fs * 0.3;
        g.fillStyle = "rgba(10,10,24,0.8)";
        g.fillRect(col.x, 0, w, fs * 1.15);
        g.fillStyle = c === hoverCycle ? "#ffd54f" : "#d0d0e8";
        g.fillText(label, col.x + fs * 0.15, fs * 0.08);
      }
      const lines = new Set<number>([hoverLine ?? -1]);
      for (let l = 32; l < 288; l += 32) lines.add(l);
      for (const l of lines) {
        const vy = l - FB_ORIGIN.y;
        if (vy < 0 || vy >= 272) continue;
        const label = String(l);
        const w = g.measureText(label).width + fs * 0.3;
        g.fillStyle = "rgba(10,10,24,0.8)";
        g.fillRect(-14 * HB_W, vy - fs * 0.55, w, fs * 1.1);
        g.fillStyle = l === hoverLine ? "#ffd54f" : "#d0d0e8";
        g.fillText(label, -14 * HB_W + fs * 0.15, vy - fs * 0.5);
      }
    }
    // A framed area being dragged.
    if (selection && selection.w > 0 && selection.h > 0) {
      g.strokeStyle = "#ffd54f";
      g.setLineDash([4 * px, 3 * px]);
      g.lineWidth = 1.5 * px;
      g.strokeRect(selection.x, selection.y, selection.w, selection.h);
      g.setLineDash([]);
    }
  });

  // ── side panel pieces ──
  /** Spec 843 D3 — an address with its base is an identity; without one it is a number. */
  const baseOf = (kind: string): { name: string; addr: number } | null => {
    if (!frame) return null;
    switch (kind) {
      case "screen_ram": return frame.screenBase != null ? { name: "screen", addr: frame.screenBase } : null;
      case "bitmap": return frame.bitmapBase != null ? { name: "bitmap", addr: frame.bitmapBase } : null;
      case "charset": return frame.charBase != null ? { name: "chargen", addr: frame.charBase } : null;
      case "color_ram": return { name: "colour", addr: 0xd800 };
      default: return null;
    }
  };

  const renderRefs = (n: VisualNode) => (
    <table className="wb-regs"><tbody>
      {n.refs.map((rf, i) => {
        const base = baseOf(rf.kind);
        const bytes: number[] | undefined = (rf as any).bytes;
        return (
          <tr key={i}>
            <td>{rf.kind}</td>
            <td>{hex(rf.addr)}</td>
            <td className="wb-muted">{base ? `${base.name} ${hex(base.addr)} +${rf.addr - base.addr}` : ""}</td>
            <td>{rf.length}b</td>
            {/* Spec 843 D2 — a multi-byte ref carries its run: the bytes that ARE the picture. */}
            <td style={{ fontFamily: "monospace" }}>
              {bytes && bytes.length > 0
                ? bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")
                : rf.value != null ? hex(rf.value, 2) : ""}
            </td>
          </tr>
        );
      })}
    </tbody></table>
  );

  /** The frame's memory map — the context every address is read against. */
  const renderFrameMap = () => {
    if (!frame) return null;
    const cell = (label: string, v: unknown) =>
      v == null ? null : <span key={label} style={{ marginRight: 12 }}><span className="wb-muted">{label} </span>{typeof v === "number" ? hex(v) : String(v)}</span>;
    return (
      <div className="vs-map">
        {cell("bank", frame.bankBase)}
        {cell("screen", frame.screenBase)}
        {cell("chargen", frame.charBase)}
        {cell("bitmap", frame.bitmapBase)}
        {frame.charRomShadow ? <span className="wb-muted">char ROM shadow</span> : null}
      </div>
    );
  };

  const decode = (v: number): string[] => {
    if (!fmap) return [];
    const b = fmap.cellBits;
    const out: string[] = [];
    if (v & b.gAccess) out.push("g"); if (v & b.idleG) out.push("g (idle)");
    if (v & b.pAccess) out.push("p"); if (v & b.refresh) out.push("refresh");
    if (v & b.cAccess) out.push("c"); if (v & b.sAccess) out.push("s");
    if (v & b.ba) out.push("BA"); if (v & b.vicOwns) out.push("VIC owns Φ2");
    if (v & b.stall) out.push("CPU halted");
    if (v & b.cpuWrite) out.push("CPU write"); else if (v & b.cpuRead) out.push("CPU read");
    return out;
  };

  const here = hover && hoverLine != null ? { line: hoverLine, cycle: hoverCycle } : selCell;
  const hereLine = here && fmap ? fmap.lines[here.line] : null;
  const hereBits = here && here.cycle != null && fmap ? fmap.cells[here.line]?.[here.cycle - 1] ?? 0 : null;
  const hereWrites = here && fmap ? fmap.writes.filter((w) => w.line === here.line) : [];
  const hereTech = here && fmap ? fmap.techniques.filter((t) => here.line >= t.lines[0] && here.line <= t.lines[1]) : [];

  const side = (
    <div className="wb-vicside">
      <div className="vs-bar">
        <strong>VIC view</strong>
        <label className="vs-toggle">
          <input id="vs-objects" type="checkbox" checked={objectsOn}
            onChange={(e) => { setObjectsOn(e.target.checked); writePref("c64re.vicView.objects", e.target.checked ? "1" : "0"); }} />
          Objects
        </label>
        <label className="vs-opacity" title="How much of the grid lies over the picture — hold Alt to look through it">
          <input id="vs-opacity" type="range" min={0.1} max={1} step={0.05} value={opacity}
            onChange={(e) => { const v = Number(e.target.value); setOpacity(v); writePref("c64re.vicView.opacity", String(v)); }} />
        </label>
      </div>
      {fmap && (
        <div className="vs-verdict">
          {fmap.frame.which === "next" ? <span className="vs-warn">next frame — the ring does not reach back</span>
            : fmap.frame.verified === true ? <span className="vs-ok">frame on screen ✓</span>
              : fmap.frame.verified === false ? <span className="vs-bad">replay differs from the picture</span>
                : <span className="vs-warn">frame on screen (unverified)</span>}
          <span className="wb-muted"> · hold ⌥ to see through</span>
        </div>
      )}
      {status && <div className="vs-status wb-muted">{status}</div>}

      <section className="vs-sec vs-here">
        <h4>{here ? <>Line {here.line}{here.cycle != null ? <> · cycle {here.cycle}</> : <span className="wb-muted"> · outside the drawn cycles</span>}</> : "Point at the picture"}</h4>
        <div className="vs-rows">
          <div><span className="wb-muted">cycle</span> {hereBits != null ? decode(hereBits).join(" · ") || "—" : "—"}</div>
          <div><span className="wb-muted">line</span> {hereLine ? `${hereLine.badLine ? "bad line · " : ""}BA ${hereLine.ba} · CPU halted ${hereLine.stalled} · VIC owned ${hereLine.vicOwned}${hereLine.spriteDma ? ` · sprite DMA ${hex(hereLine.spriteDma, 2)}` : ""}` : "—"}</div>
          <div><span className="wb-muted">stores</span> {hereWrites.length ? hereWrites.map((w) => `c${w.cycle} ${hex(w.addr)}=${hex(w.value, 2)}${w.midLine ? " ⚠" : ""}`).join("  ") : "—"}</div>
          <div><span className="wb-muted">technique</span> {hereTech.length ? hereTech.map((t) => t.name).join(", ") : "—"}</div>
        </div>
      </section>

      {fmap && fmap.techniques.length > 0 && (
        <section className="vs-sec">
          <h4>Techniques in this frame</h4>
          {fmap.techniques.map((t, i) => (
            <button key={i} className="vs-tech" onClick={() => setSelCell({ line: t.lines[0], cycle: null, fbX: null })} title={t.source}>
              <span className="vs-swatch" style={{ background: RULE_COLOR[t.rule] ?? "#fff" }} />
              <strong>{t.name}</strong> <span className="wb-muted">{t.lines[0] === t.lines[1] ? `line ${t.lines[0]}` : `lines ${t.lines[0]}–${t.lines[1]}`}</span>
              <div className="vs-tech-detail">{t.detail}</div>
            </button>
          ))}
        </section>
      )}

      {selObject && (
        <section className="vs-sec">
          <h4><span className="vs-swatch" style={{ background: selObject.kind === "sprite" ? "#e040fb" : "#4dd0e1" }} /> {selObject.label}</h4>
          <table className="wb-regs"><tbody>
            {Object.entries(selObject.ranges).flatMap(([kind, rs]) => rs.map((r, i) => (
              <tr key={`${kind}${i}`}><td>{kind}</td><td>{hex(r.addr)}</td><td>+{r.length}</td></tr>
            )))}
          </tbody></table>
        </section>
      )}

      {node && (
        <section className="vs-sec">
          <h4>{node.type === "sprite_bounds" ? `Sprite #${node.value} (bounds)` : <>{node.type}{node.cell && ` cell (${node.cell.col},${node.cell.row})`}</>}</h4>
          {node.value != null && node.type !== "sprite_bounds" && <div>char <strong className="wb-glyph">‘{glyphOf(node.value)}’</strong> code {hex(node.value, 2)}{node.colorIndex != null && <> · colour {node.colorIndex}</>}</div>}
          {(node as any).mode && (node as any).mode !== frameMode && <div>mode <strong>{(node as any).mode}</strong> (frame: {frameMode})</div>}
          {renderFrameMap()}
          {renderRefs(node)}
          <button onClick={resolveOrigin} disabled={!checkpointId}>Resolve origin →</button>
        </section>
      )}

      {origin && (
        <section className="vs-sec">
          <div><span className="wb-badge">{String(origin.classification ?? "?").toUpperCase()}</span></div>
          <div className="wb-muted">{origin.result?.evidence}</div>
          {origin.search && origin.classification !== "exact_asset" && (
            <div className="wb-muted">searched: {origin.search.scanned} · {origin.search.candidates} candidate(s) · {origin.search.method}</div>
          )}
          <button onClick={persistOrigin}>Persist origin → Knowledge</button>
        </section>
      )}

      {regionNodes && (
        <section className="vs-sec">
          <h4>Framed area</h4>
          {renderFrameMap()}
          {regionRanges.length > 0 ? (
            <table className="wb-regs"><tbody>
              {regionRanges.map((r, i) => (
                <tr key={i}><td>{r.kind}</td><td>{hex(r.addr)}</td><td>+{r.length}</td><td className="wb-muted">{r.bank != null ? `bank ${hex(r.bank)}` : ""}</td></tr>
              ))}
            </tbody></table>
          ) : (
            <div className="wb-muted">no source ranges — the daemon returned none</div>
          )}
          <div className="wb-muted">{regionNodes.length} sampled node(s)</div>
        </section>
      )}

      {(node || regionNodes || selObject) && (
        <section className="vs-sec vs-annotate">
          <h4>Annotate</h4>
          <input id="vs-name" placeholder="Name" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); promote(); } }} />
          <input id="vs-notes" placeholder="Notes" value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); promote(); } }} />
          <button onClick={promote} disabled={!checkpointId}>Promote → Knowledge ⏎</button>
        </section>
      )}

      <section className="vs-sec vs-legend">
        {CELL_FILL.map((f) => <span key={f.key}><span className="vs-swatch" style={{ background: `rgb(${f.rgb})` }} />{f.label}</span>)}
        <span><span className="vs-swatch" style={{ background: "#fff" }} />store to the VIC</span>
        <span><span className="vs-swatch" style={{ background: "#ef5350" }} />mid-line change</span>
        {objectsOn && <span><span className="vs-swatch vs-frame" style={{ borderColor: "#4dd0e1" }} />display object</span>}
        {objectsOn && <span><span className="vs-swatch vs-frame" style={{ borderColor: "#e040fb" }} />sprite</span>}
      </section>
    </div>
  );

  const dock = selCell && checkpointId ? (
    <VicLineView sessionId={sessionId} checkpointId={checkpointId} line={selCell.line} fbX={selCell.fbX} cycle={selCell.cycle} />
  ) : null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="wb-vicgrid"
        style={{
          position: "fixed", left: img.left - EXT_L * img.scale, top: img.top, width: (EXT_L + 384 + EXT_R) * img.scale, height: 272 * img.scale,
          cursor: "crosshair", opacity: seeThrough ? 0 : 1, zIndex: 50,
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => setHover(null)}
      />
      {sideSlot ? createPortal(side, sideSlot) : null}
      {dockSlot && dock ? createPortal(dock, dockSlot) : null}
    </>
  );
}
