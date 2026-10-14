#!/usr/bin/env node
// Spec 903 — split low/high tables are declared, and a found one must be decided.
//
// Hermetic: a temp project, one synthetic PRG assembled from a listing here (scripts/lib/903-prgs.mjs,
// asm6502-mini.mjs), one MCP session over stdio. No ROMs, no game bytes, no media, no runtime, no :4312.
// The rebuild halves need KickAssembler (and 64tass for the second dialect) and SKIP LOUDLY without them,
// like e2e:830 — every assertion on the listing text, the detector, the gate, the critic and the graph
// runs either way.
//
//   A  the detector: three shapes, `shape`, `countHint`, `adjustHint`, one fact per (lo, hi)
//   B  the open list rides analyze / disasm — and never refuses there
//   C  the gate: agent_advance_phase refuses past phase 5, unconditionally, listing what is open
//   D  the critic and the recommender: split-table-undecided (blocking), "declare split tables"
//   E  closing: a rejection closes, a declaration closes, partial closes leave the rest
//   F  the listing: both dialects, rebuild byte-identical, every emission form
//   G  the graph: the table node, its edges to the targets, a rejection readable
//   H  validation: each refusal by name — at the writing door AND at the loader
//   I  a wrong adjust is not accepted
//   J  merge_annotations merges by (lo, hi)
//   K  probable code is listed and does not block
//   L  a zero-page pair counts only when the code uses it as a pointer: coordinates and
//      width/height pairs are listed as probable and never block
//
//   npm run e2e:903

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMcp } from "./lib/mcp-stdio.mjs";
import { splitTablePrg, pairUsePrg } from "./lib/903-prgs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${!cond && detail ? `\n          ${String(detail).replace(/\n/g, "\n          ")}` : ""}`);
};
const skip = (msg) => console.log(`  SKIP  ${msg}`);
const head = (t) => console.log(`\n── ${t}`);

if (!existsSync(join(ROOT, "dist/cli.js")) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("Spec 903 — split low/high tables are declared, and a found one must be decided\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-903-"));
const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1" } });
const call = mcp.call;

const { prg, labels } = splitTablePrg();
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const X = (name) => hex4(labels[name]);
const HANDLERS = ["zh0", "zh1", "zh2", "sh0", "sh1", "rh0", "rh1", "rh2"];
const ENTRIES = ["080D", ...HANDLERS.map(X)];

mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
const REL = "artifacts/prg/t903.prg";
writeFileSync(join(proj, REL), prg);
// a second, trivial program: its analysis gets a fact from PROBABLE code written into it (section K)
const PROBE_REL = "artifacts/prg/probe.prg";
writeFileSync(join(proj, PROBE_REL), Buffer.from([0x00, 0xc0, 0xea, 0xea, 0x60]));

const tables = {
  tz: { lo: X("tz_lo"), hi: X("tz_hi"), count: 3 },
  ts: { lo: X("ts_lo"), hi: X("ts_hi"), count: 2 },
  tr: { lo: X("tr_lo"), hi: X("tr_hi"), count: 3, adjust: 1 },
  tf: { lo: X("tf_lo"), hi: X("tf_hi") },
  tb: { lo: X("tb_lo"), hi: X("tb_hi"), count: 3, base: "blob_seg" },
  tx: { lo: X("tx_lo"), hi: X("tx_hi"), count: 2 },
};
const REJECT_TF = { lo: tables.tf.lo, hi: tables.tf.hi, reject: "two byte tables the routine only copies — PETSCII text, not addresses" };
const names = HANDLERS.map((n) => ({ address: X(n), name: n }));
const blobEnd = hex4(labels.blob + 11);
const baseDoc = {
  routines: [...names, { address: X("rz"), name: "rz" }],
  segments: [
    { start: X("blob"), end: blobEnd, kind: "lookup_table", label: "blob_seg" },
    { start: tables.tz.lo, end: hex4(labels.tz_lo + 2), kind: "lookup_table", label: "tz_lo_tbl" },
  ],
};
const write = (extra, overwrite = true) => call("write_annotations", { prg_path: REL, overwrite, ...baseDoc, ...extra });
const annPath = join(proj, "artifacts", "prg", "t903_annotations.json");
const listing = () => readFileSync(join(proj, "artifacts", "prg", "t903_disasm.asm"), "utf8");
const tassListing = () => readFileSync(join(proj, "artifacts", "prg", "t903_disasm.tas"), "utf8");
const disasm = () => call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
const openCount = (text) => Number(/Split tables: (\d+) OPEN/.exec(text)?.[1] ?? 0);
const openLines = (text) => text.split("\n").filter((l) => /^ {2}\$[0-9A-F]{4} \/ \$[0-9A-F]{4} /.test(l));
const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const haveKick = existsSync(jar) || spawnSync("sh", ["-c", "command -v kickass"], { stdio: "ignore" }).status === 0;
const have64tass = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;

const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

try {
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-903", version: "1" } });
  mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "903" });
  await call("agent_onboard", {});
  // a contract that owes no slot, so the verdict can be READY and what flips it is the critic alone
  await call("contract_set", { goal: "synthetic split-table fixture — nothing is owed but the tables", slots: [], coverage_ratio: 0 });

  // ═══ A. the detector ═══════════════════════════════════════════════════════════
  head("A. the detector finds three shapes, once each");
  const analysis = await call("analyze_prg", { prg_path: REL, entry_points: ENTRIES });
  const analysisJson = JSON.parse(readFileSync(join(proj, "artifacts", "prg", "t903_analysis.json"), "utf8"));
  const facts = analysisJson.codeSemantics.splitPointerTables;
  const factFor = (t) => facts.find((f) => f.lowTableBase === labels[t] );
  check(facts.length === 6, "A1 six facts — one per (lo, hi) pair, none twice", `${facts.length}: ${facts.map((f) => hex4(f.lowTableBase)).join(" ")}`);
  check(new Set(facts.map((f) => `${f.lowTableBase}:${f.highTableBase}`)).size === facts.length, "A1 …deduplicated by (lowTableBase, highTableBase)");
  const tzF = factFor("tz_lo"), tsF = factFor("ts_lo"), trF = factFor("tr_lo");
  check(tzF?.shape === "zp_pointer" && tzF.highTableBase === labels.tz_hi && tzF.pointerBase === 0xfb && tzF.indexRegister === "x",
    "A2 LDA lo,X / STA zp / LDA hi,X / STA zp+1 -> zp_pointer (lo, hi, pointerBase, index as before)", JSON.stringify(tzF));
  check(tsF?.shape === "self_mod_operand" && tsF.highTableBase === labels.ts_hi && tsF.pointerBase === labels.patch + 1,
    "A3 the same stores into an instruction's operand -> self_mod_operand, pointerBase = the patched operand", JSON.stringify(tsF));
  check(trF?.shape === "rts_dispatch" && trF.highTableBase === labels.tr_hi && trF.adjustHint === 1 && trF.pointerBase === undefined,
    "A4 LDA hi,X / PHA / LDA lo,X / PHA / RTS -> rts_dispatch, lo and hi the right way round, adjustHint 1", JSON.stringify(trF));
  check(tzF?.countHint === 3 && tsF?.countHint === undefined && trF?.countHint === undefined,
    "A5 a CPX #3 near the loads bounds the index: countHint 3 — and only where one is found", `${tzF?.countHint}/${tsF?.countHint}/${trF?.countHint}`);
  check(facts.every((f) => f.provenance === "confirmed_code" && f.sampleTargets.length > 0), "A6 every fact comes from confirmed code and carries sample targets");
  check(tzF?.sampleTargets.slice(0, 3).join() === [labels.zh0, labels.zh1, labels.zh2].join() && trF?.sampleTargets.slice(0, 3).join() === [labels.rh0, labels.rh1, labels.rh2].join(),
    "A7 sample targets are the targets (the RTS table's include its +1)", `${tzF?.sampleTargets.slice(0, 3)} / ${trF?.sampleTargets.slice(0, 3)}`);
  await call("pointer_report", { analysis_json: "artifacts/prg/t903_analysis.json" });
  const md = readFileSync(join(proj, "artifacts", "prg", "t903_POINTER_TABLE_FACTS.md"), "utf8");
  check(/shape: `rts_dispatch`/.test(md) && /count hint: 3/.test(md) && /adjust hint: 1/.test(md) && /ZP \$00FB-\$00FC/.test(md),
    "A8 the pointer report names the shape and the hints, and the zero-page line reads as it did", md.split("\n").filter((l) => /###|shape|hint/.test(l)).slice(0, 8).join("\n"));

  // ═══ B. the open list ══════════════════════════════════════════════════════════
  head("B. analyze and disasm end with the open list — and never refuse");
  check(openCount(analysis) === 6 && openLines(analysis).length === 6, "B1 analyze_prg lists the six open tables", analysis.split("\n").filter((l) => /Split tables/.test(l)).join());
  check(/zero-page pointer/.test(analysis) && /patched operand/.test(analysis) && /RTS dispatch/.test(analysis) && /count hint 3/.test(analysis) && /adjust 1/.test(analysis),
    "B2 …each with its shape, count hint and adjust hint");
  check(/first targets \$/.test(analysis) && /declare:/.test(analysis) && /reject:/.test(analysis), "B3 …the first targets, and the two ways to close one");
  check(/"0 open" is not "no tables"/.test(analysis), "B4 …and the sentence that the detector cannot see every table");
  const bare = await disasm();
  check(openCount(bare) === 6 && !/REFUSED/i.test(bare), "B5 disasm_prg lists them too and does not refuse", bare.split("\n").filter((l) => /REFUSED|Split tables/.test(l)).join());
  check(/"0 open" is not "no tables"/.test(bare), "B6 …with the same limit sentence");

  // ═══ C. the gate ═══════════════════════════════════════════════════════════════
  head("C. agent_advance_phase refuses past phase 5 while a table is open");
  const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
  const service = () => new ProjectKnowledgeService(proj);
  const artifact = () => service().listArtifacts().find((a) => a.path.endsWith("t903.prg"));
  const phaseOf = () => artifact()?.phase ?? 1;
  check(!!artifact(), "C0 the program is a registered artifact", String(artifact()?.id));
  // the artifact is looked up each time: a sync may re-register the row, and the gate is about the artifact, not an id held in a variable
  const advance = (to, evidence) => call("agent_advance_phase", { artifact_id: artifact().id, to_phase: to, ...(evidence ? { evidence } : {}) });
  const to5 = await advance(5, "fixture: phases 1-4 are not what this gate is about");
  check(/Phase advanced/.test(to5) && phaseOf() === 5, "C1 moving TO phase 5 is allowed", to5);
  const to6 = await advance(6);
  check(/REFUSED/.test(to6) && phaseOf() === 5, "C2 phase 6 is refused and the artifact stays at 5", to6.split("\n").slice(0, 3).join(" | "));
  check(openLines(to6).length === 6 && Object.values(tables).every((t) => to6.includes(`$${t.lo} / $${t.hi}`)), "C3 …the refusal lists every open table", openLines(to6).join("\n"));
  check(/splitTables/.test(to6) && /reject/.test(to6) && /"0 open" is not "no tables"/.test(to6), "C4 …says how to close each and states the detector's limit");
  const profile = await call("get_project_profile", {});
  check(!/phaseGateStrict["']?\s*[:=]\s*true/i.test(profile), "C5 …with the project NOT on phaseGateStrict: the refusal binds unconditionally", profile.slice(0, 200));
  const to7 = await advance(7, "skipping, still past 5");
  check(/REFUSED/.test(to7) && phaseOf() === 5, "C6 phase 7 (with evidence) is refused the same way");

  // ═══ D. the critic and the recommender ═════════════════════════════════════════
  head("D. project_critique and agent_next_step");
  const crit = await call("project_critique", { min_severity: "blocking" });
  const FINDING = /^ {2}split table \$[0-9A-F]{4}\/\$[0-9A-F]{4} in .* is found and undecided$/gm; // the findings; the verdict repeats them as '- split-table-undecided: …'
  const critFindings = crit.match(FINDING) ?? [];
  check(critFindings.length === 6, "D1 one split-table-undecided finding per open table", `${critFindings.length} lines; ${crit.length} chars`);
  check(/blocking \(6\)/.test(crit) && /split-table-undecided/.test(crit), "D2 …all blocking, and the check ran");
  check(/proof: .*\$[0-9A-F]{4} \/ \$[0-9A-F]{4} .*confirmed code/.test(crit), "D3 …each carries the fact as its proof");
  check(/settle by: write the splitTables\[\] entry for \$[0-9A-F]{4}\/\$[0-9A-F]{4}/.test(crit) && /"lo": "[0-9A-F]{4}"/.test(crit), "D4 …and settleBy names the entry to write");
  const verdictOpen = await call("project_critique", { verdict_only: true });
  check(/NOT READY/.test(verdictOpen) && (verdictOpen.match(/split-table-undecided/g) ?? []).length === 6, "D5 the verdict is NOT READY and names every one", verdictOpen.slice(0, 300));
  const checksText = await call("critic_checks", {});
  check(checksText.includes("split-table-undecided") && /blocking/.test(checksText), "D6 critic_checks explains the new check", checksText.slice(0, 300));

  // names only: the annotations exist, no split table is decided
  await write({});
  await call("project_inventory_sync", {});
  const next = await call("agent_next_step", {});
  check(/Step: declare-split-tables/.test(next) && /write_annotations/.test(next), "D7 agent_next_step recommends 'declare split tables'", next.split("\n").slice(3, 8).join(" | "));
  check(/6 split low\/high table/.test(next) && !/Step: runtime-trace/.test(next), "D8 …a step and not a complaint, naming how many", next.split("\n").find((l) => /^Why:/.test(l)) ?? "");

  // ═══ E. closing ════════════════════════════════════════════════════════════════
  head("E. a rejection closes, a declaration closes, a partial close leaves the rest");
  const r1 = await write({ splitTables: [REJECT_TF] });
  check(!/REFUSED/.test(r1), "E1 write_annotations takes a rejection with its reason", r1.split("\n")[0]);
  const afterReject = await disasm();
  check(openCount(afterReject) === 5 && !openLines(afterReject).some((l) => l.includes(`$${tables.tf.lo} / `)), "E2 the rejected table leaves the open list; five remain", afterReject.split("\n").filter((l) => /Split tables/.test(l)).join());
  check(/decided: \$[0-9A-F]{4}\/\$[0-9A-F]{4} rejected/.test(afterReject), "E3 …and the list says it was decided, and how");
  // the schema a host sees: both writing doors declare the field (a host that cached an older tool list refuses it as an extra field)
  const listed = (await mcp.rpc("tools/list", {})).result?.tools ?? [];
  const schemaOf = (name) => listed.find((t) => t.name === name)?.inputSchema?.properties ?? {};
  const fragmentProps = schemaOf("merge_annotations").fragments?.items?.properties ?? {};
  check(!!schemaOf("write_annotations").splitTables && !!fragmentProps.splitTables,
    "E3b write_annotations and merge_annotations' fragments both declare splitTables in their input schema", JSON.stringify({ write: Object.keys(schemaOf("write_annotations")), fragment: Object.keys(fragmentProps) }));
  const critRej = await call("project_critique", { min_severity: "blocking" });
  check((critRej.match(FINDING) ?? []).length === 5, "E4 the critic sees five now", `${(critRej.match(FINDING) ?? []).length}`);
  if (phaseOf() < 5) await advance(5, "fixture: back at phase 5");
  const to6b = await advance(6);
  check(/REFUSED/.test(to6b) && openLines(to6b).length === 5 && !to6b.includes(`$${tables.tf.lo} / `), "E5 the gate still refuses, listing the five", to6b.slice(0, 600));
  await write({ splitTables: [REJECT_TF, { ...tables.tz }, { ...tables.ts }] });
  const afterTwo = await disasm();
  check(openCount(afterTwo) === 3, "E6 two declarations close two more; three remain", afterTwo.split("\n").filter((l) => /Split tables/.test(l)).join());

  // the full set
  const FULL = [REJECT_TF, tables.tz, tables.ts, tables.tr, tables.tb, tables.tx];
  const wrote = await write({ splitTables: FULL });
  check(/6 split tables/.test(wrote) && existsSync(annPath), "E7 the full set is written", wrote.split("\n")[0]);
  const closedOut = await disasm();
  check(/Split tables: 0 open \(6 decided\)/.test(closedOut) && !/OPEN/.test(closedOut), "E8 disasm: 0 open (6 decided) — and the limit sentence still printed", closedOut.split("\n").filter((l) => /Split tables/.test(l)).join());
  check(/"0 open" is not "no tables"/.test(closedOut), "E9 …'0 open' is never printed without it");
  if (phaseOf() < 5) await advance(5, "fixture: back at phase 5");
  const to6c = await advance(6);
  check(/Phase advanced/.test(to6c) && phaseOf() === 6, "E10 with every table decided, phase 6 is allowed", to6c.split("\n")[0]);
  const critDone = await call("project_critique", { min_severity: "blocking" });
  check(!/split-table-undecided: /.test(critDone) && !/is found and undecided/.test(critDone), "E11 the critic is clean of it");
  const verdictDone = await call("project_critique", { verdict_only: true });
  check(/^READY/.test(verdictDone), "E12 and the verdict flips to READY", verdictDone.slice(0, 200));
  const nextDone = await call("agent_next_step", {});
  check(!/Step: declare-split-tables/.test(nextDone), "E13 agent_next_step no longer asks for it");

  // ═══ F. the listing ════════════════════════════════════════════════════════════
  head("F. the listing, both dialects");
  const L = listing();
  const T = tassListing();
  const both = (re, msg, detail) => {
    check(re.test(L), `${msg} (KickAssembler)`, detail ?? L.split("\n").filter((l) => /\.byte [<>]/.test(l)).join("\n"));
    check(re.test(T), `${msg} (64tass)`, detail ?? T.split("\n").filter((l) => /\.byte [<>]/.test(l)).join("\n"));
  };
  both(/\.byte <zh0, <zh1, <zh2\n/, "F1 zero-page table: .byte <label for the low table");
  both(/\.byte >zh0, >zh1, >zh2\n/, "F1 …and >label for the high table");
  both(/\.byte <sh0, <sh1\n/, "F2 patched-operand table: <label");
  both(/\.byte >sh0, >sh1\n/, "F2 …>label");
  both(/\.byte <\(rh0-1\), <\(rh1-1\), <\(rh2-1\)\n/, "F3 RTS table with adjust 1: <(label-1) — adjust in the expression, not folded");
  both(/\.byte >\(rh0-1\), >\(rh1-1\), >\(rh2-1\)\n/, "F3 …>(label-1)");
  both(/\.byte <blob_seg, <\(blob_seg\+4\), <\(blob_seg\+8\)\n/, "F4 targets without names, declared with base: <(base+off)");
  both(/\.byte >blob_seg, >\(blob_seg\+4\), >\(blob_seg\+8\)\n/, "F4 …>(base+off)");
  both(/\.byte <\$C100, <\$C200\n/, "F5 targets outside the image: the bare address as an expression");
  both(/\.byte >\$C100, >\$C200\n/, "F5 …>$xxxx");
  both(/\.byte \$48, \$45, \$4C, \$4C\n/, "F6 the REJECTED pair keeps its raw bytes — a rejection renders nothing");
  check(/tz_lo_tbl:[^\n]*\n\s+\.byte <zh0/.test(L), "F7 the table sits under the name the segment gave it — the segment's label stays the table's label");
  check(/\/\/ split tables: \$[0-9A-F]{4}\/\$[0-9A-F]{4} -> /.test(L), "F8 the '// split tables:' comment above the routine is unchanged");
  check(/Semantic annotations applied: \d+ names, 8 segment\/table annotations/.test(L), "F9 the header counts the split tables among the structural annotations (2 segments + 6 split tables)", L.split("\n").find((l) => /Semantic annotations/.test(l)) ?? "");
  if (haveKick) {
    check(/rebuild verified byte-identical/.test(closedOut), "F10 the real disasm path rebuilds byte-identical with the tables declared", closedOut.split("\n").find((l) => /rebuild/.test(l)) ?? "(no rebuild line)");
  } else skip(`F10 byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — skipped, not passed`);
  if (have64tass) {
    const out = join(proj, "tass-out.bin");
    const r = spawnSync("64tass", ["-C", "--nostart", "-o", out, join(proj, "artifacts", "prg", "t903_disasm.tas")], { encoding: "utf8" });
    const built = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
    check(r.status === 0 && Buffer.compare(built, prg.subarray(2)) === 0, "F11 the 64tass listing assembles to the same bytes", `${r.status} ${r.stderr?.slice(0, 200)}`);
  } else skip("F11 64tass rebuild: 64tass not on PATH — skipped, not passed");

  // ═══ G. the graph ══════════════════════════════════════════════════════════════
  head("G. the graph");
  const edgesIn = await call("graph_edges", { ref: "zh1", direction: "in" });
  check(/split table \$[0-9A-F]{4}\/\$[0-9A-F]{4}/.test(edgesIn) && /REFERENCES_DATA|references/i.test(edgesIn), "G1 graph_edges on a handler shows the table that points at it", edgesIn.slice(0, 400));
  const edgesRts = await call("graph_edges", { ref: "rh2", direction: "in" });
  check(/split table \$[0-9A-F]{4}\/\$[0-9A-F]{4}/.test(edgesRts), "G2 …also for the RTS table (the target is target, not target-1)", edgesRts.slice(0, 300));
  const edgesOut = await call("graph_edges", { ref: `split table $${tables.tz.lo}/$${tables.tz.hi}`, direction: "out" });
  check((edgesOut.match(/zh[012]/g) ?? []).length >= 3, "G3 the table's own edges reach all three targets", edgesOut.slice(0, 500));
  const rejectedNode = await call("graph_node", { ref: `split table $${tables.tf.lo}/$${tables.tf.hi}` });
  check(/PETSCII text, not addresses/.test(rejectedNode) || /rejected/i.test(rejectedNode), "G4 a rejection is readable on its node, with the reason", rejectedNode.slice(0, 500));
  check(/PETSCII text, not addresses/.test(rejectedNode), "G5 …the reason itself, not just the word", rejectedNode.slice(0, 500));
  check(!/split table[^\n]*->[^\n]*\$4F48/.test(await call("graph_edges", { ref: `split table $${tables.tf.lo}/$${tables.tf.hi}`, direction: "out" })), "G6 a rejection points at nothing");

  // ═══ H. validation ═════════════════════════════════════════════════════════════
  head("H. each refusal by name — at the writing door and at the loader");
  const sharedBase = { segments: [{ start: X("blob"), end: blobEnd, kind: "lookup_table", label: "blob_seg" }], routines: [{ address: X("rz"), name: "rz" }] };
  const badCorpus = [
    { name: "overlap (the low and the high table)", entry: { lo: tables.tz.lo, hi: hex4(labels.tz_lo + 1), count: 3 }, re: /overlap/ },
    { name: "overlap (another declared split table)", doc: { splitTables: [{ ...tables.tz }, { lo: hex4(labels.tz_lo + 1), hi: tables.ts.hi, count: 2 }] }, re: /overlaps splitTables\[0\]/ },
    { name: "overlap (a pointerTables range)", doc: { pointerTables: [{ start: tables.tz.lo, end: hex4(labels.tz_lo + 5) }], splitTables: [{ ...tables.tz }] }, re: /overlaps pointerTables\[0\]/ },
    { name: "overlap (a jumpTables range)", doc: { jumpTables: [{ start: tables.tz.hi, end: hex4(labels.tz_hi + 2), kind: "word" }], splitTables: [{ ...tables.tz }] }, re: /overlaps jumpTables\[0\]/ },
    { name: "overlap (a code segment)", doc: { segments: [...sharedBase.segments, { start: X("rz"), end: hex4(labels.tz_hi + 2), kind: "code" }], splitTables: [{ ...tables.tz }] }, re: /overlaps segments\[1\] \(code\).*never code/ },
    { name: "out of the image", entry: { lo: "C000", hi: "C010", count: 4 }, re: /outside the image/ },
    { name: "out of the image (a count that runs past the end)", entry: { lo: tables.tx.hi, hi: tables.tz.lo, count: 4 }, re: /outside the image/ },
    { name: "count 0", entry: { lo: tables.tz.lo, hi: tables.tz.hi, count: 0 }, re: /count must be a whole number of at least 1/ },
    { name: "no count and no reject", entry: { lo: tables.tz.lo, hi: tables.tz.hi }, re: /count must be a whole number of at least 1/ },
    { name: "an empty reject", entry: { lo: tables.tz.lo, hi: tables.tz.hi, reject: "   " }, re: /reject is empty/ },
    { name: "a lo that is not an address", entry: { lo: "zzzz", hi: tables.tz.hi, count: 3 }, re: /lo="zzzz" is not a hex address/ },
    { name: "a base that names nothing", entry: { lo: tables.tb.lo, hi: tables.tb.hi, count: 3, base: "nowhere" }, re: /base "nowhere" names no label/ },
    { name: "the same pair twice", doc: { splitTables: [{ ...tables.tz }, { ...tables.tz }] }, re: /already decided by splitTables\[0\]/ },
  ];
  let n = 0;
  for (const c of badCorpus) {
    n += 1;
    const doc = c.doc ?? { splitTables: [c.entry] };
    // the writing door
    const door = await call("write_annotations", { prg_path: REL, output_path: `artifacts/prg/bad${n}_annotations.json`, ...sharedBase, ...doc });
    check(/REFUSED/.test(door) && c.re.test(door) && !existsSync(join(proj, "artifacts", "prg", `bad${n}_annotations.json`)),
      `H${n}a write_annotations refuses: ${c.name}, by entry — and writes nothing`, door.split("\n").slice(0, 5).join(" | "));
    // the loader (a hand-written file, which the door would never have let through)
    const hand = join(proj, "artifacts", "prg", `hand${n}_annotations.json`);
    writeFileSync(hand, JSON.stringify({ version: 1, binary: "t903.prg", segments: [], labels: [], routines: [], ...sharedBase, ...doc }, null, 2));
    const loader = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES, annotations_path: hand, import_graph: false });
    check(/REFUSED|refused/.test(loader) && c.re.test(loader) && !/rebuild verified/.test(loader),
      `H${n}b the loader refuses it the same way — and renders nothing`, loader.split("\n").filter((l) => /splitTables|REFUSED|refused/.test(l)).slice(0, 4).join(" | "));
  }
  // a declared table that overlaps the CODE the analysis found (no code segment in the file)
  {
    const hand = join(proj, "artifacts", "prg", "handcode_annotations.json");
    writeFileSync(hand, JSON.stringify({ version: 1, binary: "t903.prg", segments: [], labels: [], routines: [],
      splitTables: [{ lo: X("rz"), hi: tables.tz.hi, count: 3 }] }, null, 2));
    const out = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES, annotations_path: hand, import_graph: false });
    check(/refused/.test(out) && /overlaps a code segment/.test(out) && !/rebuild verified/.test(out), "H-code a table over code the ANALYSIS found is refused by the renderer, which has the analysis", out.split("\n").filter((l) => /splitTables|overlaps/.test(l)).join(" | "));
  }
  // the door and the loader agree: the same corpus, both ways, is the drift test for the twin rules
  // a good file is not refused by either
  {
    const out = await write({ splitTables: FULL });
    const again = await disasm();
    check(!/REFUSED/.test(out) && !/refused/.test(again) && /\[annotations\] applied \d+, skipped 0/.test(again), "H-ok the good set is taken by both, nothing skipped", again.split("\n").find((l) => /\[annotations\]/.test(l)) ?? "");
  }

  // ═══ I. a wrong adjust ═════════════════════════════════════════════════════════
  head("I. a wrong adjust is not accepted");
  {
    await write({ splitTables: FULL.map((t) => (t.lo === tables.tr.lo ? { ...t, adjust: 0 } : t)) });
    const out = await disasm();
    check(/refused/.test(out) && /adjust 0 contradicts the code/.test(out) && /adjust must be 1/.test(out), "I1 an RTS dispatch declared with adjust 0 is refused: the code pushes target-1", out.split("\n").filter((l) => /adjust/.test(l)).join(" | "));
    check(!/rebuild verified byte-identical/.test(out) && !/Split tables: 0 open/.test(out), "I2 …no listing is produced and nothing reads as decided or verified");
    // …and the arithmetic really is self-consistent: the bytes alone cannot tell, which is why the code must
    await write({ splitTables: FULL.map((t) => (t.lo === tables.tz.lo ? { ...t, adjust: 5 } : t)) });
    const odd = await disasm();
    check(/-5\)/.test(listing()) && (!haveKick || /rebuild verified byte-identical/.test(odd)),
      "I3 an adjust the code does not contradict reproduces the bytes by construction (the bytes cannot judge it; the evidence does)", listing().split("\n").filter((l) => /\.byte <\(/.test(l)).slice(0, 2).join(" | "));
    await write({ splitTables: FULL });
    await disasm();
  }

  // ═══ J. merge_annotations ══════════════════════════════════════════════════════
  head("J. merge_annotations merges by (lo, hi)");
  {
    const frag = (name, st) => ({ name, ...sharedBase, splitTables: st });
    const same = await call("merge_annotations", { output_path: "artifacts/prg/merged_annotations.json", prg_path: REL, dry_run: true,
      fragments: [frag("A", [{ ...tables.tz }, REJECT_TF]), frag("B", [{ ...tables.tz }]), frag("C", [{ ...tables.ts }])] });
    check(!/REFUSED/.test(same) && /3 split tables/.test(same), "J1 fragments that agree collapse by (lo, hi); distinct pairs accumulate", same.split("\n").slice(0, 3).join(" | "));
    const clash = await call("merge_annotations", { output_path: "artifacts/prg/merged_annotations.json", prg_path: REL,
      fragments: [frag("A", [{ ...tables.tz }]), frag("B", [{ ...tables.tz, count: 2 }])] });
    check(/REFUSED/.test(clash) && new RegExp(`split:${tables.tz.lo}-${tables.tz.hi}`).test(clash) && /count 3/.test(clash) && /count 2/.test(clash),
      "J2 two readings of one table that disagree are REFUSED, naming the key and both claims", clash.split("\n").slice(0, 6).join(" | "));
    const settled = await call("merge_annotations", { output_path: "artifacts/prg/merged_annotations.json", prg_path: REL, overwrite: true,
      fragments: [frag("A", [{ ...tables.tz }]), frag("B", [{ ...tables.tz, count: 2 }])],
      resolutions: [{ key: `split:${tables.tz.lo}-${tables.tz.hi}`, winner: "A", why: "the CPX #3 bound in the indexing routine decides it" }] });
    const merged = JSON.parse(readFileSync(join(proj, "artifacts", "prg", "merged_annotations.json"), "utf8"));
    check(!/REFUSED/.test(settled) && merged.splitTables?.length === 1 && merged.splitTables[0].count === 3 && /Recorded 1 resolution/.test(settled),
      "J3 a resolution picks the winner and is recorded as a finding", settled.split("\n").slice(0, 5).join(" | "));
    const conflictReject = await call("merge_annotations", { output_path: "artifacts/prg/merged2_annotations.json", prg_path: REL,
      fragments: [frag("A", [{ ...tables.tz }]), frag("B", [{ lo: tables.tz.lo, hi: tables.tz.hi, reject: "it is text" }])] });
    check(/REFUSED/.test(conflictReject) && /REJECTED: it is text/.test(conflictReject), "J4 a declaration against a rejection is a contradiction too", conflictReject.split("\n").slice(0, 6).join(" | "));
  }

  // ═══ K. probable code is listed, and does not block ════════════════════════════
  head("K. a fact from probable code is listed and never an obligation");
  {
    await call("analyze_prg", { prg_path: PROBE_REL, entry_points: ["C000"] });
    const probeAnalysisPath = join(proj, "artifacts", "prg", "probe_analysis.json");
    const pa = JSON.parse(readFileSync(probeAnalysisPath, "utf8"));
    pa.codeSemantics = pa.codeSemantics ?? {};
    pa.codeSemantics.splitPointerTables = [{
      start: 0xc000, end: 0xc00a, lowTableBase: 0xc100, highTableBase: 0xc110, pointerBase: 0xfb, indexRegister: "x", shape: "zp_pointer",
      provenance: "probable_code", confidence: 0.6, sampleTargets: [0xc200, 0xc210], reasons: ["a probable island"],
    }];
    writeFileSync(probeAnalysisPath, JSON.stringify(pa));
    const probeOut = await call("disasm_prg", { prg_path: PROBE_REL });
    check(/from probable code, listed and NOT an obligation: \$C100\/\$C110/.test(probeOut) && /Split tables: 0 open/.test(probeOut), "K1 disasm lists it as probable and counts 0 open", probeOut.split("\n").filter((l) => /Split tables|probable/.test(l)).join(" | "));
    const probeId = service().listArtifacts().find((a) => a.path.endsWith("probe.prg"))?.id;
    const adv = await call("agent_advance_phase", { artifact_id: probeId, to_phase: 6, evidence: "fixture: nothing to decide" });
    check(/Phase advanced/.test(adv), "K2 the gate does not fire on it", adv.split("\n")[0]);
    const c = await call("project_critique", { min_severity: "blocking" });
    check(!/found and undecided/.test(c), "K3 the critic does not fire on it");
    const report = (await dist("project-knowledge/split-obligations.js")).splitObligationsFromFiles(probeAnalysisPath);
    check(report.open.length === 0 && report.probable.length === 1, "K4 as a record: open 0, probable 1", JSON.stringify({ open: report.open.length, probable: report.probable.length }));
  }

  // ═══ L. a zero-page pair is a table only when it is used as a pointer ═══════════
  head("L. a pair stored to zero page and only read as bytes is probable, never an obligation");
  {
    const pairHex = (a, b) => `$${hex4(a)}/$${hex4(b)}`;
    // L-a: a program whose pairs are all coordinates / sizes
    const neg = pairUsePrg({ withPointers: false });
    const NEG_REL = "artifacts/prg/coords.prg";
    writeFileSync(join(proj, NEG_REL), neg.prg);
    const negOut = await call("analyze_prg", { prg_path: NEG_REL, entry_points: ["080D"] });
    const negFacts = JSON.parse(readFileSync(join(proj, "artifacts", "prg", "coords_analysis.json"), "utf8")).codeSemantics.splitPointerTables;
    const byLo = (facts, labelsOf, name) => facts.find((f) => f.lowTableBase === labelsOf[name]);
    check(negFacts.length === 3 && negFacts.every((f) => f.shape === "zp_pointer" && f.provenance === "confirmed_code" && f.pointerUsed === false),
      "L1 the detector still sees the three pairs (confirmed code) and marks each pointerUsed:false", JSON.stringify(negFacts.map((f) => [hex4(f.lowTableBase), f.pointerUsed])));
    check(openCount(negOut) === 0 && /Split tables: 0 open/.test(negOut), "L2 analyze lists 0 open", negOut.split("\n").filter((l) => /Split tables|probable/.test(l)).join(" | "));
    check(/probable, listed and NOT an obligation — the zero-page pair is never used as a pointer/.test(negOut)
      && negFacts.every((f) => negOut.includes(pairHex(f.lowTableBase, f.highTableBase))),
      "L3 …and lists all three as probable, by table pair, saying why", negOut.split("\n").filter((l) => /Split tables|probable/.test(l)).join(" | "));
    const report = (await dist("project-knowledge/split-obligations.js")).splitObligationsFromFiles(join(proj, "artifacts", "prg", "coords_analysis.json"));
    check(report.open.length === 0 && report.probable.length === 3 && report.probable.every((p) => p.why === "no-pointer-use"),
      "L4 as a record: open 0, probable 3 (no-pointer-use)", JSON.stringify({ open: report.open.length, probable: report.probable.map((p) => p.why) }));
    const negId = service().listArtifacts().find((a) => a.path.endsWith("coords.prg"))?.id;
    const adv = await call("agent_advance_phase", { artifact_id: negId, to_phase: 6, evidence: "fixture: nothing to decide" });
    check(/Phase advanced/.test(adv), "L5 the gate does not fire on them", adv.split("\n")[0]);
    const crit = await call("project_critique", { min_severity: "blocking" });
    check(!/found and undecided/.test(crit) || !/coords/.test(crit), "L6 the critic does not fire on them", crit.split("\n").slice(0, 4).join(" | "));
    const md2 = await call("pointer_report", { analysis_json: "artifacts/prg/coords_analysis.json" });
    const mdText = readFileSync(join(proj, "artifacts", "prg", "coords_POINTER_TABLE_FACTS.md"), "utf8");
    check(/pointer use: none seen/.test(mdText) && /byte_pair_not_a_pointer/.test(mdText), "L7 the pointer report says so too", mdText.split("\n").filter((l) => /pointer use|hypothesis/.test(l)).slice(0, 4).join(" | "));

    // L-b: the same shapes next to two pairs that ARE pointers (used in a callee; used on one branch arm)
    const mix = pairUsePrg({ withPointers: true });
    const MIX_REL = "artifacts/prg/pairs.prg";
    writeFileSync(join(proj, MIX_REL), mix.prg);
    const mixOut = await call("analyze_prg", { prg_path: MIX_REL, entry_points: ["080D"] });
    const mixFacts = JSON.parse(readFileSync(join(proj, "artifacts", "prg", "pairs_analysis.json"), "utf8")).codeSemantics.splitPointerTables;
    const used = (name) => byLo(mixFacts, mix.labels, name)?.pointerUsed;
    check(used("tp_lo") === true && used("tb_lo") === true, "L8 a pair used as ($zp),Y in the CALLEE, and one used on a BRANCH arm, are pointers", JSON.stringify(mixFacts.map((f) => [hex4(f.lowTableBase), f.pointerUsed])));
    check(used("tc_lo") === false && used("tw_lo") === false, "L9 the coordinate pair and the width/height pair next to them are not", JSON.stringify(mixFacts.map((f) => [hex4(f.lowTableBase), f.pointerUsed])));
    check(used("tq_lo") === false, "L10 a pair both of whose cells are overwritten before the ($zp),Y is not the table's pointer any more", String(used("tq_lo")));
    check(openCount(mixOut) === 2 && openLines(mixOut).length === 2
      && openLines(mixOut).some((l) => l.startsWith(`  ${pairHex(mix.labels.tp_lo, mix.labels.tp_hi).replace("/", " / ")}`))
      && openLines(mixOut).some((l) => l.startsWith(`  ${pairHex(mix.labels.tb_lo, mix.labels.tb_hi).replace("/", " / ")}`)),
      "L11 exactly the two pointer pairs are open", mixOut.split("\n").filter((l) => /Split tables|^  \$/.test(l)).join(" | "));
    check(/never used as a pointer/.test(mixOut), "L12 …and the other three are listed as probable beside them");
  }
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  the gate itself could not run: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  mcp.stop();
}

console.log(`\nproject: ${proj}`);
console.log(`${failCount ? "RED" : "GREEN"}  Spec 903: ${pass} pass, ${failCount} fail.`);
if (!failCount && !process.env.C64RE_KEEP) { try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp */ } }
process.exit(failCount ? 1 : 0);
