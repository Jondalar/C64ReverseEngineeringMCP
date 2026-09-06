// Spec 825 D2 — THE one sigma wrapper. sigma is imperative and one component
// owns one `Sigma` for its lifetime (create in an effect, `kill()` on unmount),
// so a React binding (`@react-sigma/core`) would be a second lifecycle for
// nothing. No node-program packages either: colour, size and label carry the
// kinds (OQ3).
//
// The library is behind a DYNAMIC `import()` on purpose (D2): vite emits sigma,
// graphology, the layouts and the community pass as their own chunk, so a
// workspace that never opens the Graph tab downloads exactly what it downloaded
// before 825. Everything statically imported here must stay type-only.
//
// D5 — filters are LENSES: the reducers below set `hidden` (and colour, size,
// label) and never touch `x` / `y`. That is the whole reason toggling a family
// cannot move a node.
//
// D9 — read-only. Nothing in this file writes to the graph.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewId } from "../lib/graph-layouts.js";
import type { CommunityGroup } from "../lib/graph-communities.js";

/** One node of the D1 body, address parsed. */
export interface CanvasNode {
  id: string;
  kind: string;
  address: number;
  end: number | null;
  bank: number | null;
  owner: string | null;
  label: string | null;
  name: string | null;
  layers: string[];
  platform: boolean;
  dangling: boolean;
  degree: number;
}

export interface CanvasEdge {
  from: string;
  to: string;
  type: string;
  origin: string;
  layer: string;
  confidence: string;
  n: number;
}

export interface CanvasLens {
  /** node kinds that are OFF */
  hiddenKinds: ReadonlySet<string>;
  /** 824's edge-family ids that are OFF */
  hiddenFamilies: ReadonlySet<string>;
  /** edge types that are OFF regardless of family (D5 default: MAPS_TO) */
  hiddenEdgeTypes: ReadonlySet<string>;
  /** `static` | `runtime` | `human` | `any` */
  origin: string;
  /** null = every bank */
  bank: number | null;
}

export interface GraphCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: ViewId;
  focus: string | null;
  lens: CanvasLens;
  onSelect: (id: string | null) => void;
  onCommunities: (groups: CommunityGroup[], modularity: number | null) => void;
  /** the community a legend click asked to isolate, or null */
  isolate: string | null;
}

/** D5 — 824's eight chips, extended to every edge type the store actually holds. */
export const EDGE_FAMILIES: Array<{ id: string; label: string; types: string[] }> = [
  { id: "code", label: "Code", types: ["CALLS", "JUMPS_TO", "BRANCHES_TO", "CONTAINS", "PASSES", "PRECEDES", "FOLLOWS", "STARTS_INSIDE"] },
  { id: "memory", label: "Memory", types: ["READS", "WRITES", "READS_INDIRECT", "WRITES_INDIRECT", "REFERENCES_DATA", "USES_ZP", "MAPS_TO", "RESOLVES_TO", "LOADS", "DEPENDS_ON"] },
  { id: "hardware", label: "Hardware", types: ["USES_HARDWARE"] },
  { id: "rom", label: "ROM", types: ["CALLS_ROM"] },
  { id: "runtime", label: "Runtime", types: [] },
  { id: "annotations", label: "Annotations", types: ["SIGNATURE"] },
  { id: "bank", label: "Bank", types: ["CHANGES_BANKING"] },
  { id: "subsystem", label: "Subsystem", types: ["BELONGS_TO"] },
];

export function familyOfType(type: string): string {
  for (const f of EDGE_FAMILIES) if (f.types.includes(type)) return f.id;
  return "code";
}

/** D5 — record plumbing, not addresses: hidden until someone asks for it. */
export const DEFAULT_HIDDEN_EDGE_TYPES = ["MAPS_TO", "SIGNATURE"];
/** D5 — 824's listing structure: thousands of nodes that are not code. */
export const DEFAULT_HIDDEN_KINDS = ["entry", "segment"];

const hex = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The layouts think in SCREEN orientation — y grows downward, so the Layers
 * bands read top to bottom and the Address lanes stack the way D3 draws them.
 * Sigma's camera is y-UP. The flip belongs here, at the render boundary, and
 * nowhere else: the pure layouts stay testable in the orientation D3 specifies.
 */
export function applyPositions(graph: { setNodeAttribute: (n: string, k: string, v: unknown) => void }, positions: Record<string, { x: number; y: number }>): void {
  for (const [id, p] of Object.entries(positions)) {
    graph.setNodeAttribute(id, "x", p.x);
    graph.setNodeAttribute(id, "y", -p.y);
  }
}

/** The label sigma prints. The human name wins; the generated label is the fallback; an address is always there. */
function displayLabel(n: CanvasNode): string {
  const name = n.name ?? n.label;
  return name ? `${hex(n.address)} ${name}` : hex(n.address);
}

type SigmaLike = {
  kill: () => void;
  refresh: () => void;
  getCamera: () => { animatedReset: () => void; animatedZoom: (r?: number) => void; animatedUnzoom: (r?: number) => void; setState: (s: { x: number; y: number; ratio: number; angle: number }) => void; getState: () => { x: number; y: number; ratio: number; angle: number } };
  setSetting: (k: string, v: unknown) => void;
  on: (event: string, handler: (payload: { node?: string; edge?: string }) => void) => void;
  getGraph: () => { setNodeAttribute: (n: string, k: string, v: unknown) => void };
};

export function GraphCanvas({ nodes, edges, view, focus, lens, onSelect, onCommunities, isolate }: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<SigmaLike | null>(null);
  const modelRef = useRef<{ graph: unknown; assignment: Record<string, string>; color: (id: string) => string } | null>(null);
  const stateRef = useRef({ focus, lens, isolate, hovered: null as string | null });
  const [status, setStatus] = useState<string>("loading the renderer…");
  const [running, setRunning] = useState(false);
  const fa2Ref = useRef<{ start: () => void; stop: () => void; kill: () => void; isRunning: () => boolean } | null>(null);
  const [ready, setReady] = useState(0);

  stateRef.current.focus = focus;
  stateRef.current.lens = lens;
  stateRef.current.isolate = isolate;

  // one signature per model rebuild: a new scope means a new graph, a filter does not
  const modelKey = useMemo(() => `${nodes.length}:${edges.length}:${nodes[0]?.id ?? ""}:${nodes[nodes.length - 1]?.id ?? ""}`, [nodes, edges]);

  // ---- build the model + the renderer (D2: the ONLY dynamic import of sigma)
  useEffect(() => {
    let alive = true;
    let sigma: SigmaLike | null = null;
    void (async () => {
      const [{ default: Sigma }, { default: Graphology }, layouts, comms] = await Promise.all([
        import("sigma"),
        import("graphology"),
        import("../lib/graph-layouts.js"),
        import("../lib/graph-communities.js"),
      ]);
      if (!alive || !hostRef.current) return;

      const graph = new Graphology({ multi: false, type: "directed" });
      for (const n of nodes) {
        graph.addNode(n.id, {
          ...n,
          size: 3 + Math.min(14, Math.log2(1 + n.degree) * 2.2),
          label: displayLabel(n),
          x: 0,
          y: 0,
        });
      }
      for (const e of edges) {
        if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
        if (graph.hasEdge(e.from, e.to)) {
          // one drawn edge per pair; the strongest family wins the colour, `n` accumulates
          graph.setEdgeAttribute(e.from, e.to, "n", Number(graph.getEdgeAttribute(e.from, e.to, "n") ?? 0) + e.n);
          const types = graph.getEdgeAttribute(e.from, e.to, "types") as string[];
          if (!types.includes(e.type)) types.push(e.type);
          continue;
        }
        // `type` belongs to SIGMA (it picks the render program with it); the
        // store's edge type lives in `edgeType`, and the pure libs read that.
        graph.addEdge(e.from, e.to, { edgeType: e.type, types: [e.type], origin: e.origin, layer: e.layer, n: e.n, type: "arrow", size: 0.6 });
      }

      const community = comms.communities(graph);
      const color = (id: string) => comms.communityColor(community.assignment[id] ?? "");
      for (const n of nodes) {
        graph.setNodeAttribute(n.id, "community", community.assignment[n.id] ?? "");
        graph.setNodeAttribute(n.id, "color", color(n.id));
      }
      modelRef.current = { graph, assignment: community.assignment, color };
      onCommunities(community.groups, community.modularity);

      applyPositions(graph, layouts.layoutFor(view, graph, { focus: stateRef.current.focus, edgeTypes: null }));

      sigma = new Sigma(graph as never, hostRef.current, {
        renderEdgeLabels: false,
        defaultEdgeColor: "rgba(140,150,190,0.35)",
        labelRenderedSizeThreshold: 8,
        labelDensity: 0.4,
        labelGridCellSize: 90,
        allowInvalidContainer: true,
        nodeReducer: (id: string, data: Record<string, unknown>) => reduceNode(id, data, stateRef.current, graph as never),
        edgeReducer: (id: string, data: Record<string, unknown>) => reduceEdge(id, data, stateRef.current, graph as never),
      } as never) as unknown as SigmaLike;
      sigmaRef.current = sigma;
      sigma.on("clickNode", ({ node }) => node && onSelect(node));
      sigma.on("doubleClickNode", ({ node }) => { if (!node) return; onSelect(node); sigmaRef.current?.getCamera().animatedReset(); });
      sigma.on("clickStage", () => onSelect(null));
      sigma.on("enterNode", ({ node }) => { stateRef.current.hovered = node ?? null; sigmaRef.current?.refresh(); });
      sigma.on("leaveNode", () => { stateRef.current.hovered = null; sigmaRef.current?.refresh(); });

      // Force: ForceAtlas2 in ITS OWN worker, seeded by the circular layout above
      if (view === "force") {
        const { default: FA2Layout } = await import("graphology-layout-forceatlas2/worker");
        const { default: forceAtlas2 } = await import("graphology-layout-forceatlas2");
        if (!alive) return;
        const settings = forceAtlas2.inferSettings(graph as never);
        const worker = new FA2Layout(graph as never, { settings: { ...settings, slowDown: 8 } }) as unknown as { start: () => void; stop: () => void; kill: () => void; isRunning: () => boolean };
        fa2Ref.current = worker;
        worker.start();
        setRunning(true);
        window.setTimeout(() => { try { worker.stop(); } catch { /* already gone */ } setRunning(false); }, 6000);
      }

      setStatus("");
      setReady((n) => n + 1);
    })().catch((e: unknown) => { if (alive) setStatus(`renderer failed: ${e instanceof Error ? e.message : String(e)}`); });

    return () => {
      alive = false;
      try { fa2Ref.current?.kill(); } catch { /* never started */ }
      fa2Ref.current = null;
      try { sigma?.kill(); } catch { /* never created */ }
      sigmaRef.current = null;
      modelRef.current = null;
    };
    // the model is rebuilt only when the SCOPE changes or the view does — never for a lens
  }, [modelKey, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a lens, a focus or an isolate only asks sigma to re-run its reducers.
  //      No layout call here: D5, positions do not move.
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [lens, focus, isolate, ready]);

  // ---- Radial re-rings on a new focus (D6): a re-POSITION, not a re-fetch
  useEffect(() => {
    if (view !== "radial" || !modelRef.current || !sigmaRef.current) return;
    let alive = true;
    void import("../lib/graph-layouts.js").then((layouts) => {
      if (!alive || !modelRef.current) return;
      applyPositions(modelRef.current.graph as never, layouts.radialLayout(modelRef.current.graph as never, { focus, edgeTypes: null }));
      sigmaRef.current?.refresh();
    });
    return () => { alive = false; };
  }, [view, focus, ready]);

  return (
    <div className="graph-canvas-wrap">
      <div className="graph-canvas" ref={hostRef} role="img" aria-label={`graph, ${view} view, ${nodes.length} nodes`} />
      {status ? <div className="graph-canvas-status">{status}</div> : null}
      <div className="graph-canvas-controls">
        <button type="button" onClick={() => sigmaRef.current?.getCamera().animatedReset()}>fit</button>
        <button type="button" onClick={() => sigmaRef.current?.getCamera().animatedZoom()}>+</button>
        <button type="button" onClick={() => sigmaRef.current?.getCamera().animatedUnzoom()}>−</button>
        {view === "force" ? (
          <button
            type="button"
            onClick={() => {
              const w = fa2Ref.current;
              if (!w) return;
              if (w.isRunning()) { w.stop(); setRunning(false); } else { w.start(); setRunning(true); }
            }}
          >
            {running ? "stop layout" : "run layout"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- the lenses
// Both reducers are pure over (attributes, state). They set `hidden`, colour,
// size and label — never `x` or `y`. That is D5, enforced by construction.

interface ReducerState { focus: string | null; lens: CanvasLens; isolate: string | null; hovered: string | null }

type GraphLike = {
  hasNode: (id: string) => boolean;
  neighbors: (id: string) => string[];
  extremities: (edge: string) => [string, string];
  getNodeAttribute: (id: string, key: string) => unknown;
};

function nodeHiddenByLens(data: Record<string, unknown>, lens: CanvasLens): boolean {
  if (lens.hiddenKinds.has(String(data.kind ?? ""))) return true;
  if (lens.bank !== null && data.bank !== null && data.bank !== undefined && Number(data.bank) !== lens.bank) return true;
  return false;
}

export function reduceNode(id: string, data: Record<string, unknown>, state: ReducerState, graph: GraphLike): Record<string, unknown> {
  const res: Record<string, unknown> = { ...data };
  if (nodeHiddenByLens(data, state.lens)) { res.hidden = true; return res; }
  if (state.isolate) {
    const own = String(data.community ?? "");
    if (own && own !== state.isolate) res.color = "rgba(120,126,150,0.25)";
  }
  const anchor = state.hovered ?? state.focus;
  if (anchor && graph.hasNode(anchor)) {
    const near = anchor === id || graph.neighbors(anchor).includes(id);
    if (!near) res.color = "rgba(120,126,150,0.22)";
    else if (anchor === id) { res.highlighted = true; res.forceLabel = true; }
    else res.forceLabel = true;
  }
  if (data.platform === true && (data.name ?? data.label)) res.forceLabel = true;
  return res;
}

export function reduceEdge(id: string, data: Record<string, unknown>, state: ReducerState, graph: GraphLike): Record<string, unknown> {
  const res: Record<string, unknown> = { ...data };
  const lens = state.lens;
  const types = (data.types as string[] | undefined) ?? [String(data.edgeType ?? "")];
  const visibleTypes = types.filter((t) => !lens.hiddenEdgeTypes.has(t) && !lens.hiddenFamilies.has(familyOfType(t)));
  if (visibleTypes.length === 0) { res.hidden = true; return res; }
  if (lens.hiddenFamilies.has("runtime") && data.origin === "runtime") { res.hidden = true; return res; }
  if (lens.origin === "human" ? data.layer !== "human" : lens.origin !== "any" && data.origin !== lens.origin) { res.hidden = true; return res; }
  // an edge whose end the lens hides is an edge into nowhere — hide it too
  const [from, to] = graph.extremities(id);
  const endAttrs = (n: string) => ({ kind: graph.getNodeAttribute(n, "kind"), bank: graph.getNodeAttribute(n, "bank") }) as Record<string, unknown>;
  if (nodeHiddenByLens(endAttrs(from), lens) || nodeHiddenByLens(endAttrs(to), lens)) { res.hidden = true; return res; }
  const anchor = state.hovered ?? state.focus;
  if (anchor && (from === anchor || to === anchor)) { res.color = "rgba(180,190,255,0.85)"; res.zIndex = 1; }
  else if (anchor) res.color = "rgba(120,126,150,0.12)";
  return res;
}
