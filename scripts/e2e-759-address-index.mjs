#!/usr/bin/env node
// Spec 759 P1 — project address-knowledge index gate.
// A 2-artifact fixture (engine + caller): the index resolves a cross-file
// address to the OWNING artifact + its label/kind, surfaces overlap, and caches.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/project-knowledge/address-index.js"))) { console.error("build:mcp first"); process.exit(2); }
const { buildAddressIndex, resolveCrossArtifact, loadAddressIndex } =
  await import("../dist/project-knowledge/address-index.js");

console.log("Spec 759 — project address-knowledge index\n");

const dir = mkdtempSync(join(tmpdir(), "c64re-759-"));
const seg = (kind, start, end, label) => ({ kind, start, end, label });
// Engine: API table $0200-$04FF + body. Caller (game): block at $7E00.
mkdirSync(join(dir, "engine"), { recursive: true });
mkdirSync(join(dir, "game"), { recursive: true });
writeFileSync(join(dir, "engine", "block2_engine_0200_analysis.json"), JSON.stringify({
  segments: [seg("pointer_table", 0x0200, 0x04ff, "api_table"), seg("code", 0x2514, 0x2540, "turn_advance")],
}));
writeFileSync(join(dir, "game", "block3_game_7E00_analysis.json"), JSON.stringify({
  segments: [seg("code", 0x7e00, 0x7e02, "block3_entry"), seg("code", 0x7e03, 0x7eff)],
}));
// An overlay sharing $7E00 (overlap/banking case, OQ2).
writeFileSync(join(dir, "game", "char_overlay_7E00_analysis.json"), JSON.stringify({
  segments: [seg("code", 0x7e00, 0x7e40, "overlay_entry")],
}));

const idx = buildAddressIndex(dir);
ok("1 index aggregates segments across artifacts", idx.length >= 5, `${idx.length} entries`);
ok("2 index spans all three owners", new Set(idx.map((e) => e.owner)).size === 3);

const apiHit = resolveCrossArtifact(dir, 0x0250);
ok("3 a cross-file address resolves to the OWNING artifact + label",
  apiHit[0]?.owner === "block2_engine_0200" && apiHit[0]?.label === "api_table" && apiHit[0]?.kind === "pointer_table",
  apiHit[0] ? `${apiHit[0].owner}:${apiHit[0].label}` : "(none)");

const tgtHit = resolveCrossArtifact(dir, 0x2520);
ok("4 the JMP target region resolves to its routine label",
  tgtHit[0]?.owner === "block2_engine_0200" && tgtHit[0]?.label === "turn_advance");

const overlap = resolveCrossArtifact(dir, 0x7e01);
ok("5 overlap ($7E00 game + overlay) returns BOTH owners (ambiguity surfaced)",
  overlap.length === 2 && overlap.some((h) => h.owner === "block3_game_7E00") && overlap.some((h) => h.owner === "char_overlay_7E00"),
  `${overlap.length} owners`);
ok("6 overlap is tightest-segment-first (game $7E00..$7E02 before overlay $7E00..$7E40)",
  overlap[0].end - overlap[0].start <= overlap[1].end - overlap[1].start);

const miss = resolveCrossArtifact(dir, 0x9000);
ok("7 an unowned address resolves to nothing", miss.length === 0);

ok("8 excludeOwner drops the querying artifact (cross-file only)",
  resolveCrossArtifact(dir, 0x7e01, { excludeOwner: "char_overlay_7E00" }).every((h) => h.owner !== "char_overlay_7E00"));

// Cache: a second load returns the same data + writes the cache file.
const cached = loadAddressIndex(dir);
ok("9 cached load returns the index", cached.length === idx.length);
ok("9b cache file written under knowledge/.cache", existsSync(join(dir, "knowledge", ".cache", "address-index.json")));

console.log(`\nSpec 759 address-index: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
