#!/usr/bin/env node
// scripts/probe-721-j1.mjs
//
// Spec 721.J1 — Visual-Origin Join: data model + exact sprite-match PoC (NO trace).
// A sprite resolved through the real Spec 710 inspect resolver (resolveVisibleNodeAt)
// is matched to an extracted AssetCandidate by exact byte hash → `exact_asset`.
// A sprite whose bytes match no candidate → honest `runtime_generated`.

import { createHash } from "node:crypto";

let resolveVisibleNodeAt, matchVisualNodeToAsset, hashRamRange;
try {
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ matchVisualNodeToAsset, hashRamRange } = await import("../dist/runtime/headless/inspect/asset-join.js"));
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

console.log("Spec 721.J1 — Visual-Origin Join (exact sprite-match)");

// --- a known 64-byte sprite block + its AssetCandidate (as an extraction would emit) ---
const sprite = new Uint8Array(64);
for (let i = 0; i < 64; i++) sprite[i] = (i * 37 + 11) & 0xff; // deterministic pattern
const spriteHash = createHash("sha256").update(sprite).digest("hex");
const candidate = {
  id: "asset_sprite_0", artifactId: "art_test",
  kind: "sprite",
  source: { fileRef: "title.prg", offset: 0x2000, length: 64 },
  format: "sprite-24x21",
  preview: { hash: spriteHash },
  confidence: 1,
};
const other = {
  id: "asset_sprite_1", artifactId: "art_test",
  kind: "sprite", source: { fileRef: "title.prg", offset: 0x2040, length: 64 },
  format: "sprite-24x21", preview: { hash: createHash("sha256").update(new Uint8Array(64).fill(0xaa)).digest("hex") }, confidence: 1,
};

// --- synthetic frozen checkpoint: sprite 0 enabled, pointer → $2000 holding the blob ---
function makeCp(blockBytes) {
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14;        // screen $0400 → sprite ptr at $07F8
  regs[0x15] = 0x01;        // sprite 0 enabled
  regs[0x00] = 88; regs[0x01] = 80; // X=88, Y=80 (in display)
  regs[0x27] = 0x01;
  const ram = new Uint8Array(65536);
  ram[0x07f8] = 0x80;       // sprite0 ptr → $80*64 = $2000
  ram.set(blockBytes.subarray(0, 64), 0x2000);
  return { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
}

// EXACT: the inspected sprite's RAM bytes == the candidate.
{
  const cp = makeCp(sprite);
  // visible coords inside sprite0: x=88-24+32=96.., y=80-16=64..
  const node = resolveVisibleNodeAt(cp, 100, 70);
  gate("inspect resolves sprite_bounds", node.type === "sprite_bounds" && node.value === 0, node.type);
  const sd = node.refs.find((r) => r.kind === "sprite_data");
  gate("sprite_data ref @ $2000 (ptr*64)", sd?.addr === 0x2000, `addr=$${sd?.addr.toString(16)}`);
  gate("hashRamRange matches the candidate hash", hashRamRange(cp, 0x2000, 64) === spriteHash);
  const res = matchVisualNodeToAsset(cp, node, [other, candidate]);
  gate("EXACT → classification = exact_asset", res.classification === "exact_asset", res.classification);
  gate("EXACT → matched candidate = asset_sprite_0 @ title.prg+$2000", res.candidate?.id === "asset_sprite_0" && res.candidate?.source.offset === 0x2000, `${res.candidate?.id}`);
  gate("EXACT → result carries the memory range + ramHash", res.memoryRange.addr === 0x2000 && res.ramHash === spriteHash);
  console.log(`        evidence: ${res.evidence}`);
}

// RUNTIME_GENERATED: a sprite whose bytes match no candidate.
{
  const cp = makeCp(new Uint8Array(64).map((_, i) => (i * 5 + 3) & 0xff)); // different pattern
  const node = resolveVisibleNodeAt(cp, 100, 70);
  const res = matchVisualNodeToAsset(cp, node, [candidate, other]);
  gate("NO MATCH → classification = runtime_generated (honest, no fabricated link)", res.classification === "runtime_generated", res.classification);
  gate("NO MATCH → no candidate attached", !res.candidate);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721.J1: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721.J1: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
