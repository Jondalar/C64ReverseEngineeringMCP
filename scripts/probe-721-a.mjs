#!/usr/bin/env node
// scripts/probe-721-a.mjs
//
// Spec 721 §3 (extraction side) — extract AssetCandidate s from a REAL medium
// (scramble_infinity.d64) and round-trip one through the Visual-Origin Join:
// place an extracted candidate's bytes into a frozen sprite, resolve it (Spec
// 710), and confirm matchVisualNodeToAsset classifies it exact_asset against the
// extracted candidate set. A non-extracted sprite → honest runtime_generated.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let extractSpriteCandidates, resolveVisibleNodeAt, matchVisualNodeToAsset;
try {
  ({ extractSpriteCandidates } = await import("../dist/runtime/headless/inspect/asset-extract.js"));
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ matchVisualNodeToAsset } = await import("../dist/runtime/headless/inspect/asset-join.js"));
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

const path = resolve("samples/scramble_infinity.d64");
if (!existsSync(path)) { console.error(`sample missing (gitignored): ${path}`); process.exit(1); }
const bytes = new Uint8Array(readFileSync(path));

console.log("Spec 721 — real extraction → AssetCandidate (scramble_infinity.d64)");

const candidates = extractSpriteCandidates(bytes, { artifactId: "scramble", mediumRef: "scramble_infinity.d64" });
gate("extraction yields many sprite candidates", candidates.length >= 100, `n=${candidates.length}`);
gate("every candidate is a sprite with hash + medium offset", candidates.every((c) => c.kind === "sprite" && c.preview?.hash?.length === 64 && typeof c.source.offset === "number" && c.source.length === 64));
gate("confidence in (0,1]", candidates.every((c) => c.confidence > 0 && c.confidence <= 1));

// round-trip: pick a high-confidence candidate, load ITS bytes into a frozen sprite.
const c = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
const block = bytes.subarray(c.source.offset, c.source.offset + 64);

function makeCp(block64) {
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
  const ram = new Uint8Array(65536);
  ram[0x07f8] = 0x80;               // sprite0 ptr → $2000
  ram.set(block64.subarray(0, 64), 0x2000);
  return { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
}

{
  const cp = makeCp(block);
  const node = resolveVisibleNodeAt(cp, 100, 70);
  gate("frozen sprite resolves", node.type === "sprite_bounds");
  const res = matchVisualNodeToAsset(cp, node, candidates);
  gate("extracted-candidate sprite → exact_asset", res.classification === "exact_asset", res.classification);
  gate("matched candidate hash == the extracted candidate's hash", res.candidate?.preview?.hash === c.preview.hash);
  gate("matched candidate is a real medium offset on scramble_infinity.d64", res.candidate?.source.mediumRef === "scramble_infinity.d64" && typeof res.candidate?.source.offset === "number");
  console.log(`        evidence: ${res.evidence}`);
}

// negative: a sprite whose bytes were NOT extracted → runtime_generated.
{
  const cp = makeCp(new Uint8Array(64).map((_, i) => (i * 211 + 99) & 0xff));
  const node = resolveVisibleNodeAt(cp, 100, 70);
  const res = matchVisualNodeToAsset(cp, node, candidates);
  gate("unknown sprite → runtime_generated (no fabricated match)", res.classification === "runtime_generated", res.classification);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721-A: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721-A: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
