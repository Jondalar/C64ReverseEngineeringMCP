// Spec 867 D1/D2 — the window a payload occupies when it is loaded, and who
// claims an address.
//
// Identity already carries the owner (818: `ram/<owner>`), so `$7400` in module 3
// and `$7400` in module 0 are two nodes. What was missing is the layer above: the
// WINDOW. A payload's load address plus its byte length say which stretch of the
// machine it occupies while it is there; five modules that all load at `$7400` are
// five occupants of ONE window, and an engine resident at `$4300-$73FC` is a
// window of its own that happens to lie inside a 50 KB file's span.
//
// Two rules, and nothing else:
//
//   same window   same space, same bank, same START. Payloads that load at the
//                 same address are alternative occupants of one window — never
//                 each other's holes.
//   inner window  a window with a DIFFERENT start that lies wholly inside
//                 another. It is a hole punched in the outer one: at an address
//                 the inner window covers, the outer payload is not the claimant,
//                 because something else loads there.
//
// Claimants of an address = every window covering it, minus every window that an
// inner window covering it supersedes. That is the whole model; residency (§4,
// `src/symbols/window-residency.ts`) then says which claimant is actually there.
//
// THE PIPELINE HAS A TWIN of the pure half of this file:
// `pipeline/src/analysis/payload-windows.ts` (CommonJS). `src/` is ESM and the two
// trees cannot import each other. `scripts/e2e-867-window.mjs` runs both over one
// fixture graph and fails if they disagree.

import type { GraphStore } from "./store.js";

export type WindowSpace = "ram" | "drv" | "crt";

/**
 * Where a window came from.
 *  - `payload` and `image` are RECORDED: a payload record's own window, or the
 *    extent the project holds for that image. Both are facts, neither is a guess.
 *  - `analysed-range` is the fallback for an owner the project records nothing
 *    about: the range the caller is analysing. It carries no new knowledge, so a
 *    window with this source decides nothing that was not already decided before
 *    Spec 867 — which is what keeps an untouched project behaving as it did (§6.7).
 */
export type WindowSource = "payload" | "image" | "analysed-range";

export interface PayloadWindow {
  /** the graph ctx owner — `ram/<owner>` — which is also the analysis owner */
  owner: string;
  /** what to call it in an answer: the payload's name, else the owner */
  name: string;
  space: WindowSpace;
  bank: number | null;
  start: number;
  end: number;
  source: WindowSource;
}

export const hex4 = (a: number): string => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

export const describeWindow = (w: PayloadWindow): string =>
  `${w.name} ${hex4(w.start)}-${hex4(w.end)}${w.bank !== null ? ` bank ${w.bank}` : ""} (${w.source === "payload" ? "recorded on the payload" : w.source === "image" ? "the extent of the analysed image" : "the range being analysed"})`;

/** Same space and bank — windows in different spaces never see each other. */
function comparable(a: PayloadWindow, b: PayloadWindow): boolean {
  return a.space === b.space && a.bank === b.bank;
}

/** Two payloads that load at the same address occupy ONE window. */
export function sameWindow(a: PayloadWindow, b: PayloadWindow): boolean {
  return comparable(a, b) && a.start === b.start;
}

/**
 * `inner` is a window of its own INSIDE `outer`: a different load address, wholly
 * contained. Equal starts are the same window, never nested.
 */
export function innerTo(inner: PayloadWindow, outer: PayloadWindow): boolean {
  return comparable(inner, outer) && inner.start > outer.start && inner.end <= outer.end;
}

export function covers(w: PayloadWindow, address: number): boolean {
  return address >= w.start && address <= w.end;
}

export interface ClaimantQuery {
  address: number;
  space?: WindowSpace;
  bank?: number | null;
}

export interface Supersession {
  /** the window that does NOT claim the address */
  window: PayloadWindow;
  /** the inner window that claims it instead */
  by: PayloadWindow;
}

export interface Claimants {
  address: number;
  claimants: PayloadWindow[];
  superseded: Supersession[];
}

/**
 * Who claims this address. Every window covering it, minus those an inner window
 * covering it supersedes — the load-time answer, before any question of which one
 * is in memory now.
 */
export function claimantsAt(windows: readonly PayloadWindow[], q: ClaimantQuery): Claimants {
  // A question that names no space asks every space — `graph_find`'s own rule:
  // every context that has one. A bank narrows only when a bank was given.
  const space = q.space;
  const bank = q.bank;
  const covering = windows.filter(
    (w) => covers(w, q.address)
      && (space === undefined || w.space === space)
      && (bank === undefined || bank === null || w.bank === bank),
  );
  const claimants: PayloadWindow[] = [];
  const superseded: Supersession[] = [];
  for (const w of covering) {
    const by = covering.find((v) => innerTo(v, w));
    if (by) superseded.push({ window: w, by });
    else claimants.push(w);
  }
  claimants.sort((a, b) => a.start - b.start || a.end - b.end || a.owner.localeCompare(b.owner));
  return { address: q.address, claimants, superseded };
}

/** Every window that is a hole inside `outer` — the stretches `outer` does not claim. */
export function innerWindows(windows: readonly PayloadWindow[], outer: PayloadWindow): PayloadWindow[] {
  return windows.filter((w) => innerTo(w, outer)).sort((a, b) => a.start - b.start);
}

/** The window of one owner, preferring a recorded payload window over the image's extent. */
export function windowFor(windows: readonly PayloadWindow[], owner: string): PayloadWindow | undefined {
  const mine = windows.filter((w) => w.owner === owner.toLowerCase());
  return mine.find((w) => w.source === "payload") ?? mine[0];
}

// ---------------------------------------------------------------------------
// Reading them out of the graph.

interface NodeRowLite {
  id: string;
  space: string;
  owner: string | null;
  bank: number | null;
  address: number;
  end_address: number | null;
  name: string | null;
  attrs: string;
}

const SPACES = new Set<string>(["ram", "drv", "crt"]);

function ownerOfId(id: string): string | undefined {
  const parts = id.split(":");
  if (parts.length !== 4) return undefined;
  const ctx = (parts[1] ?? "").split("/");
  return ctx.length > 1 ? ctx[1] : undefined;
}

/**
 * Every window the project records, by owner. A payload record's own window wins
 * over the extent its analysis covered; a window with no extent (a bare load
 * address, nothing to say how far it reaches) is not a window and is left out.
 */
export function loadWindows(store: GraphStore): PayloadWindow[] {
  const db = store.db;
  const out = new Map<string, PayloadWindow>();

  // D1 — the payload records. `window` is what a door wrote; without one the
  // load address and the byte length (the node's own extent) are the window.
  const payloads = db
    .prepare("SELECT id, space, owner, bank, address, end_address, name, attrs FROM nodes WHERE kind = 'payload' ORDER BY id, layer")
    .all() as unknown as NodeRowLite[];
  for (const row of payloads) {
    const owner = (row.owner ?? ownerOfId(row.id) ?? "").toLowerCase();
    if (!owner || !SPACES.has(row.space)) continue;
    let attrs: Record<string, unknown> = {};
    try { attrs = JSON.parse(row.attrs) as Record<string, unknown>; } catch { /* a row with unreadable attrs still has its columns */ }
    const payload = (attrs.payload && typeof attrs.payload === "object" ? attrs.payload : {}) as Record<string, unknown>;
    const recorded = payload.window && typeof payload.window === "object" ? payload.window as Record<string, unknown> : undefined;
    const start = typeof recorded?.start === "number" ? recorded.start
      : typeof payload.load_address === "number" ? payload.load_address
      : row.address;
    const end = typeof recorded?.end === "number" ? recorded.end : row.end_address ?? -1;
    if (end <= start) continue; // a load address with no length is not a window
    const w: PayloadWindow = {
      owner,
      name: row.name ?? owner,
      space: row.space as WindowSpace,
      bank: row.bank,
      start,
      end,
      source: "payload",
    };
    const seen = out.get(owner);
    if (!seen || seen.source !== "payload") out.set(owner, w);
  }

  // The analysed image's own extent: the segments, routines and entry points a run
  // wrote for its owner. Their union IS the mapping the image was analysed at — the
  // load address and the byte length, said by the analysis instead of by a payload
  // record. Those three kinds only, and deliberately: a `label` or a `data_block`
  // may name any address the code REFERENCES, zero page included, and would stretch
  // the window over half the machine.
  const images = db
    .prepare(
      "SELECT owner, space, bank, MIN(address) AS lo, MAX(COALESCE(end_address, address)) AS hi FROM nodes " +
      "WHERE kind IN ('segment','routine','entry') AND owner IS NOT NULL GROUP BY owner, space, bank ORDER BY owner",
    )
    .all() as unknown as Array<{ owner: string; space: string; bank: number | null; lo: number; hi: number }>;
  for (const row of images) {
    const owner = row.owner.toLowerCase();
    if (out.has(owner) || !SPACES.has(row.space) || row.hi <= row.lo) continue;
    out.set(owner, { owner, name: owner, space: row.space as WindowSpace, bank: row.bank, start: row.lo, end: row.hi, source: "image" });
  }

  return [...out.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.owner.localeCompare(b.owner));
}
