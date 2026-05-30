// BUG-019 (Part A) — the Disk file inspector / payload action must default to
// the CURRENT BEST source version, not the stale generated *_disasm.asm. The
// repro: a project has both `02_2.0_disasm.asm` (role "disasm", kickass) and
// `02_2.0_semantic.tass` (role "64tass-source") — the UI defaulted to the stale
// .asm because the returned sources were ordered kickass-first regardless of
// priority. Fix: rank generated disasm lowest + order best-first by priority.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-019 (A) — inspector defaults to the best source version\n");

const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");

// ---- source-level: the ranking rules + best-first sort exist ----
const prio = app.slice(app.indexOf("function asmArtifactPriority"), app.indexOf("function bestAsmSourcesForArtifacts"));
ok(/case "disasm":\s*\n\s*case "disasm-tass":\s*\n\s*base = 100/.test(prio), "1 generated disasm/disasm-tass ranked lowest (100)", "");
ok(/"64tass-source":\s*\n\s*base = 300/.test(prio) || /case "64tass-source":[\s\S]*?base = 300/.test(prio), "2 *-source curated ranked high (300)", "");
ok(/_semantic\\?\./.test(prio) && /\+= 50/.test(prio), "3 _semantic path gets a curated nudge", "");
const best = app.slice(app.indexOf("function bestAsmSourcesForArtifacts"), app.indexOf("function binaryArtifactPriority"));
ok(/asmArtifactPriority\(right\) - asmArtifactPriority\(left\)/.test(best), "4 returned sources ordered BEST-FIRST by priority", "");
ok(!/\.sort\(\(\[left\], \[right\]\) => dialectOrder/.test(best), "5 old dialect-first ordering removed", "");

// ---- behavioral: replicate the exact rules and assert the repro outcome ----
// (mirrors asmArtifactPriority + bestAsmSourcesForArtifacts ordering)
const dialectOf = (p) => p.toLowerCase().endsWith(".tass") ? "64tass" : p.toLowerCase().endsWith(".asm") ? "kickass" : "plain";
function priority(a) {
  let base;
  switch (a.role) {
    case "final-kickassembler-source": case "final-64tass-source": base = 400; break;
    case "kickassembler-source": case "64tass-source": base = 300; break;
    case "disasm": case "disasm-tass": base = 100; break;
    default: base = 200; break;
  }
  if (/_semantic\./i.test(a.relativePath)) base += 50;
  return base;
}
function bestFirst(arts) {
  const byDialect = new Map();
  for (const a of arts) {
    const d = dialectOf(a.relativePath);
    const cur = byDialect.get(d);
    if (!cur || priority(a) > priority(cur)) byDialect.set(d, a);
  }
  const order = { kickass: 0, "64tass": 1, plain: 2 };
  return [...byDialect.values()].sort((l, r) => (priority(r) - priority(l)) || (order[dialectOf(l.relativePath)] - order[dialectOf(r.relativePath)]));
}

const repro = [
  { id: "asm", role: "disasm", relativePath: "analysis/disk/wl/02_2.0_disasm.asm" },
  { id: "tass", role: "64tass-source", relativePath: "analysis/disk/wl/02_2.0_semantic.tass" },
];
const ordered = bestFirst(repro);
ok(ordered[0].id === "tass", "6 repro: best source is the semantic .tass, NOT the stale _disasm.asm", `first=${ordered[0].id}`);
// a hand-made .asm with no role must beat the generated _disasm.asm
const hand = bestFirst([
  { id: "gen", role: "disasm", relativePath: "x/foo_disasm.asm" },
  { id: "hand", role: undefined, relativePath: "x/foo_hand.asm" },
]);
ok(hand[0].id === "hand", "7 hand-made (no-role) .asm outranks generated _disasm.asm", `first=${hand[0].id}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug019: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
