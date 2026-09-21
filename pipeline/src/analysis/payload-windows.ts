// Spec 867 D1 — the window a payload occupies when it is loaded, pipeline half.
//
// THE TWIN OF `src/knowledge-graph/windows.ts`, rule for rule. `src/` is ESM and
// `pipeline/src/` is CommonJS and the two trees cannot import each other (the same
// split that gives `pipeline/src/lib/platform-kb.ts` its own 60-line reader).
// `scripts/e2e-867-window.mjs` runs BOTH implementations over one fixture graph and
// fails if their claimant answers differ, so the copy cannot drift in silence.
//
// The two rules:
//
//   same window   same space, same bank, same START. Five modules that all load at
//                 `$7400` are five occupants of ONE window, never each other's holes.
//   inner window  a window with a DIFFERENT start lying wholly inside another — a
//                 hole punched in the outer one. At an address the inner window
//                 covers, the outer payload is not the claimant.

export type WindowSpace = "ram" | "drv" | "crt";
/**
 * `payload` / `image` are recorded; `analysed-range` is the fallback for an owner
 * the project records nothing about, and it decides nothing that was not already
 * decided before Spec 867 (§6.7 — an untouched project behaves as it did).
 */
export type WindowSource = "payload" | "image" | "analysed-range";

export interface PayloadWindow {
  owner: string;
  name: string;
  space: WindowSpace;
  bank: number | null;
  start: number;
  end: number;
  source: WindowSource;
}

export const hex4 = (a: number): string => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

export function describeWindow(w: PayloadWindow): string {
  return `${w.name} ${hex4(w.start)}-${hex4(w.end)}${w.bank !== null ? ` bank ${w.bank}` : ""} (${w.source === "payload" ? "recorded on the payload" : w.source === "image" ? "the extent of the analysed image" : "the range being analysed"})`;
}

function comparable(a: PayloadWindow, b: PayloadWindow): boolean {
  return a.space === b.space && a.bank === b.bank;
}

export function sameWindow(a: PayloadWindow, b: PayloadWindow): boolean {
  return comparable(a, b) && a.start === b.start;
}

export function innerTo(inner: PayloadWindow, outer: PayloadWindow): boolean {
  return comparable(inner, outer) && inner.start > outer.start && inner.end <= outer.end;
}

export function covers(w: PayloadWindow, address: number): boolean {
  return address >= w.start && address <= w.end;
}

export interface Supersession { window: PayloadWindow; by: PayloadWindow }
export interface Claimants { address: number; claimants: PayloadWindow[]; superseded: Supersession[] }

export function claimantsAt(
  windows: readonly PayloadWindow[],
  q: { address: number; space?: WindowSpace; bank?: number | null },
): Claimants {
  const space = q.space;
  const bank = q.bank ?? null;
  const covering = windows.filter(
    (w) => covers(w, q.address) && (space === undefined || w.space === space) && (space === undefined || w.bank === bank),
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

export function innerWindows(windows: readonly PayloadWindow[], outer: PayloadWindow): PayloadWindow[] {
  return windows.filter((w) => innerTo(w, outer)).sort((a, b) => a.start - b.start);
}

export function windowFor(windows: readonly PayloadWindow[], owner: string): PayloadWindow | undefined {
  const mine = windows.filter((w) => w.owner === owner.toLowerCase());
  return mine.find((w) => w.source === "payload") ?? mine[0];
}

// ---------------------------------------------------------------------------

interface QueryableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

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

/** Every window the project records, by owner — a payload record first, the analysed image's extent otherwise. */
export function loadWindows(db: QueryableDb): PayloadWindow[] {
  const out = new Map<string, PayloadWindow>();

  const payloads = db
    .prepare("SELECT id, space, owner, bank, address, end_address, name, attrs FROM nodes WHERE kind = 'payload' ORDER BY id, layer")
    .all() as NodeRowLite[];
  for (const row of payloads) {
    const owner = (row.owner ?? ownerOfId(row.id) ?? "").toLowerCase();
    if (!owner || !SPACES.has(row.space)) continue;
    let attrs: Record<string, unknown> = {};
    try { attrs = JSON.parse(row.attrs) as Record<string, unknown>; } catch { /* the columns are still there */ }
    const payload = (attrs.payload && typeof attrs.payload === "object" ? attrs.payload : {}) as Record<string, unknown>;
    const recorded = payload.window && typeof payload.window === "object" ? payload.window as Record<string, unknown> : undefined;
    const start = typeof recorded?.start === "number" ? recorded.start
      : typeof payload.load_address === "number" ? payload.load_address
      : row.address;
    const end = typeof recorded?.end === "number" ? recorded.end : row.end_address ?? -1;
    if (end <= start) continue;
    const seen = out.get(owner);
    if (!seen || seen.source !== "payload") {
      out.set(owner, { owner, name: row.name ?? owner, space: row.space as WindowSpace, bank: row.bank, start, end, source: "payload" });
    }
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
    .all() as Array<{ owner: string; space: string; bank: number | null; lo: number; hi: number }>;
  for (const row of images) {
    const owner = row.owner.toLowerCase();
    if (out.has(owner) || !SPACES.has(row.space) || row.hi <= row.lo) continue;
    out.set(owner, { owner, name: owner, space: row.space as WindowSpace, bank: row.bank, start: row.lo, end: row.hi, source: "image" });
  }

  return [...out.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.owner.localeCompare(b.owner));
}
