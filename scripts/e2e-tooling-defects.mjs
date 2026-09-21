#!/usr/bin/env node
// Thirteen defects an autonomous RE run hit in the tooling, one check apiece.
//
// Every one of these is a real observation from a full reverse-engineering session
// against a real disk, written down at the moment it cost something. The checks are
// written to FAIL against the code as it was, so each one pins a specific fix:
//
//   1  a payload door could not see a payload `extract_disk` created
//   2  `relocations` read hex differently from `entry_points`, in the same call
//   3  the chain-coverage guard warned 232 times about compressed payloads
//   4  `declare_lut_descriptor` silently demanded an absolute medium path
//   5  `doc_register` refused one field at a time, and rejected quoted list items
//   6  the L2 auto-chain disassembled and never verified
//   7  the sandbox's written-run list truncated with no way to ask for the rest
//   8  `project_slots` reported a coverage number no work could move
//   9  `slot_record` turned the whole answer into the finding's title
//   10 the critic's verdict dropped the text that says how to settle it
//   11 inventory sync capped its skipped count at ten and could not be told
//   12 the audit recommended a tool that is not on the surface
//   13 the SFX probe claimed 0.93 for "some code ran and wrote memory"
//
// BUG-059 adds two of its own here (the rest sit in the gates that own their door):
//   2  the entry-point slot took an analysis JSON and advised a flag the caller cannot pass
//   4  project_inventory_sync returned 146 728 characters nobody could read
//
// Hermetic: temp projects, synthetic PRGs, no ROMs, no media, no runtime daemon, no
// network. The rebuild half of check 6 needs KickAssembler and says so loudly when the
// jar is absent, the way e2e:830 does.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:tooling-defects

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };
const head = (n, title) => console.log(`\n── ${n}. ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("Thirteen tooling defects from one autonomous run\n");

// ───────────────────────────────────────────────────────────── pure-module checks

// 1 — the payload-kind predicate
{
  head(1, "a payload door sees every payload-bearing kind");
  const { PAYLOAD_ENTITY_KINDS, isPayloadEntity } = await import("../dist/project-knowledge/payload-kinds.js");
  check(isPayloadEntity({ kind: "disk-file" }),
    "a disk-file (what extract_disk registers) is a payload", [...PAYLOAD_ENTITY_KINDS].join(","));
  check(isPayloadEntity({ kind: "cart-chunk" }) && isPayloadEntity({ kind: "chip" }) && isPayloadEntity({ kind: "payload" }),
    "so are cart-chunk, chip and payload");
  check(!isPayloadEntity({ kind: "routine" }), "a routine is not");
}

// 2 — one address rule
{
  head(2, "relocations and entry_points read hex the same way");
  const { parseAddressStrict, normalizeRelocationInput, ADDRESS_RULE } =
    await import("../dist/server-tools/analysis-workflow.js");
  check(parseAddressStrict("E800", "x") === 0xe800, "a bare \"E800\" is $E800, not NaN");
  check(parseAddressStrict("2000", "x") === 0x2000, "a bare \"2000\" is $2000, not decimal 2000");
  check(parseAddressStrict("$2000", "x") === 0x2000 && parseAddressStrict("0x2000", "x") === 0x2000,
    "$ and 0x are optional decoration");
  let named = "";
  try { parseAddressStrict("ZZZZ", "relocations[0].fileStart"); } catch (e) { named = e.message; }
  check(named.includes("relocations[0].fileStart") && named.includes(ADDRESS_RULE.slice(0, 20)),
    "a bad value is refused by field name, and the message states the rule", named);

  const prg = { loadAddress: 0x2d1c, lastAddress: 0x36f3, name: "pack.prg" };
  const ok = normalizeRelocationInput([{ fileStart: "2E00", fileEnd: "2EFF", runtimeAddr: "C000" }], prg);
  check(ok[0].fileStart === 0x2e00 && ok[0].runtimeAddr === 0xc000, "a good relocation parses as hex throughout");
  let outside = "";
  try { normalizeRelocationInput([{ fileStart: "0002", fileEnd: "0024", runtimeAddr: "C000" }], prg); }
  catch (e) { outside = e.message; }
  check(outside.includes("outside pack.prg") && outside.includes("$2D1C-$36F3"),
    "a zero-page relocation is a validation refusal naming the PRG's span, not a crash", outside);
  let overlap = "";
  try {
    normalizeRelocationInput([
      { fileStart: "2E00", fileEnd: "2EFF", runtimeAddr: "C000" },
      { fileStart: "2E80", fileEnd: "2F00", runtimeAddr: "D000" },
    ], prg);
  } catch (e) { overlap = e.message; }
  check(/overlaps/.test(overlap), "two overlapping regions are refused before rendering", overlap);
}

// 3 — the chain-coverage guard
{
  head(3, "the chain guard only fires where blob length and span length are the same quantity");
  const { chainCoverageWarning, payloadIsPacked } = await import("../dist/server-tools/loader-manifest.js");
  const spans = Array.from({ length: 26 }, () => ({ kind: "sector", length: 249 })); // 6474
  check(chainCoverageWarning("raw", 8002, spans, { format: "prg" }) !== undefined,
    "an UNCOMPRESSED payload bigger than its spans still warns — the Pawn start-only bug");
  check(chainCoverageWarning("CRAZY1:04_pack2@$E000", 8002, spans, { format: "rle" }) === undefined,
    "a payload declared rle does not: 26 sectors of packed bytes unpack to more than 26 sectors");
  check(chainCoverageWarning("p", 8002, spans, { packer: "exomizer" }) === undefined,
    "nor does one with a packer declared");
  check(chainCoverageWarning("p", 8002, spans, { format: "unknown" }) === undefined,
    "nor one whose codec is declared unknown — we may not assume raw");
  check(payloadIsPacked({ format: "prg" }) === false && payloadIsPacked({}) === false,
    "a prg / an undeclared payload counts as stored raw");
  const warn = chainCoverageWarning("raw", 8002, spans, { format: "prg" });
  check(/format.*packer|packer.*format/s.test(warn), "and the warning names the escape", warn?.slice(-80));
}

// 4 — medium_path resolution
{
  head(4, "a medium path resolves the way every other path argument does");
  const { readerForMedium, noMediumMessage, mediumSearchPaths } =
    await import("../dist/project-knowledge/lut-medium.js");
  const proj = mkdtempSync(join(tmpdir(), "c64re-med-"));
  mkdirSync(join(proj, "input", "disk"), { recursive: true });
  const img = join(proj, "input", "disk", "CRAZY1.D64");
  writeFileSync(img, Buffer.alloc(512, 0x41));
  check(readerForMedium("input/disk/CRAZY1.D64", proj) !== undefined,
    "a project-relative medium_path probes");
  check(readerForMedium(img, proj) !== undefined, "an absolute one still does");
  check(readerForMedium("input/disk/NOPE.D64", proj) === undefined, "a missing one does not");
  const msg = noMediumMessage("input/disk/NOPE.D64", proj);
  check(msg.includes(join(proj, "input/disk/NOPE.D64")) && msg.includes("tried"),
    "and the refusal says what was tried", msg);
  check(mediumSearchPaths("a.d64", proj).length === 2, "cwd-relative and project-relative are both tried");
}

// 5 — frontmatter
{
  head(5, "doc_register reports every problem at once and accepts quoted list items");
  const { parseFrontmatter } = await import("../dist/docs/frontmatter.js");
  const quoted = parseFrontmatter([
    "---", 'title: A', "kind: synthesis", "covers:", '  - "$C820-$CFFF"',
    'sources: ["a.asm", "b.prg"]', "status: current", "---", "body", "",
  ].join("\n"));
  check(quoted.frontmatter !== undefined, "a quoted covers entry is accepted", quoted.error);
  check(quoted.frontmatter?.covers?.[0]?.start === 0xc820 && quoted.frontmatter?.covers?.[0]?.end === 0xcfff,
    "and parses to the range it names");
  check(quoted.frontmatter?.sources?.join(",") === "a.asm,b.prg", "so are quoted inline-list items");

  const many = parseFrontmatter([
    "---", "kind: nonsense", "status: draft", "covers:",
    "  - $C820-$CFFF (the loader)", "  - notanaddress", "---", "body", "",
  ].join("\n"));
  check(many.error !== undefined, "a malformed block is still refused");
  const e = many.error ?? "";
  check(e.includes("`title`") && e.includes("`kind`") && e.includes("`status`")
    && e.includes("(the loader)") && e.includes("notanaddress"),
    "and all five problems are named in ONE refusal, not one per call", e.split("\n")[0]);
  check(/one entry per/.test(e), "the covers message says what the fix is, not just that it is wrong");
  check(!/""/.test(e), "and no message quotes a quote (the old doubled-quote tell)");
}

// 5b — the rule can reach its moment
{
  head("5b", "the document rule is deliverable");
  const { parseRule } = await import("../dist/project-rules/rules.js");
  const text = readFileSync(join(ROOT, "assets/project-rules/documents-declare-themselves.md"), "utf8");
  const rule = parseRule("documents-declare-themselves", text);
  check(rule?.tools.includes("doc_register"), "doc_register carries it", (rule?.tools ?? []).join(","));
  check(rule?.tools.includes("doc_template"), "so does doc_template");
  const docs = readFileSync(join(ROOT, "src/server-tools/docs.ts"), "utf8");
  const tmplBlock = docs.slice(docs.indexOf('"doc_template"'), docs.indexOf('"wiki_index"'));
  check(/project_dir: z\.string\(\)\.optional\(\)/.test(tmplBlock),
    "doc_template takes project_dir, so the footer can resolve a project at all");
}

// 6 — the L2 chain verifies
{
  head(6, "the L2 auto-chain carries a rebuild verdict");
  const { summarizeAutoChain } = await import("../dist/lib/extract-auto-chain.js");
  const s = summarizeAutoChain([
    { payloadId: "a", status: "done", rebuild: "verified" },
    { payloadId: "b", name: "02_loader", status: "done", rebuild: "diverged" },
    { payloadId: "c", status: "skipped", reason: "internal" },
  ]);
  check(/Rebuild: 1 byte-identical, 1 diverged/.test(s), "the summary states the verdict", s.split("\n")[1]);
  check(/02_loader/.test(s), "and names a listing that did not rebuild");
  const workflow = readFileSync(join(ROOT, "src/lib/prg-workflow.ts"), "utf8");
  check(/rebuildVerification\(/.test(workflow), "the workflow the chain runs actually calls the verifier");
  check(/rawBlob: opts\.loadAddress !== undefined/.test(workflow),
    "a raw blob is compared past the load header the assembler adds, not reported as a divergence at 0");
  const verify = readFileSync(join(ROOT, "src/lib/rebuild-verify.ts"), "utf8");
  check(/if \(assemblyOk && !verified && existsSync\(tempPrg\)\)/.test(verify),
    "a byte-identical rebuild-check is not registered — saveArtifact dedups by content hash and it would overwrite the source's own row");
}

// 7 — the sandbox run list
{
  head(7, "a truncated written-run list cannot be read as the whole story");
  const src = readFileSync(join(ROOT, "src/server-tools/sandbox.ts"), "utf8");
  check(/write_runs_from/.test(src), "the tool takes a page offset");
  check(/NOT SHOWN/.test(src) && /the largest is/.test(src),
    "the tail names the hidden total and the largest hidden run");
  check(!/, … \+\$\{rest\} more/.test(src), "the old footnote-shaped tail is gone");
}

// 8 — coverage + the S5/S6 contradiction + the header
{
  head(8, "project_slots reports a reachable number and does not contradict itself");
  const { formatSlotReport } = await import("../dist/slots/state.js");
  const slots = readFileSync(join(ROOT, "src/slots/state.ts"), "utf8");
  check(/identityOf/.test(slots) && /contentHash/.test(slots) && /lineageRoot/.test(slots),
    "the denominator counts each distinct piece of content once");
  check(/S5 is answered but its wording states no number/.test(slots),
    "S6 distinguishes \"S5 unanswered\" from \"S5 answered without a number\"");
  const text = formatSlotReport({
    states: [
      { slot: { id: "S1", name: "Context" }, status: "filled", detail: "x" },
      { slot: { id: "S6", name: "Runtime linkage" }, status: "n/a", detail: "y" },
      { slot: { id: "S12", name: "Coverage" }, status: "empty", detail: "z" },
    ],
    naming: { named: 0, members: 0, ratio: 0, machineNamed: 0 },
    records: 0,
    missing: [{ slot: { id: "S12", name: "Coverage" }, status: "empty", detail: "z" }],
    coverage: { covered: 100, total: 1000, ratio: 0.1, unmeasured: [], threshold: 0.6, artifacts: 4, duplicates: 17 },
  });
  const header = text.split("\n")[0];
  check(/1\/2 filled, 1 open, 1 not applicable .* 3 defined in all/.test(header),
    "the header states its own arithmetic, including the moving denominator", header);
  check(/denominator: 4 distinct loadable artifact/.test(text) && /17 further copies/.test(text),
    "and the coverage line says what its denominator is made of",
    text.split("\n").find((l) => l.includes("denominator")));
}

// 9 — slot_record's title
{
  head(9, "a slot answer that needs a sentence still gets a readable title");
  const src = readFileSync(join(ROOT, "src/server-tools/slots.ts"), "utf8");
  check(/title: z\.string\(\)\.max\(120\)\.optional\(\)/.test(src), "slot_record takes an explicit title");
  check(/title: title\?\.trim\(\) \|\| headline\(answer\)/.test(src), "and derives one when it is omitted");
  check(/summary: `\$\{def\.name\} \(Spec 844 \$\{slot\}\)\.\\n\\n\$\{answer\.trim\(\)\}/.test(src),
    "while the whole answer is kept in the body");
}

// 10 — the verdict carries its remedy
{
  head(10, "a blocking verdict says how to settle it");
  const { CHECK_BY_ID } = await import("../dist/critic/checks.js");
  const def = CHECK_BY_ID.get("refutation-without-casualty");
  check(/amends:<name>/.test(def.settleBy) && /save_finding/.test(def.settleBy),
    "the refutation check names the literal tag and the call that writes it", def.settleBy.slice(0, 70));
  const run = readFileSync(join(ROOT, "src/critic/run.ts"), "utf8");
  check(/blockers\.push\(`\$\{f\.check\}: \$\{f\.title\}\\n\s+settle by: \$\{f\.settleBy\}`\)/.test(run),
    "and verdict() carries it into every blocker line");
}

// 11 + 12 — inventory sync
{
  head(11, "inventory sync counts truthfully and can be told what is intentional");
  const src = readFileSync(join(ROOT, "src/server-tools/inventory-sync.ts"), "utf8");
  check(!/delta\.unregistered\.slice\(0, 10\)/.test(src), "the ten-file cap on the count is gone");
  check(/skippedTotal/.test(src), "the header number is the true total");
  check(/set_current_artifact_version/.test(src), "the version-tie hint names the tool, not the Inspector");
  const { readInventoryDeclaration, INVENTORY_PATTERNS_FILE } =
    await import("../dist/project-knowledge/inventory-patterns.js");
  const proj = mkdtempSync(join(tmpdir(), "c64re-inv-"));
  mkdirSync(join(proj, "knowledge"), { recursive: true });
  check(readInventoryDeclaration(proj).patterns.length === 0, "a project with no declaration declares nothing");
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [{ glob: "analysis/reloc/**/*.prg", kind: "prg", scope: "analysis", role: "relocated-block" }],
    intentional: ["analysis/rebuild/verify-*.json"],
  }));
  const d = readInventoryDeclaration(proj);
  check(d.patterns.length === 1 && d.intentional.length === 1,
    "a project can declare its own directories intentional");
  const { DEFAULT_PATTERNS } = await import("../dist/server-tools/registration.js");
  check(DEFAULT_PATTERNS.some((p) => p.glob.endsWith("manifest.spec784.json")),
    "and the extraction manifest the workflow itself writes is covered by a shipped pattern");

  head(12, "the audit recommends a door that is on the surface");
  const workflowSrc = readFileSync(join(ROOT, "src/server-tools/agent-workflow.ts"), "utf8");
  const auditSrc = readFileSync(join(ROOT, "src/project-knowledge/audit.ts"), "utf8");
  check(!/Run bulk_import_analysis_reports/.test(workflowSrc) && !/Run bulk_import_analysis_reports/.test(auditSrc),
    "nothing recommends the advanced-tier tool a default session cannot call");
  check(/importedAnalysisRuns/.test(src), "project_inventory_sync back-fills the analysis runs itself");
}

// 13 — the packer verdict
{
  head(13, "the SFX probe's confidence reflects what it showed");
  const src = readFileSync(join(ROOT, "src/compression-tools.ts"), "utf8");
  check(!/confidence: basic \? 0\.93 : 0\.85/.test(src), "0.93-because-BASIC-SYS is gone");
  check(!/reason: "Exomizer self-extracting wrapper decrunch succeeded structurally\."/.test(src),
    "\"succeeded structurally\" as a reason is gone");
  const block = src.slice(src.indexOf("const exoSfxSuggestion"), src.indexOf("suggestions.push(exoSfxSuggestion)"));
  check(/confidence: plausible \? 0\.5 : 0\.2/.test(block), "it claims at most 0.5");
  check(/does NOT identify the codec/.test(block), "and its reason says what it did not check");
  const aw = readFileSync(join(ROOT, "src/server-tools/analysis-workflow.ts"), "utf8");
  check(/top\.confidence < 0\.6/.test(aw),
    "and analyze_prg no longer says \"likely Exomizer-packed\" on the strength of it");
}

// BUG-059 defect 2 — the CLI's own recovery note, and who it speaks to.
{
  head("2b", "the note about a shifted analysis names both doors");
  const { execFileSync } = await import("node:child_process");
  const d = mkdtempSync(join(tmpdir(), "c64re-note-"));
  const prg = join(d, "n.prg");
  writeFileSync(prg, Buffer.from([0x00, 0xc0, 0xa9, 0x01, 0x60]));
  const analysis = join(d, "n_analysis.json");
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prg, analysis, "c000", "--no-register"], { stdio: "pipe" });
  // the analysis in the ENTRY-POINT slot: the only shape that reaches the note
  const out = execFileSync(process.execPath,
    [join(ROOT, "dist/pipeline/cli.cjs"), "disasm-prg", prg, join(d, "n.asm"), analysis, "--no-register"],
    { stdio: "pipe" }).toString();
  check(/the entry-points slot held n_analysis\.json/.test(out), "the note still fires when the analysis slides into the entry-point slot");
  check(/analysis_json \(MCP tool disasm_prg\)/.test(out),
    "and it names the MCP parameter for the reader who has no flags", out.split("\n").find((l) => /^Note:/.test(l)));
  check(/--analysis <path> \(this CLI\)/.test(out), "…and the CLI flag, labelled as the CLI's");
}

// ───────────────────────────────────────────────────────── live, through the server

head("L", "live: the doors, over MCP");
const proj = mkdtempSync(join(tmpdir(), "c64re-tool-"));
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pend = new Map();
let nid = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    let m;
    try { m = JSON.parse(ln); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nid++;
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-tooling-defects", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "toolingdefects" });
  await call("agent_onboard", {});

  // A tiny PRG at $C000 that is real code, so analyze/disasm have something to chew.
  const LOAD = 0xc000;
  const bytes = [0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60];
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const prgRel = "artifacts/prg/tiny.prg";
  writeFileSync(join(proj, prgRel), Buffer.from([LOAD & 0xff, LOAD >> 8, ...bytes]));

  // 2 (live) — the refusal, not a node stack trace
  const badReloc = await call("disasm_prg", {
    prg_path: prgRel,
    relocations: [{ fileStart: "0002", fileEnd: "0024", runtimeAddr: "2000" }],
  });
  check(/disasm_prg refused/.test(badReloc) && /outside tiny\.prg/.test(badReloc),
    "a relocation outside the PRG comes back as a refusal", badReloc.split("\n").slice(0, 3).join(" "));
  check(!/at Object\.|node:internal/.test(badReloc), "with no node stack trace in it");

  // BUG-059 defect 2 — the entry-point slot is for addresses.
  //
  // The run saw "Note: the entry-points slot held X_analysis.json … Pass --analysis
  // <path>" about thirty-five times and could not act on it: the MCP surface has no
  // flags. No caller in the tree passes the analysis positionally (both doors use
  // --analysis by name), so the only way in is an analysis path inside entry_points
  // — which is refused here, naming the parameter that does take it.
  const epJson = await call("disasm_prg", {
    prg_path: prgRel,
    entry_points: ["artifacts/prg/tiny_analysis.json"],
  });
  check(/disasm_prg refused/.test(epJson) && /entry_points\[0\]/.test(epJson),
    "an analysis path in entry_points is refused by name", epJson.split("\n").filter(Boolean)[2]);
  check(/analysis_json/.test(epJson) && !/--analysis/.test(epJson),
    "…and the remedy it names is the MCP parameter, not a CLI flag");
  const epBad = await call("disasm_prg", { prg_path: prgRel, entry_points: ["main"] });
  check(/disasm_prg refused/.test(epBad) && /is not an address/.test(epBad),
    "any non-address entry point is refused the same way", epBad.split("\n").filter(Boolean)[2]);
  const epGood = await call("disasm_prg", { prg_path: prgRel, entry_points: ["$C000", "c000", "0xC000"] });
  check(!/refused/.test(epGood), "…and all three spellings of one address still pass");

  // 1 (live) — a payload registered as a disk-file is linkable
  const reg = await call("register_payload", {
    name: "pack1_nameint1",
    kind: "disk-file",
    load_address: 0x2000,
    format: "rle",
    medium_spans: [{ kind: "sector", track: 18, sector: 1, length: 254 }],
  });
  const id = (/ID: (\S+)/.exec(reg) ?? [])[1];
  check(!!id, "a disk-file payload registers", reg.split("\n")[1]);
  check(!/Chain coverage/.test(reg), "3 (live): and an rle payload draws no chain-coverage warning");
  const listed = await call("list_payloads", {});
  check(listed.includes(id ?? "@@"), "list_payloads shows it", listed.split("\n")[0]);
  const lut = await call("declare_lut_descriptor", {
    name: "pack index", layout: "packed", identity_scheme: "index", row_count: 4, record_stride: 4,
    columns: [{ role: "track", width: 1, at: 0 }, { role: "sector", width: 1, at: 1 }],
  });
  const lutId = (/ID: (\S+)/.exec(lut) ?? [])[1];
  const linked = await call("link_payload_to_lut_row", { payload_id: id, descriptor_id: lutId, row_index: 0 });
  check(/is claimed by/.test(linked), "link_payload_to_lut_row accepts it", linked);

  // 1b (live) — project_dir may be omitted in an onboarded session
  check(/is claimed by/.test(linked), "and none of these calls needed project_dir");

  // 5b (live) — the rule arrives with doc_template, the tool that IS the moment
  const tmpl = await call("doc_template", { kind: "synthesis", title: "X" });
  check(/Project rule — documents-declare-themselves/.test(tmpl),
    "the document rule rides on doc_template's own answer", tmpl.split("\n").find((l) => /Project rule/.test(l)) ?? tmpl.slice(0, 80));
  const ledgerPath = join(proj, "knowledge", "rules-delivered.json");
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { delivered: {} };
  check(Object.keys(ledger.delivered).includes("documents-declare-themselves"),
    "and the delivery is recorded, so it is said once and not again", Object.keys(ledger.delivered).join(","));

  // 5 (live) — doc_register reports everything at once
  mkdirSync(join(proj, "docs"), { recursive: true });
  writeFileSync(join(proj, "docs", "bad.md"), [
    "---", "kind: nonsense", "covers:", '  - "$C000-$C005"', "  - nonsense entry", "---", "body", "",
  ].join("\n"));
  const refused = await call("doc_register", { path: "docs/bad.md" });
  check(/doc_register refused/.test(refused), "a malformed document is refused");
  check(/`title`/.test(refused) && /`kind`/.test(refused) && /nonsense entry/.test(refused),
    "naming every problem in the one answer", refused.split("\n").find((l) => /problems/.test(l)));
  check(!/\$C000-\$C005/.test(refused.split("nonsense entry")[0] ?? refused),
    "and the quoted-but-valid entry is not among them");
  writeFileSync(join(proj, "docs", "good.md"), [
    "---", "title: Tiny", "kind: synthesis", "covers:", '  - "$C000-$C005"',
    "sources: [tiny.prg]", "status: current", "---", "", "# Tiny", "",
  ].join("\n"));
  const ok = await call("doc_register", { path: "docs/good.md" });
  check(/Registered synthesis "Tiny"/.test(ok), "and a quoted covers entry registers", ok.split("\n")[0]);

  // 9 (live) — a paragraph answer gets a headline
  const longAnswer = "One resident image per phase, five in all; the loader swaps them at $0801 and each is depacked in place before the previous one is released, which is why the memory map shows only one live at a time.";
  const rec = await call("slot_record", {
    slot: "S5", answer: longAnswer,
    evidence: "read from the loader listing at $0810-$08C0",
  });
  const titleLine = (rec.split("\n").find((l) => l.startsWith("Title:")) ?? "").slice("Title:".length).trim();
  check(titleLine.length > 0 && titleLine.length <= 90, "the finding gets a headline, not a paragraph", `${titleLine.length} chars: ${titleLine}`);
  check(!titleLine.includes("memory map shows only one live"), "the whole answer is not the title");
  check(/the full answer is the finding's body/.test(rec), "and the answer is kept, which the tool says");
  const slots = await call("project_slots", {});
  check(!/S5 has not stated a runtime count yet/.test(slots)
    || !/✓ S5/.test(slots),
    "S6 never says S5 is unanswered while S5 shows ✓",
    slots.split("\n").filter((l) => /S5|S6/.test(l)).join(" | "));
  check(/defined in all/.test(slots.split("\n")[0]), "and the header states its arithmetic", slots.split("\n")[0]);

  // 11/12 (live) — inventory sync
  mkdirSync(join(proj, "analysis", "reloc"), { recursive: true });
  writeFileSync(join(proj, "analysis", "reloc", "block.prg"), Buffer.from([0x00, 0x20, 0xea]));
  const sync1 = await call("project_inventory_sync", {});
  check(/match no registration pattern/.test(sync1), "an undeclared directory is reported", sync1.split("\n").find((l) => /no registration/.test(l)));
  check(/inventory-patterns\.json/.test(sync1), "and the report says how to declare it intentional");
  check(/Analysis runs back-filled/.test(sync1), "the facade reports its own analysis back-fill");
  writeFileSync(join(proj, "knowledge", "inventory-patterns.json"), JSON.stringify({
    patterns: [{ glob: "analysis/reloc/**/*.prg", kind: "prg", scope: "analysis", role: "relocated-block" }],
    intentional: [],
  }));
  const sync2 = await call("project_inventory_sync", {});
  check(!/analysis\/reloc\/block\.prg/.test(sync2), "and once declared, it is registered instead of reported",
    sync2.split("\n").filter((l) => /reloc/.test(l)).join(" | "));

  // 6 (live) — the chain's verdict
  const analysed = await call("analyze_prg", { prg_path: prgRel, entry_points: ["C000"] });
  check(/Analysis/i.test(analysed) || analysed.length > 0, "analyze_prg runs");
  const dis = await call("disasm_prg", { prg_path: prgRel, analysis_json: "artifacts/prg/tiny_analysis.json" });
  if (/rebuild verification failed to run/.test(dis)) {
    skip("disasm_prg states a rebuild verdict", "no KickAssembler on this machine");
  } else {
    check(/rebuild verified byte-identical|rebuild diverges/.test(dis),
      "disasm_prg states a rebuild verdict", dis.split("\n").find((l) => /rebuild/i.test(l)));
  }
  // …and the same verdict now reaches the L2 chain, through the workflow both use.
  const { runPrgReverseWorkflow } = await import("../dist/lib/prg-workflow.js");
  const wf = await runPrgReverseWorkflow({ projectRoot: proj, prgPath: prgRel, mode: "quick", rebuildViews: false });
  const phase = wf.phases.find((ph) => ph.phase === "rebuild-verify");
  check(phase !== undefined, "the auto-chain workflow runs a rebuild-verify phase", phase ? `${phase.status}: ${phase.reason}` : "absent");
  if (wf.rebuildAssemblerMissing) {
    skip("and reports byte-identity", "no KickAssembler on this machine");
  } else {
    check(wf.rebuildVerified === true, "and reports byte-identity", wf.rebuildVerdict);
  }
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  live phase threw: ${e.message}`);
} finally {
  proc.stdin.end();
  proc.kill();
}

console.log(`\n${pass} passed, ${failCount} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failCount === 0 ? 0 : 1);
