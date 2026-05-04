#!/usr/bin/env node
// Sprint 93.2 — instruction-level swimlane diff between headless trace
// and a VICE runtime-trace.jsonl. Finds the first instruction where the
// two diverge.
//
// Usage:
//   node scripts/swimlane-diff.mjs --headless /tmp/headless.jsonl \
//                                  --vice /path/to/vice/runtime-trace.jsonl \
//                                  [--align-pc 0xfce2] [--max 200000]

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const k = a.slice(2); const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true;
    else { o[k] = v; i++; }
  }
  return o;
}

function parseHex(s) {
  if (typeof s !== "string") return Number(s);
  return parseInt(s.replace(/^[$0x]+/i, ""), 16);
}

async function* readJsonl(path) {
  const fh = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: fh, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip */ }
  }
  rl.close();
  fh.destroy();
}

// Normalize headless format to {n, cyc, pc, a, x, y, sp, p, op, mn}.
function normHeadless(rec) {
  if (typeof rec.pc !== "number") return null;
  return {
    cyc: rec.cyc, pc: rec.pc, a: rec.a, x: rec.x, y: rec.y,
    sp: rec.sp, p: rec.p & 0xcf, op: rec.op, mn: rec.mn ?? "",
  };
}

// Normalize VICE runtime-trace instruction event.
function normVice(ev) {
  if (ev.kind !== "instruction") return null;
  const r = ev.registers ?? {};
  if (typeof ev.pc !== "number") return null;
  const op = (ev.instructionBytes ?? [])[0] ?? 0;
  return {
    cyc: Number(ev.clock),
    pc: ev.pc,
    a: r.A ?? 0, x: r.X ?? 0, y: r.Y ?? 0,
    sp: r.SP ?? 0, p: (r.FL ?? 0) & 0xcf, op,
    mn: "",
  };
}

const args = parseArgs(process.argv.slice(2));
const hPath = args.headless;
const vPath = args.vice;
const alignPc = args["align-pc"] ? parseHex(args["align-pc"]) : 0xfce2;
const maxCmp = Number(args.max ?? 200_000);
if (!hPath || !vPath) {
  console.error("Usage: --headless <path> --vice <path> [--align-pc 0xfce2] [--max N]");
  process.exit(2);
}

console.error(`Aligning at PC=$${alignPc.toString(16)} ...`);

// Load both into arrays — both files can be large; we'll stream into
// arrays with normalization + cap to keep memory reasonable.
async function loadCap(path, normalize, cap, alignPc) {
  const out = [];
  let aligned = false;
  for await (const obj of readJsonl(path)) {
    const r = normalize(obj);
    if (!r) continue;
    if (!aligned) {
      if (r.pc === alignPc) aligned = true;
      else continue;
    }
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

const t0 = Date.now();
const [hRows, vRows] = await Promise.all([
  loadCap(hPath, normHeadless, maxCmp, alignPc),
  loadCap(vPath, normVice, maxCmp, alignPc),
]);
console.error(`Loaded headless=${hRows.length} vice=${vRows.length} (${Date.now() - t0}ms)`);

if (hRows.length === 0 || vRows.length === 0) {
  console.error(`Could not align at PC=$${alignPc.toString(16)} in one of the traces.`);
  process.exit(3);
}

const N = Math.min(hRows.length, vRows.length);
const SETTLE_ROWS = 8; // skip register diffs in first N rows (pre-TXS init)
const checkRegs = !args["pc-only"];
let firstDiff = -1;
let firstReason = "";
for (let i = 0; i < N; i++) {
  const h = hRows[i], v = vRows[i];
  if (h.pc !== v.pc) { firstDiff = i; firstReason = "PC"; break; }
  if (h.op !== v.op) { firstDiff = i; firstReason = "opcode"; break; }
  if (checkRegs && i >= SETTLE_ROWS) {
    if (h.a !== v.a) { firstDiff = i; firstReason = `A (${h.a.toString(16)} vs ${v.a.toString(16)})`; break; }
    if (h.x !== v.x) { firstDiff = i; firstReason = `X (${h.x.toString(16)} vs ${v.x.toString(16)})`; break; }
    if (h.y !== v.y) { firstDiff = i; firstReason = `Y (${h.y.toString(16)} vs ${v.y.toString(16)})`; break; }
    if (h.sp !== v.sp) { firstDiff = i; firstReason = `SP (${h.sp.toString(16)} vs ${v.sp.toString(16)})`; break; }
    if ((h.p & 0xcf) !== (v.p & 0xcf)) { firstDiff = i; firstReason = `P (${(h.p&0xcf).toString(16)} vs ${(v.p&0xcf).toString(16)})`; break; }
  }
}

const fmt = (r) => `cyc=${r.cyc} PC=$${r.pc.toString(16).padStart(4,"0")} A=${r.a.toString(16).padStart(2,"0")} X=${r.x.toString(16).padStart(2,"0")} Y=${r.y.toString(16).padStart(2,"0")} SP=${r.sp.toString(16).padStart(2,"0")} P=${(r.p&0xcf).toString(16).padStart(2,"0")} op=${r.op.toString(16).padStart(2,"0")} ${r.mn}`;

if (firstDiff < 0) {
  console.log(`OK — no divergence in first ${N} aligned instructions.`);
  process.exit(0);
}

console.log(`DIVERGENCE at row ${firstDiff} (after ${firstDiff} matched instructions). Reason: ${firstReason}`);
console.log("");
console.log("Last 5 matching:");
for (let i = Math.max(0, firstDiff - 5); i < firstDiff; i++) {
  console.log(`  H ${fmt(hRows[i])}`);
  console.log(`  V ${fmt(vRows[i])}`);
}
console.log("");
console.log("Diverging row:");
console.log(`  H ${fmt(hRows[firstDiff])}`);
console.log(`  V ${fmt(vRows[firstDiff])}`);
console.log("");
console.log("Next 4 (each side independently):");
for (let i = firstDiff + 1; i < Math.min(N, firstDiff + 5); i++) {
  console.log(`  H ${fmt(hRows[i])}`);
  console.log(`  V ${fmt(vRows[i])}`);
}
process.exit(1);
