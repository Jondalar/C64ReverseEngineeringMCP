#!/usr/bin/env node
// scripts/probe-721-charset-bitmap.mjs
//
// Spec 721 (extraction) — charset (2KB set) + bitmap (8KB image) AssetCandidate
// kinds. Match a frozen text/bitmap cell to the WHOLE set/image (not one cell):
// charBase 2KB → charset-2k candidate; bitmapBase 8KB → bitmap-hires candidate.
// Plus real extraction over motm.g64 (counts).

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

let extractCharsetCandidates, extractBitmapCandidates, extractAssetCandidates;
let resolveVisibleNodeAt, matchVisualNodeToAsset;
try {
  ({ extractCharsetCandidates, extractBitmapCandidates, extractAssetCandidates } = await import("../dist/runtime/headless/inspect/asset-extract.js"));
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ matchVisualNodeToAsset } = await import("../dist/runtime/headless/inspect/asset-join.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first"); console.error(e?.message ?? e); process.exit(1);
}

let passes = 0; const failures = [];
const gate = (n, ok, d) => { if (ok) { passes++; console.log(`  PASS  ${n}${d ? ` (${d})` : ""}`); } else { failures.push(n); console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

console.log("Spec 721 — charset + bitmap asset kinds");

// ---- charset: 2KB set at $2000 (d018=$18: screen $0400, char $2000) ----
{
  const set = new Uint8Array(0x800).map((_, i) => (i * 7 + 3) & 0xff);
  const cand = { id: "a:chr:0", artifactId: "a", kind: "charset", source: { fileRef: "f", offset: 0, length: 0x800 }, format: "charset-2k", preview: { hash: sha(set) }, confidence: 1 };
  const regs = new Array(0x40).fill(0); regs[0x18] = 0x18; // screen $0400, char $2000 (no shadow)
  const ram = new Uint8Array(65536); ram.set(set, 0x2000); ram[0x0400 + 1 * 40 + 4] = 0x2a;
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  const node = resolveVisibleNodeAt(cp, 200, 80); // a text cell in display
  gate("charset: node is text_cell", node.type === "text_cell", node.type);
  const r = matchVisualNodeToAsset(cp, node, [cand]);
  gate("charset: 2KB set → exact_asset (charset-2k)", r.classification === "exact_asset" && r.candidate?.kind === "charset", r.classification);
  gate("charset: matched the whole 2KB set base", r.memoryRange.addr === 0x2000 && r.memoryRange.length === 0x800, `$${r.memoryRange.addr.toString(16)}+${r.memoryRange.length}`);
}

// ---- bitmap: 8KB hires image at $2000 (d011 bmm, d018 bit3) ----
{
  const img = new Uint8Array(8000).map((_, i) => (i * 13 + 1) & 0xff);
  const cand = { id: "a:bmp:0", artifactId: "a", kind: "bitmap", source: { fileRef: "f", offset: 0, length: 8000 }, format: "bitmap-hires", preview: { hash: sha(img) }, confidence: 1 };
  const regs = new Array(0x40).fill(0); regs[0x11] = 0x3b; regs[0x16] = 0x08; regs[0x18] = 0x18; // bmm, hires, bitmap $2000
  const ram = new Uint8Array(65536); ram.set(img, 0x2000);
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  const node = resolveVisibleNodeAt(cp, 200, 80);
  gate("bitmap: node is bitmap_cell (hires)", node.type === "bitmap_cell", node.type + "/" + node.mode);
  const r = matchVisualNodeToAsset(cp, node, [cand]);
  gate("bitmap: 8KB image → exact_asset (bitmap-hires)", r.classification === "exact_asset" && r.candidate?.kind === "bitmap", r.classification);
  gate("bitmap: matched the whole 8KB image base", r.memoryRange.addr === 0x2000 && r.memoryRange.length === 8000, `$${r.memoryRange.addr.toString(16)}+${r.memoryRange.length}`);
}

// ---- real extraction over motm.g64 ----
{
  const p = "/Users/alex/Development/C64/Cracking/Murder/motm.g64";
  if (existsSync(p)) {
    const bytes = new Uint8Array(readFileSync(p));
    const all = extractAssetCandidates(bytes, { artifactId: "motm", mediumRef: "motm.g64" });
    const byKind = all.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
    gate("real motm.g64: extractAssetCandidates yields sprite+charset+bitmap", (byKind.sprite || 0) > 0 && (byKind.charset || 0) > 0 && (byKind.bitmap || 0) > 0, JSON.stringify(byKind));
    gate("real motm.g64: every candidate hashed + offset", all.every((c) => c.preview?.hash?.length === 64 && typeof c.source.offset === "number"));
  } else {
    console.log("  SKIP  motm.g64 not present");
  }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721 charset/bitmap: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721 charset/bitmap: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
