// Spec 825 D3 — FOUR projections of ONE graphology model. Every view here is a
// pure `(graph, options) => { id: {x, y} }` function: no DOM, no sigma, no
// fetch, so the gate can run all four in node against a fixture graph and the
// panel can switch views by re-positioning instead of re-loading.
//
// The one rule that makes the views cheap: a layout NEVER reads `hidden`.
// Filters are lenses (D5) — toggling one must not move a single position, and
// that property only holds because nothing below looks at visibility.

import { circular } from "graphology-layout";
import type Graph from "graphology";

export type Positions = Record<string, { x: number; y: number }>;
export type ViewId = "force" | "layers" | "radial" | "address";

/** The node attributes a layout reads. The panel puts exactly these on the model. */
export interface LayoutNode {
  kind: string;
  address: number;
  end: number | null;
  bank: number | null;
  platform: boolean;
  dangling: boolean;
}

export interface LayoutOptions {
  /** Radial: the centre. Layers/Address: ignored. */
  focus?: string | null;
  /** Radial: the edge families the BFS may walk; undefined = every edge. */
  edgeTypes?: readonly string[] | null;
}

// ---------------------------------------------------------------- geometry
export const LAYERS_WIDTH = 4096;
export const LAYERS_BAND_HEIGHT = 420;
export const LAYERS_ROW = 46;
export const LAYERS_ROWS_PER_BAND = 8;
export const ADDRESS_LANE_HEIGHT = 4096;
export const ADDRESS_ROW = 420;
export const ADDRESS_ROWS_PER_LANE = 8;
export const RADIAL_RING = 900;
export const SEED_SCALE = 2400;

/**
 * D3 Layers — the seven bands, top to bottom. Calls and accesses read DOWNWARD:
 * an entry calls a routine, a routine reads a label, a label maps to an address,
 * an address is zero page, I/O or ROM.
 */
export const LAYER_BANDS = ["entry", "routine", "label", "addr", "zp", "io", "rom"] as const;
export type BandId = (typeof LAYER_BANDS)[number];

const KIND_BAND: Record<string, BandId> = {
  entry: "entry",
  routine: "routine",
  label: "label",
  segment: "label",
  data_block: "label",
  payload: "label",
  region: "label",
  stage: "label",
  subsystem: "label",
  bank: "label",
  addr: "addr",
  chip: "io",
};

/** Which band a node sits in. A platform node is placed by its platform kind, whatever the store calls it. */
export function bandOf(node: LayoutNode): number {
  const id: BandId = node.platform
    ? node.kind === "zp" ? "zp" : node.kind === "rom" ? "rom" : node.kind === "io" ? "io" : "addr"
    : KIND_BAND[node.kind] ?? "label";
  return LAYER_BANDS.indexOf(id);
}

function nodesOf(graph: Graph): Array<{ id: string; attrs: LayoutNode }> {
  const out: Array<{ id: string; attrs: LayoutNode }> = [];
  graph.forEachNode((id, attrs) => out.push({ id, attrs: attrs as unknown as LayoutNode }));
  return out;
}

const byAddressThenId = (a: { id: string; attrs: LayoutNode }, b: { id: string; attrs: LayoutNode }) =>
  a.attrs.address - b.attrs.address || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------- Force seed
/**
 * D3 Force — ForceAtlas2 runs in its own worker in the browser; what lives here
 * is the SEED, a circular layout, so the simulation starts from the same place
 * every time and two runs of the same graph draw the same picture.
 */
export function seedLayout(graph: Graph): Positions {
  const raw = circular(graph, { scale: SEED_SCALE }) as Record<string, { x: number; y: number }>;
  const out: Positions = {};
  for (const id of Object.keys(raw).sort()) out[id] = { x: raw[id]!.x, y: raw[id]!.y };
  return out;
}

// ---------------------------------------------------------------- Layers
/**
 * D3 Layers — y = the band, x = the address inside it. No simulation, so the
 * picture is the same on every machine, and x is monotone in address within a
 * band (the gate asserts exactly that).
 */
export function layersLayout(graph: Graph): Positions {
  const byBand = new Map<number, Array<{ id: string; attrs: LayoutNode }>>();
  for (const n of nodesOf(graph)) {
    const b = bandOf(n.attrs);
    const list = byBand.get(b) ?? [];
    list.push(n);
    byBand.set(b, list);
  }
  const out: Positions = {};
  for (const [band, list] of byBand) {
    list.sort(byAddressThenId);
    list.forEach((n, i) => {
      out[n.id] = {
        x: (n.attrs.address / 0xffff) * LAYERS_WIDTH,
        y: band * LAYERS_BAND_HEIGHT + (i % LAYERS_ROWS_PER_BAND) * LAYERS_ROW,
      };
    });
  }
  return out;
}

// ---------------------------------------------------------------- Address
export interface AddressLane {
  id: string;
  label: string;
  /** the bank this lane stands for, or null for the un-banked / platform lanes */
  bank: number | null;
}

/**
 * D3 Address — one RAM lane per bank IN THE SCOPE, then plain RAM, then ROM,
 * I/O, zero page. The lanes are derived from the graph, so a project with no
 * cartridge has three lanes and a banked one has as many as it has banks.
 */
export function addressLanes(graph: Graph): AddressLane[] {
  const banks = new Set<number>();
  let plainRam = false;
  let rom = false;
  let io = false;
  let zp = false;
  graph.forEachNode((_id, raw) => {
    const n = raw as unknown as LayoutNode;
    if (n.platform) {
      if (n.kind === "rom") rom = true;
      else if (n.kind === "io") io = true;
      else if (n.kind === "zp") zp = true;
      else plainRam = true;
      return;
    }
    if (n.bank !== null && n.bank !== undefined) banks.add(n.bank);
    else plainRam = true;
  });
  const lanes: AddressLane[] = [...banks].sort((a, b) => a - b).map((b) => ({ id: `bank:${b}`, label: `RAM bank ${b.toString(16).padStart(2, "0")}`, bank: b }));
  if (plainRam || lanes.length === 0) lanes.push({ id: "ram", label: "RAM", bank: null });
  if (rom) lanes.push({ id: "rom", label: "ROM", bank: null });
  if (io) lanes.push({ id: "io", label: "I/O", bank: null });
  if (zp) lanes.push({ id: "zp", label: "ZP", bank: null });
  return lanes;
}

/** The lane index a node belongs to, given the lane list `addressLanes` produced. */
export function laneOf(node: LayoutNode, lanes: AddressLane[]): number {
  const find = (id: string) => lanes.findIndex((l) => l.id === id);
  if (node.platform) {
    const i = find(node.kind === "rom" ? "rom" : node.kind === "io" ? "io" : node.kind === "zp" ? "zp" : "ram");
    return i >= 0 ? i : Math.max(0, find("ram"));
  }
  if (node.bank !== null && node.bank !== undefined) {
    const i = find(`bank:${node.bank}`);
    if (i >= 0) return i;
  }
  const i = find("ram");
  return i >= 0 ? i : 0;
}

/** The lane a y coordinate falls in — the inverse of `addressLayout`'s y, for the gate and the axis. */
export function laneOfY(y: number): number {
  return Math.floor(y / ADDRESS_LANE_HEIGHT);
}

/**
 * D3 Address — x IS the address ($0000–$FFFF, literally, so the axis needs no
 * inverse), y is the lane. A node with a range still sits at its start; the
 * canvas draws the extent, the layout places the anchor.
 */
export function addressLayout(graph: Graph): Positions {
  const lanes = addressLanes(graph);
  const perLane = new Map<number, Array<{ id: string; attrs: LayoutNode }>>();
  for (const n of nodesOf(graph)) {
    const lane = laneOf(n.attrs, lanes);
    const list = perLane.get(lane) ?? [];
    list.push(n);
    perLane.set(lane, list);
  }
  const out: Positions = {};
  for (const [lane, list] of perLane) {
    list.sort(byAddressThenId);
    list.forEach((n, i) => {
      out[n.id] = { x: n.attrs.address, y: lane * ADDRESS_LANE_HEIGHT + (i % ADDRESS_ROWS_PER_LANE) * ADDRESS_ROW };
    });
  }
  return out;
}

// ---------------------------------------------------------------- Radial
/**
 * D3 Radial — rings by BFS hop distance from the focus over the edge families
 * currently on; the focus sits at the origin. The ANGLE is address order over
 * the whole graph, so a routine keeps its bearing when the focus changes and
 * the eye can follow it. Depth 1 of this view IS 824's neighbourhood, readable.
 * No focus → rings by band.
 */
export function radialLayout(graph: Graph, options: LayoutOptions = {}): Positions {
  const nodes = nodesOf(graph);
  const angleOf = new Map<string, number>();
  [...nodes].sort(byAddressThenId).forEach((n, i) => angleOf.set(n.id, nodes.length ? (2 * Math.PI * i) / nodes.length : 0));

  const ring = new Map<string, number>();
  const focus = options.focus && graph.hasNode(options.focus) ? options.focus : null;
  if (focus) {
    const types = options.edgeTypes ? new Set(options.edgeTypes) : null;
    ring.set(focus, 0);
    let frontier = [focus];
    for (let d = 1; frontier.length && d <= 8; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        graph.forEachEdge(id, (_e, attrs, source, target) => {
          if (types && !types.has(String((attrs as { edgeType?: unknown }).edgeType ?? ""))) return;
          const other = source === id ? target : source;
          if (ring.has(other)) return;
          ring.set(other, d);
          next.push(other);
        });
      }
      frontier = next;
    }
    let max = 0;
    for (const r of ring.values()) max = Math.max(max, r);
    for (const n of nodes) if (!ring.has(n.id)) ring.set(n.id, max + 1);
  } else {
    for (const n of nodes) ring.set(n.id, bandOf(n.attrs));
  }

  const out: Positions = {};
  for (const n of nodes) {
    const r = (ring.get(n.id) ?? 0) * RADIAL_RING;
    const a = angleOf.get(n.id) ?? 0;
    out[n.id] = r === 0 ? { x: 0, y: 0 } : { x: r * Math.cos(a), y: r * Math.sin(a) };
  }
  return out;
}

/** BFS ring index per node — exported so the canvas can label the rings and the gate can check them. */
export function radialRings(graph: Graph, options: LayoutOptions = {}): Record<string, number> {
  const positions = radialLayout(graph, options);
  const out: Record<string, number> = {};
  for (const id of Object.keys(positions)) {
    const p = positions[id]!;
    out[id] = Math.round(Math.hypot(p.x, p.y) / RADIAL_RING);
  }
  return out;
}

export const LAYOUTS: Record<ViewId, (graph: Graph, options?: LayoutOptions) => Positions> = {
  force: (graph) => seedLayout(graph),
  layers: (graph) => layersLayout(graph),
  radial: (graph, options) => radialLayout(graph, options),
  address: (graph) => addressLayout(graph),
};

export function layoutFor(view: ViewId, graph: Graph, options: LayoutOptions = {}): Positions {
  return LAYOUTS[view](graph, options);
}
