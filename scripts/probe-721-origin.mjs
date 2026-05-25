#!/usr/bin/env node
// scripts/probe-721-origin.mjs
//
// Spec 721 (live join) — resolveVisualOrigin: the one call behind the
// `vic/inspect/origin` WS/MCP surface. Proves the LIVE path end-to-end with
// motm as the corpus, on a SEPARATE backend (never the 4312 UI session):
//
//   A) orchestration + knowledge — plant a REAL motm.g64 sprite candidate into a
//      frozen sprite, resolve it, and confirm resolveVisualOrigin returns
//      exact_asset AND a knowledge result (relation chain + finding).
//   B) live medium — start an integrated session, mount motm.g64, pull the
//      mounted-medium bytes, extract candidates (sprite+charset+bitmap > 0).
//   C) honest negative — an un-extracted sprite → runtime_generated, knowledge
//      carries only the maps-to edge (no fabricated origin).

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const MOTM = "/Users/alex/Development/C64/Cracking/Murder/motm.g64";

let resolveVisualOrigin, extractSpriteCandidates, extractAssetCandidates,
    resolveVisibleNodeAt, startIntegratedSession, stopIntegratedSession, mountMedia;
try {
  ({ resolveVisualOrigin } = await import("../dist/runtime/headless/inspect/asset-origin.js"));
  ({ extractSpriteCandidates, extractAssetCandidates } = await import("../dist/runtime/headless/inspect/asset-extract.js"));
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ mountMedia } = await import("../dist/runtime/headless/media/mount.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first"); console.error(e?.message ?? e); process.exit(1);
}

let passes = 0; const failures = [];
const gate = (n, ok, d) => { if (ok) { passes++; console.log(`  PASS  ${n}${d ? ` (${d})` : ""}`); } else { failures.push(n); console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); } };

if (!existsSync(MOTM)) { console.error(`motm.g64 missing: ${MOTM}`); process.exit(1); }
const motm = new Uint8Array(readFileSync(MOTM));

console.log("Spec 721 — live Visual-Origin Join (resolveVisualOrigin), motm corpus");

// ---- A) orchestration + knowledge: a real motm candidate, planted + resolved ----
{
  const cands = extractSpriteCandidates(motm, { artifactId: "motm", mediumRef: "g64" });
  const c = [...cands].sort((a, b) => b.confidence - a.confidence)[0];
  const block = motm.subarray(c.source.offset, c.source.offset + 64);
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
  const ram = new Uint8Array(65536); ram[0x07f8] = 0x80; ram.set(block.subarray(0, 64), 0x2000);
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  const node = resolveVisibleNodeAt(cp, 100, 70);
  gate("A: frozen sprite resolves", node.type === "sprite_bounds", node.type);
  const o = resolveVisualOrigin(cp, node, cands, { artifactId: "motm" });
  gate("A: real motm candidate → exact_asset", o.result.classification === "exact_asset", o.result.classification);
  gate("A: matched the planted candidate", o.result.candidate?.preview?.hash === c.preview.hash);
  gate("A: knowledge carries a relation chain", Array.isArray(o.knowledge.relations) && o.knowledge.relations.length > 0, `${o.knowledge.relations.length} edges`);
  gate("A: knowledge carries a durable finding", !!o.knowledge.finding?.title);
  gate("A: knowledge classification mirrors result", o.knowledge.classification === o.result.classification);
}

// ---- B) live medium: session + mount + mounted-medium extract ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  try {
    session.resetCold("pal-default");
    await mountMedia(session, 8, MOTM);
    const media = session.kernel?.drive1541?.getAttachedMedia?.();
    gate("B: mounted medium exposes bytes", !!media?.bytes?.length, media ? `${media.kind} ${media.bytes.length}B` : "none");
    const cands = media?.bytes?.length ? extractAssetCandidates(media.bytes, { artifactId: sessionId, mediumRef: media.kind }) : [];
    const byKind = cands.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
    gate("B: extract from mounted medium yields sprite+charset+bitmap", (byKind.sprite || 0) > 0 && (byKind.charset || 0) > 0 && (byKind.bitmap || 0) > 0, JSON.stringify(byKind));
  } finally {
    try { stopIntegratedSession(sessionId); } catch {}
  }
}

// ---- C) honest negative: un-extracted sprite → runtime_generated ----
{
  const cands = extractSpriteCandidates(motm, { artifactId: "motm", mediumRef: "g64" });
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
  const ram = new Uint8Array(65536); ram[0x07f8] = 0x80;
  ram.set(new Uint8Array(64).map((_, i) => (i * 211 + 99) & 0xff), 0x2000);
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  const node = resolveVisibleNodeAt(cp, 100, 70);
  const o = resolveVisualOrigin(cp, node, cands, { artifactId: "motm" });
  gate("C: un-extracted sprite → runtime_generated", o.result.classification === "runtime_generated", o.result.classification);
  gate("C: runtime_generated knowledge has only maps-to (no fabricated chain)", o.knowledge.relations.every((r) => r.relation === "maps-to"), o.knowledge.relations.map((r) => r.relation).join(","));
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721 origin: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721 origin: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
