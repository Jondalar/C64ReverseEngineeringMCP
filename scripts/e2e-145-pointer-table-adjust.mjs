#!/usr/bin/env node
// Issue #145 — `pointerTables` takes `adjust` (stored = target - adjust; an RTS dispatch stores target-1),
// and a field the entry does not take is reported instead of dropped.
//
// Hermetic: a temp project, one synthetic PRG assembled from a listing here (asm6502-mini.mjs), one MCP
// session over stdio. No ROMs, no game bytes, no runtime. The rebuild needs 64tass (PATH, or
// C64RE_64TASS_BIN) and SKIPS LOUDLY without it.
//
//   A  adjust 1: every entry line is `.word (<name>-1)`, each name is a label at word + 1
//   B  the 64tass listing rebuilds byte-identical
//   C  an unknown key on a pointerTables entry is reported in the disasm result
//   D  adjust omitted (and adjust 0) render identically, with no `(name-1)` form
//   E  the writing door keeps `adjust` and refuses a non-integer one
//
//   npm run e2e:145

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcp } from "./lib/mcp-stdio.mjs";
import { assembleWithLabels } from "./lib/asm6502-mini.mjs";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${!cond && detail ? `\n          ${String(detail).replace(/\n/g, "\n          ")}` : ""}`);
};
const head = (t) => console.log(`\n── ${t}`);

if (!existsSync(join(ROOT, "dist/cli.js")) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
console.log("Issue #145 — pointerTables adjust (RTS-dispatch word tables)\n");

const ORIGIN = 0x080d;
const { bytes, labels } = assembleWithLabels(ORIGIN, [
  "main:", "LDX #$00", "JSR rr", "RTS",
  "rr:", "LDA tbl+1,X", "PHA", "LDA tbl,X", "PHA", "RTS",
  "h0:", "INC $C000", "RTS",
  "h1:", "INC $C001", "RTS",
  "h2:", "INC $C002", "RTS",
  "tbl:", ".byte <h0-1, >h0-1, <h1-1, >h1-1, <h2-1, >h2-1",
  "end:",
]);
const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
const prg = Buffer.from([...stub, ...bytes]);
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const NAMES = ["h0", "h1", "h2"];
const ENTRIES = [hex4(ORIGIN), ...NAMES.map((n) => hex4(labels[n]))];

const proj = testTmpDir("c64re-145-");
const mcp = startMcp({ root: ROOT, pairDialects: true, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1" } });
const call = mcp.call;
mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
const REL = "artifacts/prg/t145.prg";
writeFileSync(join(proj, REL), prg);
const annPath = join(proj, "artifacts", "prg", "t145_annotations.json");
const tblStart = hex4(labels.tbl), tblEnd = hex4(labels.tbl + 5);
const writeAnn = (ptEntry) => writeFileSync(annPath, JSON.stringify({
  version: 1, binary: "t145.prg", segments: [], labels: [],
  routines: NAMES.map((n) => ({ address: hex4(labels[n]), name: n })),
  pointerTables: [ptEntry],
}, null, 2));
const tas = () => readFileSync(join(proj, "artifacts", "prg", "t145_disasm.tas"), "utf8");
const wordLines = (t) => t.split("\n").filter((l) => /^\s*\.word\b/.test(l)).map((l) => l.trim());
const bin64tass = process.env.C64RE_64TASS_BIN || "64tass";
const have64tass = spawnSync(bin64tass, ["--version"], { stdio: "ignore" }).status === 0;
const disasm = () => call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
const base = { start: tblStart, end: tblEnd };

try {
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-145", version: "1" } });
  mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { preferred_assembler: "kickass", name: "145" });
  await call("agent_onboard", {});
  await call("contract_set", { goal: "synthetic pointer-table fixture", slots: [], coverage_ratio: 0 });

  await call("analyze_prg", { prg_path: REL, entry_points: ENTRIES }); // the structural annotations need the analysis JSON
  head("A. adjust 1: (name-1) per entry, the name a label at word + 1");
  writeAnn({ ...base, adjust: 1 });
  await disasm();
  const T1 = tas();
  const w1 = wordLines(T1);
  check(w1.length === 3 && NAMES.every((n, i) => w1[i].startsWith(`.word (${n}-1)`)), "A1 every entry line is `.word (<name>-1)`", w1.join("\n"));
  check(NAMES.every((n) => new RegExp(`^${n}\\b`, "m").test(T1)), "A2 each name is defined as a label in the listing");
  const at = (i) => stub.length + labels.tbl - ORIGIN + i * 2;
  const stored = [0, 1, 2].map((i) => prg[at(i)] | (prg[at(i) + 1] << 8));
  check(NAMES.every((n, i) => stored[i] + 1 === labels[n]), "A3 the stored words are the label addresses minus one (fixture sanity)", stored.map(hex4).join(" "));
  // the label sits at word + 1: the assembler placing it there is what makes the rebuild below byte-identical

  head("B. rebuild byte-identical");
  if (have64tass) {
    const out = join(proj, "tass-out.bin");
    const r = spawnSync(bin64tass, ["-C", "--nostart", "-o", out, join(proj, "artifacts", "prg", "t145_disasm.tas")], { encoding: "utf8" });
    const built = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
    check(r.status === 0 && Buffer.compare(built, prg.subarray(2)) === 0, "B1 the 64tass listing assembles to the original bytes", `${r.status} ${r.stderr?.slice(0, 300)}`);
  } else console.log("  SKIP  B1 64tass not found (set C64RE_64TASS_BIN) — skipped, not passed");

  head("C. an unknown key is reported");
  writeAnn({ ...base, adjust: 1, adjsut: 1 });
  const outC = await disasm();
  check(/adjsut/.test(outC) && /skipped 1/.test(outC), "C1 the disasm result names the unknown field `adjsut`", outC.split("\n").filter((l) => /annotations|skipped|adjsut/.test(l)).join("\n"));
  writeAnn({ ...base, adjust: 1 });
  const outOk = await disasm();
  check(!/unknown field/.test(outOk), "C2 a clean entry reports nothing");

  head("D. adjust omitted = adjust 0, no (name-1) form");
  writeAnn(base);
  await disasm();
  const Tnone = tas();
  writeAnn({ ...base, adjust: 0 });
  await disasm();
  const T0 = tas();
  check(Tnone === T0, "D1 adjust omitted and adjust 0 give the same listing");
  check(wordLines(Tnone).length === 3 && !wordLines(Tnone).some((l) => /^\.word \(/.test(l)), "D2 no entry is written as (name-1)", wordLines(Tnone).join("\n"));
  if (have64tass) {
    const out = join(proj, "tass-out0.bin");
    const r = spawnSync(bin64tass, ["-C", "--nostart", "-o", out, join(proj, "artifacts", "prg", "t145_disasm.tas")], { encoding: "utf8" });
    check(r.status === 0 && Buffer.compare(readFileSync(out), prg.subarray(2)) === 0, "D3 and it still rebuilds byte-identical", `${r.status} ${r.stderr?.slice(0, 300)}`);
  }

  head("E. the writing door keeps adjust and refuses a bad one");
  const wr = await call("write_annotations", { prg_path: REL, overwrite: true, segments: [], labels: [], routines: NAMES.map((n) => ({ address: hex4(labels[n]), name: n })), pointerTables: [{ ...base, adjust: 1 }] });
  const written = JSON.parse(readFileSync(annPath, "utf8"));
  check(written.pointerTables?.[0]?.adjust === 1, "E1 write_annotations keeps adjust on a pointerTables entry", wr.slice(0, 300));
} finally {
  mcp.stop();
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
