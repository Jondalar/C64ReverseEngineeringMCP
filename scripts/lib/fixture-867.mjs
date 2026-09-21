// Spec 867 — the fixture both 867 gates are built on: a machine made of overlays.
//
//   six modules  mod_a … mod_f, all loading at $1000 with different lengths — ONE
//                window with six occupants. Each one's routine at $1000 carries a
//                different immediate byte, because residency is decided by BYTES and
//                six payloads whose code is identical cannot be told apart by them.
//                mod_c also carries a payload record (its window and its first
//                sector); mod_f's record says it occupies LESS than the image it was
//                analysed at.
//   wide         $0A00-$50FF, a payload spanning half the machine, with the engine
//                and the whole $1000 family loading INSIDE it.
//   engine       $4300-$43FF, a window of its own inside `wide`'s span.
//   loader       calls into every window, and calls ONE load routine from three
//                sites with three different track/sector pairs — Spec 750.4's shape,
//                and what makes it a loader rather than two constants and a call.
//
// `scripts/e2e-867-window.mjs` uses it hermetically; `scripts/smoke-867-residency.mjs`
// loads the same images into a real machine and asks the same question of the bytes.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
export const CLI = join(ROOT, "dist/pipeline/cli.cjs");
export const SLUG = "fixture";

/** `lda #$nn / sta $D020 / rts` — six bytes that decode and end. */
export const ROUTINE = (at, mark = 0x01) => [at, 0xa9, mark, 0x8d, 0x20, 0xd0, 0x60];
/** An immediate track, an immediate sector, then the call. Seven bytes. */
export const SECTOR_LOAD = (at, track, sector, target) => [at, 0xa9, track, 0xa2, sector, 0x20, target & 0xff, target >> 8];

export const MODULES = [
  { owner: "mod_a", load: 0x1000, end: 0x10ff, mark: 0x10 },
  { owner: "mod_b", load: 0x1000, end: 0x117f, mark: 0x11 },
  { owner: "mod_c", load: 0x1000, end: 0x11ff, mark: 0x12 },
  { owner: "mod_d", load: 0x1000, end: 0x127f, mark: 0x13 },
  { owner: "mod_e", load: 0x1000, end: 0x12ff, mark: 0x14 },
  { owner: "mod_f", load: 0x1000, end: 0x11ff, mark: 0x15 },
];
export const WIDE = { owner: "wide", load: 0x0a00, end: 0x50ff };
export const ENGINE = { owner: "engine", load: 0x4300, end: 0x43ff };
export const LOADER = { owner: "loader", load: 0x0300, end: 0x03ff };
/** The call site whose track/sector pair is mod_c's. */
export const MOD_C_LOAD_CALL = 0x0304;

/** A PRG whose filler is $02 (JAM), so nothing decodes that was not seeded. */
export function writePrg(dir, owner, load, end, blocks) {
  const body = Buffer.alloc(end - load + 1, 0x02);
  for (const b of blocks) { const [at, ...bytes] = b; for (let i = 0; i < bytes.length; i += 1) body[at - load + i] = bytes[i]; }
  const path = join(dir, "analysis", `${owner}.prg`);
  writeFileSync(path, Buffer.from([load & 0xff, load >> 8, ...body]));
  return path;
}

export function writeGraph(dir, rows, ddl) {
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"));
  db.exec(ddl);
  const n = db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,'static','inferred','867','[]')");
  for (const r of rows.nodes) n.run(r.id, r.layer, r.kind, r.space, r.owner ?? null, r.owner ?? null, r.address, r.endAddress ?? null, r.name ?? null, r.attrs ?? "{}");
  const e = db.prepare("INSERT OR REPLACE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,'generated',?,'static','inferred',?,?,'{}')");
  for (const r of rows.edges) e.run(r.from, r.type, r.to, r.key ?? "", r.producer ?? "867", r.owner ?? null);
  db.close();
}

/**
 * Write the images and the graph into `dir`. Returns the descriptors plus the rows,
 * so a gate can write a variant of the same graph (a project with no recorded
 * window, for instance) without rebuilding the fixture.
 */
export function buildFixture(dir, ddl) {
  mkdirSync(join(dir, "analysis"), { recursive: true });
  for (const m of MODULES) m.prg = writePrg(dir, m.owner, m.load, m.end, [ROUTINE(0x1000, m.mark), ROUTINE(m.end - 0x0f, m.mark)]);
  WIDE.prg = writePrg(dir, WIDE.owner, WIDE.load, WIDE.end, [ROUTINE(0x0b00, 0x21), ROUTINE(0x4310, 0x22), ROUTINE(0x1000, 0x23)]);
  ENGINE.prg = writePrg(dir, ENGINE.owner, ENGINE.load, ENGINE.end, [ROUTINE(0x4310, 0x31), ROUTINE(0x4320, 0x32)]);
  // Seven bytes each, back to back, so the descent walks all three: a JAM byte
  // between them would end the walk at the first.
  LOADER.prg = writePrg(dir, LOADER.owner, LOADER.load, LOADER.end, [
    SECTOR_LOAD(0x0300, 18, 1, 0x0380),
    SECTOR_LOAD(0x0307, 19, 4, 0x0380),
    SECTOR_LOAD(0x030e, 20, 7, 0x0380),
    [0x0315, 0x60],
    ROUTINE(0x0380, 0x41),
  ]);

  const nodes = [];
  const edges = [];
  const addr = (a) => `${SLUG}:ram:addr:${a.toString(16).padStart(4, "0")}`;
  const rid = (owner, kind, a) => `${SLUG}:ram/${owner}:${kind}:${a.toString(16).padStart(4, "0")}`;
  const node = (id, kind, owner, address, endAddress, extra = {}) =>
    nodes.push({ id, layer: extra.layer ?? "generated", kind, space: "ram", owner, address, endAddress, name: extra.name ?? null, attrs: extra.attrs ?? "{}" });

  for (const m of MODULES) {
    node(rid(m.owner, "segment", m.load), "segment", m.owner, m.load, m.end);
    node(rid(m.owner, "routine", 0x1000), "routine", m.owner, 0x1000, 0x1005, { name: `W1000_${m.owner}` });
  }
  node(rid(WIDE.owner, "segment", WIDE.load), "segment", WIDE.owner, WIDE.load, WIDE.end);
  node(rid(ENGINE.owner, "segment", ENGINE.load), "segment", ENGINE.owner, ENGINE.load, ENGINE.end);
  node(rid(LOADER.owner, "segment", LOADER.load), "segment", LOADER.owner, LOADER.load, LOADER.end);

  // D1 — a payload record with the window written on it, the way a door writes it.
  const payloadAttrs = (load, window, spans) => JSON.stringify({
    door: true, legacy_kind: "payload",
    payload: { load_address: load, ...(window ? { window } : {}), format: "prg" },
    ...(spans ? { medium_spans: spans } : {}),
  });
  node(rid(WIDE.owner, "payload", WIDE.load), "payload", WIDE.owner, WIDE.load, WIDE.end, {
    layer: "human", name: "wide", attrs: payloadAttrs(WIDE.load, { start: WIDE.load, end: WIDE.end }),
  });
  node(rid("mod_c", "payload", 0x1000), "payload", "mod_c", 0x1000, 0x11ff, {
    layer: "human", name: "mod_c",
    attrs: payloadAttrs(0x1000, { start: 0x1000, end: 0x11ff }, [{ kind: "sector", track: 18, sector: 1, offsetInSector: 0, length: 254 }]),
  });
  // mod_f's record says it occupies LESS than the image it was analysed at: the
  // window is the recorded fact, and an address past it is out of scope.
  node(rid("mod_f", "payload", 0x1000), "payload", "mod_f", 0x1000, 0x10ff, {
    layer: "human", name: "mod_f", attrs: payloadAttrs(0x1000, { start: 0x1000, end: 0x10ff }),
  });

  // Who calls into whom. The graph resolves $1000 to mod_a's routine, which before
  // 867 refused that address for the other five.
  for (const a of [0x1000, 0x0b00, 0x4310, 0x1180]) {
    node(addr(a), "addr", null, a, null);
    edges.push({ from: rid(LOADER.owner, "segment", LOADER.load), type: "CALLS", to: addr(a), key: `src:03${a.toString(16)}`, owner: LOADER.owner });
  }
  edges.push({ from: addr(0x1000), type: "RESOLVES_TO", to: rid("mod_a", "routine", 0x1000), producer: "826r" });

  writeGraph(dir, { nodes, edges }, ddl);
  return { nodes, edges, rid, addr };
}

/** Run the bundled analyzer on one image, into `<dir>/analysis/<owner>_analysis.json`. */
export function analyze(dir, owner, prg) {
  const out = join(dir, "analysis", `${owner}_analysis.json`);
  execFileSync(process.execPath, [CLI, "analyze-prg", prg, out, "--no-register"], {
    stdio: "pipe",
    env: { ...process.env, C64RE_PROJECT_DIR: dir },
  });
  return JSON.parse(readFileSync(out, "utf8"));
}
