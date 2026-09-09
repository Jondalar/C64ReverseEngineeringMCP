#!/usr/bin/env node
// Spec 833 D1/D2/D3 — a tool may not claim what it did not do.
//
// D1  The legacy render path (no analysis JSON) built the annotations index only
//     `if (annotationsFile && analysisContext)`, so the file was FOUND, nothing
//     was indexed, every name was absent — and the header printed "Semantic
//     annotations applied" on the strength of the file existing. Measured on the
//     build that carried the defect: without an analysis JSON, 0 of 9 names in
//     the listing; with it, 8 of 9.
// D2  A segment annotation's `label` filled `segmentsByStart` and
//     `segmentAnnotations` and nothing else, so it never reached
//     `labelsByAddress` and `makeLabel` could not answer with it. The 9th name.
// D3  `disasm_prg` reported "Annotations unchanged since the last import (N
//     routines, … in the graph)" — true, and about the GRAPH — which a caller
//     read as "the annotations are in", concluded the import was broken when the
//     listing showed `W26D2`, and got a wrong diagnosis for their trouble.
//
// Hermetic: builds its own PRG, runs the bundled analyzer and renderer on it,
// and reads the listing; the D3 half drives the real MCP server over stdio in a
// throwaway project. No ROMs, no runtime, no corpus. The byte-identity half runs
// KickAssembler when it is on this machine and SKIPS LOUDLY when it is not — a
// gate that silently drops its strongest check is worse than one that says so.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:833-render

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const skip = (m) => console.log(`  SKIP  ${m}`);

console.log("Spec 833 — the listing says what it did, and the graph line says it is the graph\n");

// ---------------------------------------------------------------- the payload
//
//   0801  20 18 08   jsr entry_a        three names the payload REFERENCES, so
//   0804  20 1B 08   jsr entry_b        the fixture also carries the cases that
//   0807  20 1E 08   jsr helper         already worked on the analysis path
//   080A  8D 02 08   sta $0802          a self-mod patch into the first jsr's
//                                       operand — NOT declared, must not split
//   080D  20 24 08   jsr $0824          reaches the jump-table row
//   0810  AD 30 08   lda $0830          reaches into the data segment
//   0813  A2 00      ldx #$00
//   0815  4C 15 08   jmp *
//   0818  A9 00      lda #$00     entry_a
//   081A  2C         BIT abs, swallowing entry_b's opcode
//   081B  A9 04      lda #$04     entry_b        <- INSIDE that operand
//   081D  60         rts
//   081E  A9 07      lda #$07     helper
//   0820  EA         nop          lonely_routine <- named, referenced by NOTHING
//   0821  A2 09      ldx #$09     lonely_label   <- named, referenced by NOTHING
//   0823  60         rts
//   0824  4C 60 C1   jmp $C160    a jump-table row into another payload
//   0827..0836       the data segment — the SEGMENT ANNOTATION starts here and
//                    carries the label `tbl` (D2), and holds data_head ($0830)
//                    and table_mid ($0832)
const LOAD = 0x0801;
const CODE = [
  0x20, 0x18, 0x08, 0x20, 0x1b, 0x08, 0x20, 0x1e, 0x08,
  0x8d, 0x02, 0x08, 0x20, 0x24, 0x08, 0xad, 0x30, 0x08,
  0xa2, 0x00, 0x4c, 0x15, 0x08,
  0xa9, 0x00, 0x2c, 0xa9, 0x04, 0x60,
  0xa9, 0x07, 0xea, 0xa2, 0x09, 0x60,
  0x4c, 0x60, 0xc1,
];
const DATA = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10];

const ANNOTATIONS = {
  segments: [{ start: "0827", end: "0836", kind: "data", label: "tbl", comment: "the table the loader indexes" }],
  routines: [
    { address: "0818", name: "entry_a", comment: "first fall-through entry" },
    { address: "081b", name: "entry_b", comment: "second entry, inside the BIT operand" },
    { address: "081e", name: "helper", comment: "called normally" },
    { address: "0820", name: "lonely_routine", comment: "named by a human, referenced by nothing" },
  ],
  labels: [
    { address: "0821", label: "lonely_label" },
    { address: "0830", label: "data_head" },
    { address: "0832", label: "table_mid" },
    { address: "c160", label: "far_routine" },
  ],
  jumpTables: [{ start: "0824", end: "0826", kind: "jmp", comment: "dispatch into another payload" }],
  pointerTables: [],
};

// Names inside the rendered image. `far_routine` ($C160) is deliberately NOT in
// this list: it is outside the mapping, and the range check that keeps it out of
// the legacy listing is the same one `applyDeclaredLabelDefinitions` makes — an
// address that lives elsewhere must not be made to look as if it were defined
// here. On the analysis path it becomes an equate because the ANALYSER records
// the `jmp` target as a reference; the legacy path has no analyser and does not
// reference it, so it names nothing and claims nothing.
const IN_IMAGE_NAMES = ["entry_a", "entry_b", "helper", "lonely_routine", "lonely_label", "data_head", "table_mid", "tbl"];

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "c64re-833-"));
const prgPath = join(dir, "named.prg");
writeFileSync(prgPath, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE, ...DATA]));
writeFileSync(join(dir, "named_annotations.json"), JSON.stringify(ANNOTATIONS, null, 2));

// The analysis JSON goes in its OWN directory. `maybeLoadAnalysis` auto-finds
// `<stem>_analysis.json` next to the PRG, so leaving it there would silently
// make the "without analysis_json" run an analysis-path run — the mode this gate
// exists for would never be exercised.
const analysisDir = mkdtempSync(join(tmpdir(), "c64re-833-analysis-"));
const analysisPath = join(analysisDir, "named_analysis.json");
execFileSync(process.execPath, [cli, "analyze-prg", prgPath, analysisPath, "0801", "--no-register"], { stdio: "pipe" });

function render(name, extraArgs) {
  const asmPath = join(dir, `${name}.asm`);
  const stdout = execFileSync(
    process.execPath,
    [cli, "disasm-prg", prgPath, asmPath, "", ...extraArgs, "--no-register"],
    { stdio: "pipe" },
  ).toString();
  const asm = readFileSync(asmPath, "utf8");
  const lines = asm.split("\n");
  const codeOf = (l) => l.split("//")[0];
  return {
    asmPath,
    asm,
    lines,
    stdout,
    header: lines.find((l) => /semantic annotations/i.test(l)) ?? "",
    definedAt: (n) => lines.some((l) => new RegExp(`^${n}:`).test(codeOf(l)) || new RegExp(`^\\s*\\.label\\s+${n}\\s*=`).test(codeOf(l))),
    hasLine: (re) => lines.some((l) => re.test(codeOf(l))),
  };
}

const legacy = render("legacy", []);
const analysis = render("analysis", [analysisPath]);

// ------------------------------------------------------- D1(b): the names land
check(legacy.hasLine(/^\s*\/\/\s+Legacy linear rendering/) || /Legacy linear rendering/.test(legacy.asm),
  "the run without an analysis JSON really took the legacy path (the fixture does not smuggle one in)");

const legacyNames = IN_IMAGE_NAMES.filter((n) => legacy.definedAt(n));
check(legacyNames.length === IN_IMAGE_NAMES.length,
  `D1b: without an analysis JSON, every annotation name inside the image reaches the listing — ${legacyNames.length} of ${IN_IMAGE_NAMES.length}` +
  `${legacyNames.length === IN_IMAGE_NAMES.length ? "" : `, MISSING ${IN_IMAGE_NAMES.filter((n) => !legacyNames.includes(n)).join(", ")}`} (was 0 of 8)`);

const analysisNames = IN_IMAGE_NAMES.filter((n) => analysis.definedAt(n));
check(analysisNames.length === IN_IMAGE_NAMES.length,
  `…and the analysis path still names all ${IN_IMAGE_NAMES.length} of them`);

check(legacy.hasLine(/^lonely_routine:/) && legacy.hasLine(/^lonely_label:/),
  "a name nothing references is defined at its own address on the legacy path too — the human naming it IS the declaration");
check(legacy.hasLine(/^\s*\.label\s+entry_b\s*=\s*\$081B/),
  "a declared address INSIDE an instruction is defined by an equate — the linear decode cannot be split the way 830 splits the analysed one");
check(legacy.hasLine(/jsr\s+entry_b\b/),
  "…and the reference to it uses the human's name, not `W081A+1` — a declared address wins over the owner+offset form");
check(legacy.hasLine(/sta\s+W0801\+1/),
  "830 D2 on the legacy path: an UNDECLARED mid-instruction target still renders `<owner>+<offset>` — self-mod is untouched by the wider label set");
check(!legacy.definedAt("far_routine"),
  "an annotated address OUTSIDE the image is not defined by the legacy listing — it lives elsewhere and must not look as if it were defined here");
check(analysis.hasLine(/\.label far_routine = \$C160/),
  "…while the analysis path, which does reference it, still equates it (830 D3 unbroken)");

// ------------------------------------------------------- D2: the segment label
check(legacy.hasLine(/^tbl:/) || legacy.hasLine(/^\s*\.label\s+tbl\s*=/),
  "D2: a segment annotation's label is DEFINED as a label at the segment start (legacy path)");
check(analysis.hasLine(/^tbl:/) || analysis.hasLine(/^\s*\.label\s+tbl\s*=/),
  "D2: …and on the analysis path, where it never reached `labelsByAddress` either");
const tblIndex = analysis.lines.findIndex((l) => /^tbl:/.test(l.split("//")[0]));
check(tblIndex >= 0 && /^\s*\.byte \$01,/.test(analysis.lines[tblIndex + 1]?.split("//")[0] ?? ""),
  "…at $0827, where the human put the segment — the byte run starts on the next line");
check(!/^tbl:[\s\S]*^tbl:/m.test(analysis.asm),
  "the segment label is defined once, not once per segment overlay");

// ---------------------------------------------- D1(a): the header does not lie
for (const [name, r, expectApplied] of [["legacy", legacy, true], ["analysis", analysis, true]]) {
  const claimsApplied = /Semantic annotations applied/.test(r.header);
  const claimsNotApplied = /Semantic annotations found but NOT applied/.test(r.header);
  check(claimsApplied === expectApplied && claimsNotApplied === !expectApplied,
    `D1a (${name}): the header states the outcome — "${r.header.replace(/^\/\/\s+/, "")}"`);
  const namesInHeader = Number((/applied: (\d+) names/.exec(r.header) ?? [])[1] ?? -1);
  check(namesInHeader === 9,
    `D1a (${name}): the count in the header is the count in the index (9 names, ${namesInHeader} claimed)`);
}
check(/segment\/table annotations need an analysis JSON and were NOT applied/.test(legacy.header),
  "D1a: the legacy header says which half did NOT apply and why — the reason is in the line a human is already reading");
check(!/need an analysis JSON/.test(analysis.header),
  "…and the analysis header does not carry a caveat that does not apply to it");
check(/^\[annotations\] applied 9, skipped 0/m.test(legacy.stdout),
  "the tool output reports the legacy path's applied count too — it used to print nothing at all there");

// The defect in one assertion: a header that says "applied" while the listing
// carries none of the names is the thing 833 exists to make impossible.
const legacyClaimsApplied = /Semantic annotations applied/.test(legacy.header);
check(!(legacyClaimsApplied && legacyNames.length === 0),
  "a header claiming the annotations are applied cannot stand over a listing that has none of the names");

// ------------------------------------------------- a header for the empty case
{
  const emptyDir = mkdtempSync(join(tmpdir(), "c64re-833-empty-"));
  const emptyPrg = join(emptyDir, "empty.prg");
  writeFileSync(emptyPrg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE]));
  writeFileSync(join(emptyDir, "empty_annotations.json"), JSON.stringify({ segments: [], labels: [], routines: [] }));
  const emptyAsm = join(emptyDir, "empty.asm");
  execFileSync(process.execPath, [cli, "disasm-prg", emptyPrg, emptyAsm, "", "--no-register"], { stdio: "pipe" });
  const header = readFileSync(emptyAsm, "utf8").split("\n").find((l) => /semantic annotations/i.test(l)) ?? "";
  check(/found but NOT applied/.test(header),
    `D1a: an annotations file with nothing in it is reported as found and not applied — "${header.replace(/^\/\/\s+/, "")}"`);

  const bareDir = mkdtempSync(join(tmpdir(), "c64re-833-bare-"));
  const barePrg = join(bareDir, "bare.prg");
  writeFileSync(barePrg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE]));
  const bareAsm = join(bareDir, "bare.asm");
  execFileSync(process.execPath, [cli, "disasm-prg", barePrg, bareAsm, "", "--no-register"], { stdio: "pipe" });
  const bareHeader = readFileSync(bareAsm, "utf8").split("\n").find((l) => /semantic annotations/i.test(l)) ?? "";
  check(/No semantic annotations found/.test(bareHeader),
    "…and no file at all still reads as no file at all");
}

// ------------------------------- every symbol the listing uses is defined
// The wider label set must not mint a reference to a name nothing defines —
// that is the failure mode 830 built its backstop for, and the legacy path has
// no backstop.
function symbolBalance(asmText) {
  const defined = new Set();
  const used = new Set();
  let inBlock = false;
  for (const line of asmText.split("\n")) {
    let code = line;
    if (inBlock) { const c = code.indexOf("*/"); if (c < 0) continue; code = code.slice(c + 2); inBlock = false; }
    const lc = code.indexOf("//");
    const bc = code.indexOf("/*");
    if (lc >= 0 && (bc < 0 || lc < bc)) code = code.slice(0, lc);
    else if (bc >= 0) { const c = code.indexOf("*/", bc + 2); if (c < 0) { inBlock = true; code = code.slice(0, bc); } else code = code.slice(0, bc) + code.slice(c + 2); }
    code = code.replace(/"(?:[^"\\]|\\.)*"/g, "");
    if (!code.trim()) continue;
    const lab = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(code);
    if (lab) { defined.add(lab[1]); code = code.slice(lab[0].length); }
    const eq = /^\s*\.label\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(code);
    if (eq) { defined.add(eq[1]); continue; }
    const head = /^\s*(\.?[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (head && head[1].startsWith(".cpu")) continue;
    const operand = code.replace(/^\s*(\.?[A-Za-z_][A-Za-z0-9_]*)/, "").replace(/\$[0-9A-Fa-f]+/g, "");
    for (const m of operand.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!["x", "y", "a"].includes(m[0])) used.add(m[0]);
    }
  }
  return { defined, used, missing: [...used].filter((s) => !defined.has(s)).sort() };
}
for (const [name, r] of [["legacy", legacy], ["analysis", analysis]]) {
  const { defined, used, missing } = symbolBalance(r.asm);
  check(missing.length === 0,
    `every symbol the ${name} listing uses is defined (${used.size} used, ${defined.size} defined${missing.length ? `, MISSING ${missing.join(", ")}` : ""})`);
  const labelLines = r.lines.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(l.split("//")[0])).length;
  const equateLines = (r.asm.match(/^\s*\.label\s+/gm) ?? []).length;
  check(defined.size === labelLines + equateLines,
    `no symbol is defined twice in the ${name} listing — a name with a real label line must not also get an equate`);
}

// ------------------------------------------------------------- byte identity
const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
if (!existsSync(jar)) {
  skip(`byte-identical rebuild in BOTH modes: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
} else {
  const original = readFileSync(prgPath);
  for (const [name, r] of [["legacy", legacy], ["analysis", analysis]]) {
    const outPrg = `${r.asmPath}.rebuilt`;
    let assembled = true;
    let assemblerOutput = "";
    try {
      assemblerOutput = execFileSync("java", ["-jar", jar, r.asmPath, "-o", outPrg], { stdio: "pipe" }).toString();
    } catch (e) {
      assembled = false;
      assemblerOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check(assembled, `KickAssembler accepts the ${name} listing${assembled ? "" : `:\n${assemblerOutput.split("\n").filter((l) => /Error/.test(l)).slice(0, 4).join("\n")}`}`);
    if (assembled) {
      const after = readFileSync(outPrg);
      check(original.equals(after),
        `the ${name} listing rebuilds byte-identical — a label is symbolic and emits no bytes (${original.length} bytes${original.length === after.length ? "" : `, got ${after.length}`})`);
    }
  }
}

// ---------------------------------------------- D3: two outcomes, two sentences
const mcpCli = join(ROOT, "dist/cli.js");
if (!existsSync(mcpCli)) {
  fail("dist/cli.js missing — run `npm run build` (the D3 half drives the real MCP server)");
} else {
  const projectDir = mkdtempSync(join(tmpdir(), "c64re-833-project-"));
  const proc = spawn(process.execPath, [mcpCli], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.resume();
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = 180000) => new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return (r.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  };

  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-833", version: "1.0.0" } });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await call("project_init", { project_dir: projectDir, name: "E2E 833" });

    const projPrg = join(projectDir, "named.prg");
    writeFileSync(projPrg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE, ...DATA]));
    const outAsm = join(projectDir, "named_disasm.asm");
    // the wrapper looks for the annotations next to the ASM
    writeFileSync(join(projectDir, "named_disasm_annotations.json"), JSON.stringify(ANNOTATIONS, null, 2));

    const first = await call("disasm_prg", { project_dir: projectDir, prg_path: projPrg, output_asm: outAsm });
    const second = await call("disasm_prg", { project_dir: projectDir, prg_path: projPrg, output_asm: outAsm });

    check(/\nGraph: unchanged since the last import/.test(second),
      "D3: the second run reports the graph as unchanged — the case that produced the wrong diagnosis");
    check(!/Annotations unchanged since the last import/.test(second),
      "…and no longer says it in words a caller reads as a rendering result");
    check(/graph contents, not the listing/.test(second),
      "…the graph line names itself as the graph, so it cannot borrow the listing's credibility");
    for (const [name, out] of [["first", first], ["second", second]]) {
      check(/\nListing: Semantic annotations applied: \d+ names/.test(out),
        `D3 (${name} run): a separate Listing line states what the LISTING did with the annotations`);
    }
    check(/\nListing: /.test(second) && second.indexOf("\nListing: ") < second.indexOf("\nGraph: "),
      "…and it stands before the graph line, so the rendering result is the one a caller reads first");
    check(/imported \d+ routines, \d+ labels, \d+ segments into the knowledge graph/.test(first),
      "the first run still reports the import itself, in the graph's own words");
  } catch (e) {
    fail(`D3: MCP round trip — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    proc.kill();
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 833 render: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
