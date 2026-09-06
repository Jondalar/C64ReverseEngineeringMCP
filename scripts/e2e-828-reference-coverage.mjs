#!/usr/bin/env node
// Spec 828 — c64ref covers the memory map, and a miss explains itself.
//
// Hermetic: the parsers are fed c64ref-shaped text directly, so the gate needs
// no network and no snapshot. That matters twice over — the fix exists because
// a lookup must never depend on the network, and a gate that fetches would say
// the opposite of what the spec decided.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:828

import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { C64REF_SOURCE_SPECS, lookupC64RefByAddress, searchC64RefKnowledge } = await import(join(ROOT, "dist/c64ref-rom-knowledge.js"));

let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 828 — reference coverage for RAM vectors and zero page\n");

// ---------------------------------------------------------------- D1 the source list

const kinds = new Set(C64REF_SOURCE_SPECS.map((s) => s.kind));
check(kinds.has("memory_map"), `the source list carries memory_map specs (${C64REF_SOURCE_SPECS.filter((s) => s.kind === "memory_map").length})`);
check(kinds.has("symbols") || kinds.has("kernal_api"), "the source list carries symbol/API specs");
check(C64REF_SOURCE_SPECS.some((s) => s.path.includes("c64mem")), "the c64mem memory-map pages are among the sources — that is where $0291 and $0328 live");
check(C64REF_SOURCE_SPECS.every((s) => s.id && s.path && s.kind), "every spec is complete (id, path, kind)");
const ids = C64REF_SOURCE_SPECS.map((s) => s.id);
check(new Set(ids).size === ids.length, `no duplicate source id (${ids.length} specs)`);

// ---------------------------------------------------------------- D2 a miss explains itself

// The knowledge object as the loader produces it, with and without the memory map.
const romOnly = {
  generatedAt: "2026-06-01T10:00:00.000Z", sourceRepo: "x", sourceRevision: "master",
  sourceFiles: [{ id: "kernal", path: "src/kernal.txt", title: "KERNAL", kind: "kernal_api" }],
  entryCount: 4000, entries: [],
};
const full = {
  generatedAt: "2026-09-06T10:00:00.000Z", sourceRepo: "x", sourceRevision: "master",
  sourceFiles: [
    { id: "kernal", path: "src/kernal.txt", title: "KERNAL", kind: "kernal_api" },
    { id: "c64mem_mapc64", path: "src/c64mem/c64mem_mapc64.txt", title: "Mapping the C64", kind: "memory_map" },
  ],
  entryCount: 8083, entries: [],
};

// describeCoverage is internal to reference.ts, so drive it through the shape it
// reads rather than importing it: the contract is the sourceFiles' `kind`.
const hasMap = (k) => new Set((k.sourceFiles ?? []).map((f) => f.kind)).has("memory_map");
check(!hasMap(romOnly), "a ROM-only snapshot is recognised as lacking the memory map");
check(hasMap(full), "a rebuilt snapshot is recognised as covering it");

const referenceSrc = await import("node:fs").then((fs) => fs.readFileSync(join(ROOT, "src/server-tools/reference.ts"), "utf8"));
check(/function describeCoverage/.test(referenceSrc), "reference.ts has the coverage explainer");
check(/No C64Ref entry for/.test(referenceSrc), "an address miss is answered with a sentence, not an empty string");
check(/c64ref_build_rom_knowledge/.test(referenceSrc) && /Rebuild it once/.test(referenceSrc), "a ROM-only snapshot is told to rebuild — the actual cause of issue #10");
check(/genuinely not documented upstream/.test(referenceSrc), "a full snapshot says the address is genuinely undocumented, instead of implying a gap");
check(/save_finding/.test(referenceSrc), "a low-RAM miss points at the project's own knowledge, which is where a game-specific meaning belongs");
check(/coverage\.lines\(undefined\)/.test(referenceSrc), "a query miss is explained the same way as an address miss");

// ---------------------------------------------------------------- D3 no lookup-time network

const knowledgeSrc = await import("node:fs").then((fs) => fs.readFileSync(join(ROOT, "src/c64ref-rom-knowledge.js".replace(".js", ".ts")), "utf8"));
const fetchLines = knowledgeSrc.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /\bfetch\(/.test(l));
check(fetchLines.length > 0, "the BUILDER fetches (that is the one-off snapshot build, and it is fine)");
const inBuilder = fetchLines.every(([n]) => {
  const before = knowledgeSrc.split("\n").slice(0, n).join("\n");
  return /async function fetchSourceText/.test(before);
});
check(inBuilder, "every fetch sits inside fetchSourceText — the build path, never the lookup path");
// comments explain WHY the fetch was not taken, so test the code, not the prose
const referenceCode = referenceSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
check(!/fetch\(/.test(referenceCode), "the lookup tool itself never fetches: an answer must not change when the network does");
check(!/sta\.c64\.org/.test(referenceCode), "no runtime dependency on sta.c64.org in the code (issue #10's proposal, deliberately not taken)");
check(/sta\.c64\.org/.test(referenceSrc), "…and the reason it was not taken is written down where the next reader will look");

// ---------------------------------------------------------------- the lookup helpers still work

const sample = {
  ...full,
  entries: [
    { address: 0x0291, addressHex: "$0291", primaryLabel: "MODE", primaryHeading: "Flag: Enable or Disable Changing Character Sets", annotations: [], labels: ["MODE"], searchableText: "mode flag character set" },
    { address: 0x0328, addressHex: "$0328", primaryLabel: "ISTOP", primaryHeading: "Vector to Kernal STOP Routine", annotations: [], labels: ["ISTOP"], searchableText: "istop vector kernal stop routine" },
    { address: 0xffd2, addressHex: "$FFD2", primaryLabel: "CHROUT", primaryHeading: "Output a character", annotations: [], labels: ["CHROUT"], searchableText: "chrout output a character" },
  ],
};
check(lookupC64RefByAddress(sample, 0x0291)?.primaryLabel === "MODE", "$0291 resolves to MODE once the memory map is in the snapshot");
check(lookupC64RefByAddress(sample, 0x0328)?.primaryLabel === "ISTOP", "$0328 resolves to ISTOP");
check(lookupC64RefByAddress(sample, 0x1234) === undefined, "an address nobody documents still misses, and that is correct");
check(searchC64RefKnowledge(sample, "STOP", 5).some((e) => e.primaryLabel === "ISTOP"), "the search finds a memory-map entry by name");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 828: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
