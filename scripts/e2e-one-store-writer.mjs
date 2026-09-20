#!/usr/bin/env node
// One writer on the knowledge store, on the MCP path.
//
// `knowledge/artifacts.json` had two writers in two processes: the MCP server's
// `saveArtifact`, and `registerCliArtifact` in the pipeline child. That is why the
// store needed a cross-process lock at all (BUG-056), and why a legacy entity writer
// could sit in the child for months before anyone noticed (BUG-054). BUG-057 closed
// the last MCP door that had no parent-side registration and left the rest as the
// open item: the MCP spawn path now passes `--no-register`, so the child writes
// nothing when the server started it, and a direct `dist/pipeline/cli.cjs` run — which
// has no parent to register for it — still does.
//
// Proving the child wrote NOTHING cannot be done by reading the store. The parent's
// `saveArtifact` dedups a row by path and overwrites `producedByTool` with its own
// name, so a row the child wrote first and the parent then re-saved is
// indistinguishable from one the parent alone wrote — the assertion would pass either
// way. So the child signs its writes from inside, at the one line where the store is
// modified, into the file named by `C64RE_PIPELINE_REGISTRATION_LOG`. This gate sets
// that file, and the signature's ABSENCE after an MCP door is the evidence.
//
// What it checks:
//   0. the two spawn paths differ on purpose, in one named place
//   1. the flag suppresses the write path — and without it the child still registers
//   2. every MCP door that spawns the pipeline: the child signed nothing
//   3. the survey, enforced: every file a door left in the project is in the store
//
// Hermetic: temp projects, synthetic PRGs, a synthetic CRT, synthetic cartridge
// banks. No ROMs, no media, no assembler, no runtime daemon, no network.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:one-store-writer

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const head = (n, t) => console.log(`\n── ${n}. ${t}`);

console.log("One writer, one store\n");

const mcpCli = join(ROOT, "dist/cli.js");
const pipelineCli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(mcpCli) || !existsSync(pipelineCli)) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

// ───────────────────────────────── helpers

const tmpDir = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const write = (root, rel, body) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  return join(root, rel);
};

/** A real PRG: load $C000, `LDA #$01 / STA $D020 / RTS`, padded so the analyser has work. */
const prgBytes = (pad = 700) =>
  Buffer.from([0x00, 0xc0, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60, ...new Array(pad).fill(0xea)]);

const readStore = (root) => {
  const path = join(root, "knowledge", "artifacts.json");
  if (!existsSync(path)) return { items: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { items: [] }; }
};

const registeredPaths = (root) =>
  new Set(readStore(root).items.map((item) => (item.relativePath ?? "").replace(/\\/g, "/")));

/** Every file under `root`, project-relative, posix-spelled. */
function filesUnder(root, rel = "") {
  const out = [];
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const next = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, next)).isDirectory()) out.push(...filesUnder(root, next));
    else out.push(next);
  }
  return out;
}

const readSignatures = (log) =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

// What a door leaves behind that is NOT one of its outputs. Every exception is
// named, because the list IS the survey's other half: anything not on it must have
// a row after the door that wrote it returns.
const NOT_AN_OUTPUT = [
  // The store's own bookkeeping — the artifact rows, the run records, the per-tool
  // latest answers, the timeline, the graph, the caches. These describe the
  // registrations; they are not themselves registered.
  /^knowledge\//, /^analysis\/runs\//, /^analysis\/latest\//, /^analysis\/indexes\//,
  /^session\//, /^views\//, /^\.c64re\//,
  // The steering rules `project_init` provisions into the harness. Not RE output.
  /^\.claude\//,
  // The rebuild check and the assembler's symbol dump beside it. BUG-054 №6 decided
  // a byte-identical rebuild-check PRG is not registered — it is the verification's
  // scratch, and registering it made a second row with the same bytes as the source,
  // which is exactly the hash-move hazard BUG-056 then had to fix.
  /_rebuild_check\.prg$/, /\.sym$/,
  // Declared intermediate. `full_lut_payloads/` holds every LUT group dumped whole,
  // INCLUDING the ones reconstruct_lut then skips, so the skip can be re-decided
  // later. A row for it would claim the project believes in a file it only kept.
  /\/full_lut_payloads\//,
  // A named gap this round did not touch, and did not make: `extract_crt` registers
  // the manifest and the extracted files a payload entity matched, and leaves the
  // raw per-chip and per-bank dumps to `project_inventory_sync`. The pipeline child
  // never registered them either, so suppressing the child changed nothing here.
  /\/extracted\/(chips|banks)\//,
];
const isOutput = (rel) => !NOT_AN_OUTPUT.some((re) => re.test(rel));

// ───────────────────────────────── 0. the two spawn paths, in one named place

{
  head(0, "the MCP path and the shell path differ on purpose, in one place");
  const runCliSrc = readFileSync(join(ROOT, "src/run-cli.ts"), "utf8");
  check(/export const SUPPRESS_CHILD_REGISTRATION = "--no-register"/.test(runCliSrc),
    "src/run-cli.ts names the flag once, as a constant");
  check(/export function pipelineArgvFromMcp/.test(runCliSrc),
    "and builds the child's argv through one helper");
  // The point of the helper is that a new call site cannot silently acquire a second
  // writer, so the raw argv may not be spelled out anywhere else in the file.
  const execArgv = runCliSrc.match(/\[\s*"--disable-warning=ExperimentalWarning",[^\]]*\]/s)?.[0] ?? "";
  check(/pipelineArgvFromMcp\(command, args\)/.test(execArgv),
    "the one spawn in the file uses it", execArgv.replace(/\s+/g, " ").slice(0, 96));

  const { pipelineArgvFromMcp } = await import(join(ROOT, "dist/run-cli.js"))
    .catch(() => ({ pipelineArgvFromMcp: undefined }));
  const argv = typeof pipelineArgvFromMcp === "function"
    ? pipelineArgvFromMcp("analyze-prg", ["/p/a.prg", "/p/a.json"])
    : [];
  check(argv[0] === "analyze-prg" && argv[1] === "--no-register",
    "the flag goes in front of the verb's own arguments, where no positional slot can eat it",
    argv.join(" "));
  check(argv.slice(2).join(" ") === "/p/a.prg /p/a.json", "and the arguments come through untouched");

  const childSrc = readFileSync(join(ROOT, "pipeline/src/lib/artifact-register.ts"), "utf8");
  check(/"cli-default" \| "suppressed-by-caller"/.test(childSrc),
    "the child states which of the two callers it is serving, by name");
  check(/C64RE_PIPELINE_REGISTRATION_LOG/.test(childSrc),
    "and signs the write it makes, so the absence of a write is checkable from outside");
}

// ───────────────────────────────── 1. the flag, and the shell path that keeps its writer

{
  head(1, "--no-register suppresses the child's write path; without it the child still registers");
  const proj = tmpDir("c64re-1w-cli-");
  mkdirSync(join(proj, "knowledge"), { recursive: true });
  writeFileSync(join(proj, "knowledge", "phase-plan.json"), JSON.stringify({ schemaVersion: 1, phases: [] }, null, 2));
  write(proj, "artifacts/prg/a.prg", prgBytes());
  write(proj, "artifacts/prg/b.prg", prgBytes(600));
  const log = join(proj, "signatures.tsv");

  const runPipeline = (args) => new Promise((res) => {
    const child = spawn(process.execPath, [pipelineCli, ...args], {
      cwd: proj,
      env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_PIPELINE_REGISTRATION_LOG: log },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => res({ code, stdout, stderr }));
  });

  const suppressed = await runPipeline([
    "analyze-prg", "--no-register",
    join(proj, "artifacts/prg/a.prg"), join(proj, "artifacts/prg/a_analysis.json"),
  ]);
  check(suppressed.code === 0, "the verb runs with the flag", suppressed.stderr.slice(0, 120));
  check(existsSync(join(proj, "artifacts/prg/a_analysis.json")), "and writes its output");
  check(!existsSync(join(proj, "knowledge", "artifacts.json")),
    "the store was never created — the child did not touch it");
  check(readSignatures(log).length === 0, "and signed nothing", readSignatures(log).join(" | "));

  const registering = await runPipeline([
    "analyze-prg",
    join(proj, "artifacts/prg/b.prg"), join(proj, "artifacts/prg/b_analysis.json"),
  ]);
  check(registering.code === 0, "the same verb runs without the flag", registering.stderr.slice(0, 120));
  const rows = readStore(proj).items;
  const b = rows.find((r) => (r.relativePath ?? "").endsWith("b_analysis.json"));
  check(!!b, "a direct CLI run still registers what it writes — a shell loop has no parent to do it for it");
  check(b?.producedByTool === "pipeline_cli:analyze-prg", "under the pipeline verb's own name", String(b?.producedByTool));
  check(!rows.some((r) => (r.relativePath ?? "").endsWith("a_analysis.json")),
    "and the suppressed run is still absent — the flag decides, not the verb");
  const signed = readSignatures(log);
  check(signed.length === 1 && signed[0].startsWith("pipeline_cli:analyze-prg\t"),
    "the signature names exactly the one write that happened", signed.join(" | "));
  rmSync(proj, { recursive: true, force: true });
}

// ───────────────────────────────── the live MCP session used by 2 and 3

function startServer(proj, log) {
  const env = {
    ...process.env,
    C64RE_PROJECT_DIR: proj,
    C64RE_PIPELINE_REGISTRATION_LOG: log,
    C64RE_FULL_TOOLS: "1",
    C64RE_SLOT_GATE: "0",
  };
  const proc = spawn(process.execPath, [mcpCli], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
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
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return (r.result?.content || []).map((c) => c.text).join("\n");
  };
  return { proc, rpc, call };
}

/** The synthetic CRT from the crt-chunk gate: one 32-byte CHIP at $8000, bank 0. */
function synthCrt() {
  const size = 32, headerLen = 0x40, packetLen = 0x10 + size;
  const crt = Buffer.alloc(headerLen + packetLen, 0x00);
  crt.write("C64 CARTRIDGE   ", 0, "ascii");
  crt.writeUInt32BE(headerLen, 0x10);
  crt.writeUInt16BE(0x0100, 0x14);
  crt.writeUInt16BE(0x0000, 0x16);
  crt[0x19] = 0x01;
  crt.write("SYNTH-CART", 0x20, "ascii");
  const cp = headerLen;
  crt.write("CHIP", cp, "ascii");
  crt.writeUInt32BE(packetLen, cp + 0x04);
  crt.writeUInt16BE(0x0000, cp + 0x08);
  crt.writeUInt16BE(0x0000, cp + 0x0a);
  crt.writeUInt16BE(0x8000, cp + 0x0c);
  crt.writeUInt16BE(size, cp + 0x0e);
  for (const [i, b] of [0xc3, 0xc2, 0xcd, 0x38, 0x30].entries()) crt[cp + 0x10 + 4 + i] = b;
  for (let i = 9; i < size; i += 1) crt[cp + 0x10 + i] = i % 2 === 0 ? 0x60 : 0xea;
  return crt;
}

/**
 * Cartridge banks shaped the way `parseLutGroups` reads them: bank 00 carries the
 * relocated loader at $8066, whose bank table sits at +$A9 and destination table at
 * +$C3. Ten groups, one of them past the table index below which the verb skips —
 * which is what makes `boot_payloads.json` name a payload at all.
 */
function writeCartBanks(proj, analysisRel) {
  const chips = join(proj, analysisRel, "extracted", "chips");
  mkdirSync(chips, { recursive: true });
  const bank0 = Buffer.alloc(0x2000, 0xea);
  const bankTable = 0x66 + 0xa9;
  const destTable = 0x66 + 0xc3;
  for (let i = 0; i < 26; i += 1) {
    if (i < 9) bank0[bankTable + i] = 0x80 | 0x01;        // bank 1, end of group
    else if (i === 9) bank0[bankTable + i] = 0x80 | 0x02; // bank 2, end of group
    else bank0[bankTable + i] = 0x00;                     // no end flag: never a group
    bank0[destTable + i] = 0x20;                          // destination $2000, size $2000
  }
  writeFileSync(join(chips, "bank_00_8000.bin"), bank0);
  writeFileSync(join(chips, "bank_01_8000.bin"), Buffer.alloc(0x2000, 0xea));
  // 6502-looking bytes, so `classifyChunk` calls it code and the menu disassembler
  // renders instructions rather than a data dump.
  const code = Buffer.alloc(0x2000);
  const pattern = [0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60];
  for (let i = 0; i < code.length; i += 1) code[i] = pattern[i % pattern.length];
  writeFileSync(join(chips, "bank_02_8000.bin"), code);
  writeFileSync(join(proj, analysisRel, "menu_payload_map.json"), JSON.stringify({
    menu_items: [{ menu_index: 0, label: "Intro", mode: 1, payload_group: 9 }],
  }, null, 2));
}

// ───────────────────────────────── 2 + 3. every door that spawns the pipeline

{
  const proj = tmpDir("c64re-1w-mcp-");
  const log = join(tmpdir(), `c64re-1w-signatures-${process.pid}.tsv`);
  rmSync(log, { force: true });
  const { proc, call } = startServer(proj, log);

  /**
   * Run one door and hold it to the rule: everything it left in the project is in the
   * store, and the pipeline child signed nothing.
   */
  const everythingWritten = new Set();
  async function door(label, run, { expectFiles = true } = {}) {
    const before = new Set(filesUnder(proj));
    const signaturesBefore = readSignatures(log).length;
    let answer = "";
    try { answer = await run(); } catch (e) { check(false, `${label} runs`, e.message); return ""; }
    const written = filesUnder(proj).filter((f) => !before.has(f)).filter(isOutput);
    for (const f of written) everythingWritten.add(f);
    const registered = registeredPaths(proj);
    const orphans = written.filter((f) => !registered.has(f));
    if (expectFiles) check(written.length > 0, `${label} wrote something`, `${written.length} file(s)`);
    check(orphans.length === 0, `${label}: everything it wrote is in the store`,
      orphans.length ? orphans.join(", ") : `${written.length} file(s)`);
    const signed = readSignatures(log).slice(signaturesBefore);
    check(signed.length === 0, `${label}: the pipeline child wrote nothing`, signed.join(" | "));
    return answer;
  }

  try {
    head(2, "every MCP door that spawns the pipeline registers from the parent");
    await call("project_init", { project_dir: proj, name: "One Writer" });
    await call("agent_onboard", { project_dir: proj });

    write(proj, "input/prg/main.prg", prgBytes());
    write(proj, "input/crt/synth.crt", synthCrt());
    write(proj, "input/raw/block.bin", Buffer.from([0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60, 0xea, 0xea]));
    writeCartBanks(proj, "analysis/cart");
    // The seed files are the session's own fixtures, not a door's output.
    await call("project_inventory_sync", { project_dir: proj });

    await door("analyze_prg", () => call("analyze_prg", {
      project_dir: proj, prg_path: "input/prg/main.prg", output_json: "analysis/main_analysis.json",
    }));

    await door("disasm_prg", () => call("disasm_prg", {
      project_dir: proj, prg_path: "input/prg/main.prg",
      output_asm: "analysis/main_disasm.asm", analysis_json: "analysis/main_analysis.json",
    }));

    const draft = await door("propose_annotations", () => call("propose_annotations", {
      project_dir: proj, analysis_json: "analysis/main_analysis.json",
    }));
    // The draft was the last output on the MCP path that only the child named.
    check(/Knowledge run: /.test(draft), "propose_annotations names the knowledge run its draft was registered under",
      draft.split("\n").filter((l) => /Knowledge run/.test(l)).join("") || draft.slice(0, 120));
    const draftRow = readStore(proj).items.find((r) => (r.relativePath ?? "").endsWith("_annotations.draft.json"));
    check(draftRow?.producedByTool === "propose_annotations",
      "and the row carries the door's name, not the pipeline verb's", String(draftRow?.producedByTool));

    await door("ram_report", () => call("ram_report", {
      project_dir: proj, analysis_json: "analysis/main_analysis.json",
    }));

    await door("pointer_report", () => call("pointer_report", {
      project_dir: proj, analysis_json: "analysis/main_analysis.json",
    }));

    await door("basic_tokenize", () => call("basic_tokenize", {
      project_dir: proj, text: "10 SYS 2080\n", output_path: "analysis/boot.prg",
    }));

    await door("basic_list", () => call("basic_list", {
      project_dir: proj, prg_path: "analysis/boot.prg",
    }), { expectFiles: false });

    await door("disasm_raw", () => call("disasm_raw", {
      project_dir: proj, path: "input/raw/block.bin", load_address: "0400",
      output_asm: "analysis/block_disasm.asm",
    }));

    await door("extract_crt", () => call("extract_crt", {
      project_dir: proj, crt_path: "input/crt/synth.crt", output_dir: "analysis/extracted",
    }));

    // The three cartridge-menu verbs. Nothing registered their outputs before —
    // not the child (they never called `registerCliArtifact`) and not the door.
    const lut = await door("reconstruct_lut", () => call("reconstruct_lut", { analysis_dir: "analysis/cart" }));
    check(/Registered \d+ artifact/.test(lut), "reconstruct_lut says what it registered",
      lut.split("\n").filter((l) => /Registered/.test(l)).join("") || lut.slice(0, 120));
    check(!registeredPaths(proj).has("analysis/cart/full_lut_payloads/group_00.bin"),
      "and leaves the intermediate group dump unregistered, as declared");

    await door("export_menu", () => call("export_menu", { analysis_dir: "analysis/cart" }));

    const menu = await door("disasm_menu", () => call("disasm_menu", {
      analysis_dir: "analysis/cart", output_dir: "analysis/cart/kickasm_sources",
    }));
    check(/Registered \d+ artifact/.test(menu), "disasm_menu says what it registered",
      menu.split("\n").filter((l) => /Registered/.test(l)).join("") || menu.slice(0, 120));
    check([...registeredPaths(proj)].some((p) => p.endsWith("menu_payloads_index.asm")),
      "including the include index that ties the listings together");

    await door("run_prg_reverse_workflow", () => call("run_prg_reverse_workflow", {
      project_dir: proj, prg_path: "input/prg/main.prg", mode: "full", rebuild_views: false,
      output_dir: "analysis/chain",
    }));

    head(3, "the survey, over the whole session");
    // Every output every door produced, checked once more at the end: a later door
    // may not evict an earlier one's row, which is how the leftovers rotated in
    // BUG-056 before the hash-move matcher was narrowed.
    const registeredNow = registeredPaths(proj);
    const leftovers = [...everythingWritten].filter((f) => !registeredNow.has(f));
    check(leftovers.length === 0,
      `no output of the ${everythingWritten.size} this session produced is unknown to the store`,
      leftovers.length ? leftovers.slice(0, 8).join(", ") : "every output still has a row at the end");
    const allSignatures = readSignatures(log);
    check(allSignatures.length === 0,
      "and across the whole session the pipeline child never wrote the store",
      allSignatures.slice(0, 5).join(" | "));
    const store = readStore(proj).items;
    check(store.length > 0 && !store.some((r) => String(r.producedByTool ?? "").startsWith("pipeline_cli:")),
      "no row claims a pipeline verb as its producer", `${store.length} rows`);
  } catch (e) {
    check(false, "harness", e.message);
  } finally {
    proc.kill();
    rmSync(log, { force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} one store writer: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
