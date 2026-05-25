#!/usr/bin/env node
// scripts/probe-721-j2.mjs
//
// Spec 721.J2 — trace-backed derived-asset resolution.
//   Part A: resolver logic with a synthetic TraceChainSource (deterministic).
//   Part B: the DuckDB adapter (loadTraceChainSourceFromDuckDb) over real 708
//           `io` trace_event rows → same resolver → derived_asset.
// On-screen bytes have NO exact match; the trace writer/source chain resolves
// them back to a packed AssetCandidate on the medium ⇒ derived_asset (depack).

import { createHash } from "node:crypto";

let resolveVisibleNodeAt, matchVisualNodeToAsset, resolveDerivedAsset;
let openTraceRunStore, closeTraceRunStore, loadTraceChainSourceFromDuckDb;
try {
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ matchVisualNodeToAsset, resolveDerivedAsset } = await import("../dist/runtime/headless/inspect/asset-join.js"));
  ({ loadTraceChainSourceFromDuckDb } = await import("../dist/runtime/headless/inspect/asset-join-tracedb.js"));
  ({ openTraceRunStore, closeTraceRunStore } = await import("../dist/runtime/headless/trace/trace-run-store.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let passes = 0; const failures = [];
const gate = (name, ok, detail) => {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

console.log("Spec 721.J2 — trace-backed derived-asset");

// packed source (on the medium, loaded to $8000) + the UNPACKED sprite on screen ($2000).
const packed = new Uint8Array(40).map((_, i) => (i * 13 + 7) & 0xff);
const unpacked = new Uint8Array(64).map((_, i) => (i * 91 + 5) & 0xff); // != packed, != any candidate
const packedHash = createHash("sha256").update(packed).digest("hex");
const packedCandidate = {
  id: "asset_packed_0", artifactId: "art", kind: "sprite",
  source: { mediumRef: "title.d64", offset: 0x1000, length: 40 },
  format: "sprite-exomizer", preview: { hash: packedHash }, confidence: 1,
};

function makeCp() {
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
  const ram = new Uint8Array(65536);
  ram[0x07f8] = 0x80;                 // sprite0 ptr → $2000
  ram.set(unpacked, 0x2000);          // on-screen sprite = UNPACKED bytes
  ram.set(packed, 0x8000);            // depack SOURCE in RAM (packed)
  return { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
}

const cp = makeCp();
const node = resolveVisibleNodeAt(cp, 100, 70); // sprite_bounds, sprite_data @ $2000

// ---- Part A — synthetic TraceChainSource ----
{
  const synthSource = { writerOf: (addr, len) => (addr === 0x2000 ? { pc: 0xc000, reads: [{ addr: 0x8000, length: 40 }] } : null) };
  const noWriter = { writerOf: () => null };

  const r = matchVisualNodeToAsset(cp, node, [packedCandidate], synthSource);
  gate("A on-screen sprite has NO exact match but resolves derived_asset", r.classification === "derived_asset", r.classification);
  gate("A derived candidate = the packed asset on the medium", r.candidate?.id === "asset_packed_0");
  gate("A chain = writer $C000 + depack from $8000", JSON.stringify(r.chain).includes('"depack"') && JSON.stringify(r.chain).includes("49152"));
  console.log(`        evidence: ${r.evidence}`);

  const noTrace = matchVisualNodeToAsset(cp, node, [packedCandidate]);
  gate("A no trace source → runtime_generated (J1 behaviour)", noTrace.classification === "runtime_generated");
  const noW = matchVisualNodeToAsset(cp, node, [packedCandidate], noWriter);
  gate("A trace but no writer → runtime_generated (honest)", noW.classification === "runtime_generated");
}

// ---- Part B — real DuckDB adapter over 708 io events ----
{
  const store = await openTraceRunStore(":memory:");
  try {
    const ev = (op, addr, pc) => `('r1', 0, 0, 'io', 't', 'io-row', '{"op":"${op}","addr":${addr},"value":0,"pc":${pc}}')`;
    const rows = [ev("write", 0x2000, 0xc000)];                 // writer wrote the display range
    for (let a = 0x8000; a < 0x8028; a++) rows.push(ev("read", a, 0xc000)); // read the packed source $8000..$8027
    rows.push(ev("read", 0x4000, 0xe123));                       // unrelated reads by another PC (noise)
    await store.conn.run(`INSERT INTO trace_event VALUES ${rows.join(", ")}`);

    const source = await loadTraceChainSourceFromDuckDb(store, "r1");
    const w = source.writerOf(0x2000, 64);
    gate("B DuckDB adapter: writerOf($2000) → pc $C000", w?.pc === 0xc000, `pc=$${w?.pc?.toString(16)}`);
    gate("B DuckDB adapter: read source merged to $8000..+40", w?.reads?.some((rr) => rr.addr === 0x8000 && rr.length === 40), JSON.stringify(w?.reads));

    const r = resolveDerivedAsset(cp, { addr: 0x2000, length: 64 }, [packedCandidate], source);
    gate("B real-trace chain → derived_asset (packed asset)", r?.classification === "derived_asset" && r?.candidate?.id === "asset_packed_0", r?.classification);
    console.log(`        evidence: ${r?.evidence}`);
  } finally { await closeTraceRunStore(store); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721.J2: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721.J2: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
