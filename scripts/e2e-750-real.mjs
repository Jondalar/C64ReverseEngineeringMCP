#!/usr/bin/env node
// Spec 750 — the gate that runs against a REAL image, not a fixture it built itself.
//
// This exists because of what happened on 2026-08-12. `e2e:750-lut` was green at 66/66
// while the byte-shape detector it covered answered a real cartridge with roughly two
// false candidates per 8 KB window. Every one of those 66 checks fed the detector bytes
// written to satisfy it. A synthetic gate proves the logic and says nothing about the
// data, and on the same day two other comparisons were reported as "identical" from
// runs that never exercised the thing being compared.
//
// So this one refuses to invent its input. It reads a real `.crt` and a real
// `_analysis.json` if they are on this machine, and SKIPS LOUDLY otherwise — the
// samples are third-party property and are never committed.
//
// Set C64RE_REAL_CRT / C64RE_REAL_ANALYSIS to point it elsewhere.

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dist = (p) => join(ROOT, "dist", p);

const CRT = process.env.C64RE_REAL_CRT;
const ANALYSIS = process.env.C64RE_REAL_ANALYSIS;

if (!CRT && !ANALYSIS) {
  console.log("  SKIPPED — no real sample configured.");
  console.log("  Set C64RE_REAL_CRT (a .crt) and/or C64RE_REAL_ANALYSIS (an _analysis.json).");
  console.log("  These are never committed: they are third-party property, and a gate that");
  console.log("  needs one is a gate that cannot run on a fresh clone. That is the trade —");
  console.log("  it runs where the data is, and says nothing where it is not.");
  console.log("\nGREEN  750 real-image: skipped (no sample).");
  process.exit(0);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

// ── the container reader, against a real .crt ────────────────────────────────
if (CRT && existsSync(CRT)) {
  const { crtReader } = await import(dist("project-knowledge/lut-medium.js"));
  const { reader, banks, note } = crtReader(CRT);
  ok("a real .crt parses into CHIP packets", banks > 0, note);

  // Bytes must come back from a bank that exists and nothing from one that does not.
  let present = 0;
  for (let a = 0x8000; a < 0xa000; a++) if (reader.readByte(0, a) !== undefined) present++;
  ok("bank 0's window serves bytes", present > 0x1000, `${present} bytes readable in $8000-$9FFF`);
  ok("a bank that does not exist serves nothing",
    reader.readByte(9999, 0x8000) === undefined);
  ok("an address outside every window serves nothing",
    reader.readByte(0, 0x0400) === undefined);

  // The byte-shape scanner is the WEAK path, and this is the assertion that keeps it
  // honest: it must not flood a real image. The number is deliberately generous — the
  // point is to notice a regression into the 4-per-window sieve it started as, not to
  // pin a hit rate.
  const { detectTables } = await import(dist("project-knowledge/lut-detect.js"));
  let windows = 0, candidates = 0;
  for (let bank = 0; bank < 128; bank++) {
    for (const from of [0x8000, 0xa000]) {
      const bytes = new Uint8Array(0x2000);
      let any = 0;
      for (let i = 0; i < bytes.length; i++) {
        const b = reader.readByte(bank, from + i);
        if (b === undefined) bytes[i] = 0xff; else { bytes[i] = b; any++; }
      }
      if (!any) continue;
      windows++;
      candidates += detectTables({ bytes, baseAddress: from, bank }).length;
    }
  }
  const perWindow = candidates / Math.max(1, windows);
  ok("the byte-shape scan does not flood a real image",
    perWindow <= 3, `${candidates} candidates over ${windows} windows = ${perWindow.toFixed(1)} per window`);
  console.log(`     note: this path is weak by construction — ${perWindow.toFixed(1)} per window is still mostly noise.`);
  console.log("     Anchor on the code (analysis_path) to get a grounded answer.");
} else if (CRT) {
  console.log(`  (no .crt at ${CRT} — skipping the container checks)`);
}

// ── the ANCHOR, against a real analysis report ───────────────────────────────
if (ANALYSIS && existsSync(ANALYSIS)) {
  const { indexedAccesses, anchorCandidates } = await import(dist("project-knowledge/lut-detect.js"));
  const report = JSON.parse(readFileSync(ANALYSIS, "utf8"));
  const ins = report.codeAnalysis?.instructions ?? [];
  ok("a real analysis report carries disassembled instructions", ins.length > 0, `${ins.length}`);

  // The field this once read — a top-level `crossReferences` — does not exist in a real
  // report, and `codeAnalysis.xrefs` is control flow only. Assert both, so nobody
  // rebuilds against the schema instead of the data.
  ok("there is no top-level `crossReferences` — the schema field is not what a report has",
    report.crossReferences === undefined);
  const xrefTypes = new Set((report.codeAnalysis?.xrefs ?? []).map((x) => x.type));
  ok("`codeAnalysis.xrefs` is CONTROL FLOW only — no read/write reference exists",
    !xrefTypes.has("read") && !xrefTypes.has("write"),
    [...xrefTypes].join(","));

  const acc = indexedAccesses(ins);
  ok("indexed absolute accesses are found — these are the anchors",
    acc.length > 0, `${acc.length} in ${ins.length} instructions`);
  const cands = anchorCandidates(acc, { minColumns: 3 });
  const withPitch = cands.filter((c) => c.pitch);
  ok("some groups resolve to columns at a regular pitch",
    withPitch.length > 0, `${withPitch.length} of ${cands.length} groups`);
  ok("every anchored base is quoted with the instruction that reads it",
    cands.every((c) => c.readers.length > 0 && c.evidence.length > 0));

  // The whole reason for the anchor: a base comes from a real instruction, so it can
  // be looked up. Verify the readers are addresses that exist in the disassembly.
  const addrs = new Set(ins.map((i) => i.address));
  ok("the quoted reader addresses are real instruction addresses",
    cands.every((c) => c.readers.every((r) => addrs.has(r))));
} else if (ANALYSIS) {
  console.log(`  (no report at ${ANALYSIS} — skipping the anchor checks)`);
}

console.log(`\n${fails.length ? "RED" : "GREEN"}  750 real-image: ${pass} pass, ${fails.length} fail.`);
process.exit(fails.length ? 1 : 0);
