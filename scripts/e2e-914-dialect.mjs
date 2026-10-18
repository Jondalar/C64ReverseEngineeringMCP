#!/usr/bin/env node
// Spec 914 — a listing is written in ONE dialect, chosen per file, and sources of different
// dialects build together.
//
// Hermetic: temp projects, synthetic bytes, the product's own MCP doors over stdio. No game data,
// no ROMs, no runtime, no :4312. The assemblers it needs are KickAssembler (jar) and 64tass; a
// check that needs one that is not here SKIPS LOUDLY — a skip is not a pass.
//
//   S1  64tass project: one .tas, byte-identical rebuild with 64tass; KickAss project: one .asm;
//       for disasm_prg, disasm_raw, disasm with paths, disasm_menu, run_prg_reverse_workflow
//   S2  the emitters: relocated blocks, forced-absolute operands, equates, in both dialects, each
//       rebuilt byte-identical by its own assembler
//   S3  assembler= sets the record and is kept; per file beats per project; project_init and
//       agent_onboard require the choice; a render with no dialect is refused by name
//   S4  the "Run disasm" task closes in a 64tass project; annotation status, phase status,
//       list_artifacts and the UI read the .tas
//   S5  the verdict is on the record; a missing assembler is said by name
//   S6  KickAss <-> 64tass units build together; the foreign file is untouched; a missing label
//       is refused by name
//   S7  a project rendered before (both files on disk, no preference) opens and reads as before;
//       a stored task that waits for `_disasm.asm` closes on the .tas (#138)
//
//   npm run e2e:914

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMcp } from "./lib/mcp-stdio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${!cond && detail ? `\n          ${String(detail).replace(/\n/g, "\n          ")}` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why}) — NOT counted as a pass`); };
const head = (t) => console.log(`\n── ${t}`);

if (!existsSync(join(ROOT, "dist/cli.js")) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const haveKick = existsSync(jar);
const have64tass = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0
  || existsSync("/opt/homebrew/bin/64tass") || existsSync("/usr/local/bin/64tass");

const { assembleSource } = await import(pathToFileURL(join(ROOT, "dist/assemble-source.js")).href);
const { assembleUnits, UnitBuildRefusal } = await import(pathToFileURL(join(ROOT, "dist/assemble-units.js")).href);
const { ProjectKnowledgeService } = await import(pathToFileURL(join(ROOT, "dist/project-knowledge/service.js")).href);
const { listingFor } = await import(pathToFileURL(join(ROOT, "dist/project-knowledge/listing-for.js")).href);
const { L, emitListing } = require(join(ROOT, "dist/pipeline/lib/listing.cjs"));

console.log("Spec 914 — a listing is written in one dialect, chosen per file\n");

// ── fixtures ───────────────────────────────────────────────────────────────────
// $C000: lda #0 / sta $D020 / sta $0074 (ABSOLUTE form of a zero-page address) / ldx #3 / dex / bne / jsr $C011 / rts / lda $74 / rts
const CODE = [0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x8d, 0x74, 0x00, 0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x20, 0x11, 0xc0, 0x60, 0xa5, 0x74, 0x60];
const prgOf = (load, body) => Buffer.concat([Buffer.from([load & 0xff, load >> 8]), Buffer.from(body)]);
const PRG = prgOf(0xc000, CODE);
// a second, different one so a batch has two files
const PRG2 = prgOf(0xc100, [0xa9, 0x05, 0x8d, 0x21, 0xd0, 0x60]);

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tmp = [];
const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `c64re-914-${name}-`)); tmp.push(d); return d; };
const filesUnder = (dir, re) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== "knowledge" && e.name !== ".git") walk(p); } else if (re.test(e.name)) out.push(p); } };
  walk(dir);
  return out;
};

/** A project with a live MCP server. `prefer` undefined = the service makes it WITHOUT a preference (an old project). */
async function openProject(name, prefer, env = {}) {
  const proj = scratch(name);
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1", ...env } });
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-914", version: "1" } });
  mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  if (prefer) await mcp.call("project_init", { project_dir: proj, name, preferred_assembler: prefer });
  else new ProjectKnowledgeService(proj).initProject({ name });
  await mcp.call("agent_onboard", {});
  return { proj, mcp, call: mcp.call, svc: () => new ProjectKnowledgeService(proj) };
}

const assemble = (proj, source, assembler, expected, label) => assembleSource({
  projectDir: proj, sourcePath: source, assembler, outputPath: join(proj, "out", `${label}.prg`),
}).then((r) => {
  if (r.exitCode !== 0) return `${assembler} failed: ${(r.stdout + r.stderr).split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ")}`;
  return Buffer.compare(readFileSync(r.outputPath), expected) === 0 ? true : "bytes differ";
});

// ───────────────────────────────────────────────────────────── S3a: the choice is required
head("S3a. project_init and agent_onboard require the choice");
{
  const fresh = scratch("fresh");
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: fresh, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1" } });
  try {
    await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-914", version: "1" } });
    mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const refused = await mcp.call("project_init", { project_dir: fresh, name: "no choice" });
    check(/project_init refused/.test(refused) && /kickass/.test(refused) && /64tass/.test(refused), "a new project is not created without a choice, and the refusal names both", refused.split("\n").slice(0, 3).join(" | "));
    check(!existsSync(join(fresh, "knowledge")), "…and nothing was written");
    const ok = await mcp.call("project_init", { project_dir: fresh, name: "with choice", preferred_assembler: "64tass" });
    check(/Preferred assembler: 64tass/.test(ok), "with preferred_assembler it is created, and says which");
    const again = await mcp.call("project_init", { project_dir: fresh, name: "with choice" });
    check(!/refused/.test(again) && /Preferred assembler: 64tass/.test(again), "re-running it without the argument keeps the choice");
  } finally { mcp.stop(); }

  // an existing project without one is asked at its next agent_onboard
  const old = scratch("oldproj");
  new ProjectKnowledgeService(old).initProject({ name: "before the choice" });
  const mcp2 = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: old, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1" } });
  try {
    await mcp2.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-914", version: "1" } });
    mcp2.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const onboard = await mcp2.call("agent_onboard", {});
    check(/ASK THE HUMAN FIRST: which assembler/.test(onboard) && /kickass/.test(onboard) && /64tass/.test(onboard), "an old project without a dialect is asked at agent_onboard", onboard.split("\n").slice(0, 4).join(" | "));
    writeFileSync(join(old, "x.prg"), PRG);
    const refused = await mcp2.call("disasm_prg", { prg_path: "x.prg", no_analysis: true });
    check(/refused/.test(refused) && /assembler=/.test(refused) && /preferred_assembler/.test(refused), "a render with no resolvable dialect is REFUSED, naming how to set it", refused.split("\n").slice(0, 5).join(" | "));
    check(filesUnder(old, /_disasm\.(asm|tas)$/).length === 0, "…and nothing was written");
    const chosen = await mcp2.call("agent_onboard", { preferred_assembler: "64tass" });
    check(/Assembler: 64tass — recorded/.test(chosen) && !/ASK THE HUMAN/.test(chosen), "the answer recorded at onboarding is kept", chosen.split("\n").slice(0, 3).join(" | "));
    const rendered = await mcp2.call("disasm_prg", { prg_path: "x.prg", no_analysis: true });
    check(existsSync(join(old, "x_disasm.tas")) && /Dialect: 64tass \(the project's\)/.test(rendered), "…and the next render follows it", rendered.split("\n").filter((l) => /Dialect|refused/.test(l)).join(" | "));
  } finally { mcp2.stop(); }
}

// ───────────────────────────────────────────────────────────── S1: one listing, in the project's dialect
for (const dialect of ["64tass", "kickass"]) {
  const ext = dialect === "64tass" ? "tas" : "asm";
  const other = dialect === "64tass" ? "asm" : "tas";
  const marker = dialect === "64tass" ? ";" : "//";
  const assembler = dialect === "64tass" ? "64tass" : "kickassembler";
  const have = dialect === "64tass" ? have64tass : haveKick;
  head(`S1. ${dialect} project: one .${ext}, nothing else`);
  const { proj, mcp, call, svc } = await openProject(`s1-${dialect}`, dialect);
  try {
    writeFileSync(join(proj, "a.prg"), PRG);
    writeFileSync(join(proj, "b.prg"), PRG2);
    const analysed = await call("analyze_prg", { prg_path: "a.prg" });
    check(existsSync(join(proj, "a_analysis.json")), "analyze_prg ran", analysed.slice(0, 200));
    const tasks = svc().listTasks().filter((t) => t.autoCloseHint?.kind === "listing-exists");
    check(tasks.length === 1 && tasks[0].status !== "done" && /Run disasm on a\.prg/.test(tasks[0].title), "the 'Run disasm' task names the BYTES, not a file", JSON.stringify(tasks.map((t) => t.autoCloseHint)));

    const out = await call("disasm_prg", { prg_path: "a.prg" });
    const listing = join(proj, `a_disasm.${ext}`);
    check(existsSync(listing), `disasm_prg writes a_disasm.${ext}`, out.slice(0, 300));
    check(!existsSync(join(proj, `a_disasm.${other}`)), `…and no a_disasm.${other}`);
    check(new RegExp(`rebuild verified byte-identical .* with ${dialect === "64tass" ? "64tass" : "KickAssembler"}`).test(out), "the rebuild proof ran with the listing's own assembler", out.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
    const text = readFileSync(listing, "utf8");
    check(new RegExp(`^\\${marker.split("").join("\\")}\\s+rebuild verified byte-identical`, "m").test(text), `the stamp is in the head of the listing, in ${dialect}'s comment syntax (${marker})`);
    check(dialect === "64tass" ? /\bsta\s+@w\s+\$0074\b/.test(text) && !/\.abs\b/.test(text.replace(/;.*$/gm, "")) : /\bsta\.abs\s+\$0074\b/.test(text), "the forced-absolute operand is spelled in this dialect");
    if (have) {
      const r = await assemble(proj, listing, assembler, PRG, `s1-${dialect}`);
      check(r === true, `the listing rebuilds byte-identical with ${dialect}`, r === true ? "" : r);
    } else skip(`${dialect} rebuild`, `${dialect} is not installed`);
    const row = svc().listArtifacts().find((a) => a.path === listing);
    check(row?.rebuild?.verified === true && row.rebuild.assembler === dialect, "the verdict is on the listing's record", JSON.stringify(row?.rebuild));
    check(filesUnder(proj, new RegExp(`\\.${other}$`)).length === 0, `no .${other} anywhere in the project`, filesUnder(proj, new RegExp(`\\.${other}$`)).join(", "));

    // the inventory lists nothing that is not there (#138: it listed the .asm a 64tass project deletes)
    const inv = await call("project_inventory_sync", {});
    const rows = svc().listArtifacts().map((a) => a.path);
    check(!/missing/i.test(inv) && !rows.some((p) => p.endsWith(`.${other}`)) && rows.includes(listing), `the inventory lists the .${ext} and nothing missing, and holds no .${other} record`, inv.split("\n").filter((l) => /missing/i.test(l)).join(" | "));
    // disasm with paths: a batch is one listing per path, each in the dialect
    const batch = await call("disasm", { paths: ["a.prg", "b.prg"] });
    check(existsSync(join(proj, `b_disasm.${ext}`)) && !existsSync(join(proj, `b_disasm.${other}`)) && !existsSync(join(proj, `a_disasm.${other}`)), `disasm with paths: one .${ext} per path, no .${other}`, batch.slice(0, 300));
    // disasm_raw
    const rawBytes = Buffer.from(CODE);
    writeFileSync(join(proj, "blob.bin"), rawBytes);
    const raw = await call("disasm_raw", { path: "blob.bin", load_address: "C000" });
    const rawListings = filesUnder(join(proj, "analysis"), /_disasm\.(asm|tas)$/);
    check(rawListings.length === 1 && rawListings[0].endsWith(`.${ext}`), `disasm_raw: one .${ext} under analysis/raw-disasm`, rawListings.join(", ") || raw.slice(0, 300));
    check(/rebuild verified byte-identical/.test(raw), "…verified (the raw reading compares past the load header)", raw.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
    // run_prg_reverse_workflow
    writeFileSync(join(proj, "c.prg"), prgOf(0xc200, [0xa2, 0x00, 0xca, 0x60]));
    const wf = await call("run_prg_reverse_workflow", { prg_path: "c.prg", mode: "quick", rebuild_views: false });
    check(existsSync(join(proj, `c_disasm.${ext}`)) && !existsSync(join(proj, `c_disasm.${other}`)), `run_prg_reverse_workflow: one .${ext}`, wf.slice(0, 400));
    // disasm_menu: an extracted menu with one code chunk and one data chunk
    const menuDir = join(proj, "analysis", "menu_payload_exports");
    mkdirSync(join(menuDir, "m0"), { recursive: true });
    writeFileSync(join(menuDir, "m0", "code.bin"), Buffer.from([0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60]));
    writeFileSync(join(menuDir, "m0", "data.bin"), Buffer.from([1, 2, 3, 4, 5]));
    writeFileSync(join(menuDir, "manifest.json"), JSON.stringify({ menu_items: [{ label: "m0", files: [
      { type: "chunk", file: "analysis/menu_payload_exports/m0/code.bin", classification: "code", destination_start: 0xc300, destination_end: 0xc305 },
      { type: "chunk", file: "analysis/menu_payload_exports/m0/data.bin", classification: "data", destination_start: 0xc310, destination_end: 0xc314 },
    ] }] }));
    const menu = await call("disasm_menu", { analysis_dir: "analysis", output_dir: "analysis/menu_src" });
    const menuFiles = filesUnder(join(proj, "analysis", "menu_src"), /\.(asm|tas)$/);
    check(menuFiles.length === 3 && menuFiles.every((f) => f.endsWith(`.${ext}`)), `disasm_menu: every source and the index are .${ext}`, menuFiles.join(", ") || menu.slice(0, 300));
    if (have) {
      const code = menuFiles.find((f) => f.endsWith(`code.${ext}`));
      if (code) {
        const r = await assembleSource({ projectDir: proj, sourcePath: code, assembler, outputPath: join(proj, "out", `menu-${dialect}.prg`) });
        check(r.exitCode === 0 && readFileSync(r.outputPath).subarray(2).equals(Buffer.from([0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60])), `the menu's code chunk assembles with ${dialect} to its bytes`, (r.stdout + r.stderr).slice(-200));
      }
    } else skip(`${dialect} menu rebuild`, `${dialect} is not installed`);
  } finally { mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── S2: the emitters
head("S2. the emitters: relocated block, forced-absolute, equates — rebuilt byte-identical in both dialects");
{
  const proj = scratch("s2");
  // a gap, then a block stored at $C310 that runs at $FC00 (a copy loop that reads its own table)
  const gap = [0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60, ...new Array(10).fill(0xea)];
  const block = [0xa2, 0x00, 0xbd, 0x0e, 0xfc, 0x9d, 0x00, 0x04, 0xe8, 0xd0, 0xf7, 0x60, 0xea, 0xea, 0xea, 0xea];
  const prg = prgOf(0xc300, [...gap, ...block]);
  writeFileSync(join(proj, "r.prg"), prg);
  writeFileSync(join(proj, "reloc.json"), JSON.stringify([{ fileStart: "C310", fileEnd: "C31F", runtimeAddr: "FC00" }]));
  // a zero-page name and an out-of-image name from the human: equates in both spellings
  writeFileSync(join(proj, "z.prg"), prgOf(0xc000, [0xa5, 0xfb, 0x8d, 0xfb, 0x00, 0x20, 0x00, 0xe0, 0x60]));
  writeFileSync(join(proj, "z_annotations.json"), JSON.stringify({ labels: [{ address: "00FB", label: "zp_ptr" }, { address: "E000", label: "rom_entry" }] }));
  const cli = (...a) => spawnSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), ...a, "--no-register"], { cwd: proj, encoding: "utf8" });
  const cases = [
    ["relocated, no analysis", "r.prg", ["--no-analysis", "--relocations", "reloc.json"], prg, [/\.pseudopc \$FC00/, /\.logical \$FC00/]],
    ["zero-page and foreign names", "z.prg", ["--no-analysis", "--annotations", "z_annotations.json"], prgOf(0xc000, [0xa5, 0xfb, 0x8d, 0xfb, 0x00, 0x20, 0x00, 0xe0, 0x60]), [/\.label zp_ptr/, /^\s*zp_ptr\s*=/m]],
  ];
  for (const [label, file, extra, expected, [kickRe, tassRe]] of cases) {
    const stem = file.replace(/\.prg$/, "");
    for (const [dialect, ext, assembler, have, re] of [["kickass", "asm", "kickassembler", haveKick, kickRe], ["64tass", "tas", "64tass", have64tass, tassRe]]) {
      const out = join(proj, `${stem}.${ext}`);
      const r = cli("disasm-prg", file, out, file === "r.prg" ? "C300" : "C000", ...extra, "--dialect", dialect);
      check(r.status === 0 && existsSync(out), `${label}: ${dialect} listing written`, (r.stderr || r.stdout).slice(0, 300));
      if (!existsSync(out)) continue;
      const text = readFileSync(out, "utf8");
      check(re.test(text), `${label}: ${dialect} spells it its own way`, text.split("\n").slice(0, 3).join(" | "));
      check(!(dialect === "kickass" ? /^\s*\.logical|^\s*\.here/m.test(text) : /\.pseudopc|\.label\s/.test(text)), `${label}: nothing of the other dialect is left in the ${dialect} listing`);
      if (have) {
        const built = await assemble(proj, out, assembler, expected, `s2-${stem}-${dialect}`);
        check(built === true, `${label}: the ${dialect} listing rebuilds byte-identical`, built === true ? "" : built);
      } else skip(`${label}: ${dialect} rebuild`, `${dialect} is not installed`);
    }
  }
  // the emitter, line kind by line kind
  const lines = [
    L.comment("a note about sta.abs"), L.block(["first", "second"], "plain"), L.block(["RULE", "NAME", "RULE"], "banner"),
    L.cpu(), L.origin(0xc000), L.equate("name", "$D020", "comment"), L.label("here", "referenced from there"),
    L.insn("sta", "$0074", true, "forced"), L.insn("lda", "#$01", false), L.byte("$01, $02", "two"), L.word("here"),
    L.relocBegin(0xfc00), L.insn("rts", undefined, false), L.relocEnd(), L.blank(),
  ];
  const kick = emitListing(lines, "kickass");
  const tass = emitListing(lines, "64tass");
  check(/sta\.abs \$0074/.test(kick) && /sta @w \$0074/.test(tass), "emitter: forced-absolute in each spelling");
  check(/\.pseudopc \$FC00 \{/.test(kick) && /\}/.test(kick) && /\.logical \$FC00/.test(tass) && /\.here/.test(tass), "emitter: the relocation block in each spelling");
  check(/\/\* RULE/.test(kick) && /^; RULE$/m.test(tass) && !/\/\*|\*\//.test(tass), "emitter: a banner comment is a block in KickAssembler and semicolons in 64tass");
  check(/^\/\/ a note about sta\.abs$/m.test(kick) && /^; a note about sta\.abs$/m.test(tass), "emitter: a comment is data, never rewritten (`sta.abs` inside it stays)");
}

// ───────────────────────────────────────────────────────────── S3: per file, per project
head("S3. assembler= is remembered on the file; per file beats per project");
{
  const { proj, mcp, call, svc } = await openProject("s3", "kickass");
  try {
    writeFileSync(join(proj, "p.prg"), PRG);
    writeFileSync(join(proj, "q.prg"), PRG2);
    const first = await call("disasm_prg", { prg_path: "p.prg", assembler: "64tass", no_analysis: true });
    check(existsSync(join(proj, "p_disasm.tas")) && !existsSync(join(proj, "p_disasm.asm")), "assembler=64tass in a KickAssembler project: that payload's listing is .tas", first.slice(0, 300));
    check(svc().listArtifacts().find((a) => a.path === join(proj, "p.prg"))?.assembler === "64tass", "…and the record of the bytes says 64tass");
    const again = await call("disasm_prg", { prg_path: "p.prg", no_analysis: true });
    check(existsSync(join(proj, "p_disasm.tas")) && !existsSync(join(proj, "p_disasm.asm")) && /Dialect: 64tass \(set on this file\)/.test(again), "a later render of the same bytes without the argument is .tas again", again.split("\n").filter((l) => /Dialect/.test(l)).join(" | "));
    const other = await call("disasm_prg", { prg_path: "q.prg", no_analysis: true });
    check(existsSync(join(proj, "q_disasm.asm")) && !existsSync(join(proj, "q_disasm.tas")) && /Dialect: KickAssembler \(the project's\)/.test(other), "another file follows the project: .asm");
    // the call beats the file's record
    const back = await call("disasm_prg", { prg_path: "p.prg", assembler: "kickass", no_analysis: true });
    check(existsSync(join(proj, "p_disasm.asm")) && /Dialect: KickAssembler \(named on this call\)/.test(back), "the call's argument beats the file's record", back.split("\n").filter((l) => /Dialect|refused/.test(l)).join(" | "));
    const conflict = await call("disasm_prg", { prg_path: "q.prg", assembler: "kickass", output_asm: "q_x.tas", no_analysis: true });
    check(/refused/.test(conflict) && /output_asm/.test(conflict), "an output name that contradicts the named dialect is refused", conflict.split("\n").slice(0, 3).join(" | "));
    const nameOnly = await call("disasm_prg", { prg_path: "q.prg", output_asm: "analysis/q_named.tas", no_analysis: true });
    check(existsSync(join(proj, "analysis", "q_named.tas")) && /^\s*\* = \$C100/m.test(readFileSync(join(proj, "analysis", "q_named.tas"), "utf8")), "an output named .tas is written in 64tass (it used to be KickAssembler text under a .tas name)");
    check(svc().listArtifacts().find((a) => a.path === join(proj, "q.prg"))?.assembler === undefined, "…and a dialect only the NAME asked for is not remembered on the file");
  } finally { mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── S4: the readers
head("S4. the task closes, the status reads the .tas, the lists show it");
for (const dialect of ["64tass", "kickass"]) {
  const ext = dialect === "64tass" ? "tas" : "asm";
  const have = dialect === "64tass" ? have64tass : haveKick;
  const { proj, mcp, call, svc } = await openProject(`s4-${dialect}`, dialect);
  try {
    writeFileSync(join(proj, "t.prg"), PRG);
    await call("analyze_prg", { prg_path: "t.prg" });
    let task = svc().listTasks().find((t) => /Run disasm on t\.prg/.test(t.title));
    check(task && task.status !== "done", `${dialect}: the "Run disasm" task is open after analyze`);
    // the annotations: a label, so the listing says what happened to them
    writeFileSync(join(proj, "t_annotations.json"), JSON.stringify({ labels: [{ address: "C011", label: "helper" }] }));
    const out = await call("disasm_prg", { prg_path: "t.prg", analysis_json: "t_analysis.json" });
    check(existsSync(join(proj, `t_disasm.${ext}`)), `${dialect}: listing written`, out.slice(0, 300));
    check(/Listing: Semantic annotations applied: 1 names/.test(out), `${dialect}: the annotation status is read from the .${ext}'s own header`, out.split("\n").filter((l) => /^Listing:/.test(l)).join(" | "));
    await call("agent_onboard", {});
    task = svc().listTasks().find((t) => /Run disasm on t\.prg/.test(t.title));
    check(task?.status === "done", `${dialect}: the task is done after the next sync — no .asm was ever written for it`, JSON.stringify(task && { status: task.status, hint: task.autoCloseHint }));
    if (have) {
      const status = svc().getPerArtifactStatus().find((s) => s.relativePath === "t.prg");
      const step = (name) => status?.steps.find((s) => s.name === name)?.status;
      check(step("disasm-pass-1") === "done" && step("rebuild-byte-identical") === "done" && step("disasm-pass-2") === "done", `${dialect}: phase status — disasm passes and the rebuild step are done`, JSON.stringify(status?.steps.map((s) => [s.name, s.status])));
    } else skip(`${dialect} phase status`, `${dialect} is not installed, so no rebuild was proven`);
    const listed = await call("list_artifacts", { subdir: "." });
    check(new RegExp(`t_disasm\\.${ext}`).test(listed), `${dialect}: list_artifacts lists the .${ext}`, listed.split("\n").slice(0, 6).join(" | "));
    check(listingFor(proj, { path: "t.prg" }, svc().listArtifacts())?.dialect === dialect, `${dialect}: listingFor finds it`);
  } finally { mcp.stop(); }
}
{
  const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");
  check(/lower\.endsWith\("\.tas"\) \|\| lower\.endsWith\("\.tass"\)\) return "64tass"/.test(app), "UI source: .tas is 64tass (the highlighter's dialect) — the on-screen check is by hand");
  check(/preferredAsmDialect === "64tass"/.test(app) && /setPreferredAsmDialect\(snapshot/.test(app), "UI source: the dialect tab order follows the project's preference");
}

// ───────────────────────────────────────────────────────────── S5: a missing assembler is said by name
head("S5. the verdict, and a missing assembler by name");
for (const [dialect, ext, env, name] of [
  ["64tass", "tas", { C64RE_64TASS_BIN: "/nonexistent/64tass" }, "64tass is not installed"],
  ["kickass", "asm", { C64RE_KICKASS_JAR: "/nonexistent/KickAss.jar" }, "KickAssembler is not installed"],
]) {
  const { proj, mcp, call, svc } = await openProject(`s5-${dialect}`, dialect, env);
  try {
    writeFileSync(join(proj, "m.prg"), PRG);
    const out = await call("disasm_prg", { prg_path: "m.prg", no_analysis: true });
    check(existsSync(join(proj, `m_disasm.${ext}`)), `${dialect}: the listing is still written`, out.slice(0, 200));
    check(out.includes(name) && !/does not exist|no such file/i.test(out), `${dialect}: the answer says "${name}" and reads no missing file`, out.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
    const stamp = readFileSync(join(proj, `m_disasm.${ext}`), "utf8").split("\n").find((l) => /rebuild/.test(l)) ?? "";
    check(stamp.startsWith(dialect === "64tass" ? "; WARNING" : "// WARNING") && stamp.includes(name), `${dialect}: the stamp in the listing says it too, in the dialect's comment syntax`, stamp);
    const row = svc().listArtifacts().find((a) => a.path === join(proj, `m_disasm.${ext}`));
    check(row?.rebuild === undefined, `${dialect}: no verdict is recorded — nothing was measured`, JSON.stringify(row?.rebuild));
    const step = svc().getPerArtifactStatus().find((s) => s.relativePath === "m.prg")?.steps.find((s) => s.name === "rebuild-byte-identical")?.status;
    check(step === "pending", `${dialect}: the rebuild step stays pending`, step);
  } finally { mcp.stop(); }
}
{
  // an edit made after the proof reads as "not proven"
  if (have64tass) {
    const { proj, mcp, call, svc } = await openProject("s5-edit", "64tass");
    try {
      writeFileSync(join(proj, "e.prg"), PRG);
      await call("disasm_prg", { prg_path: "e.prg", no_analysis: true });
      const stepOf = () => svc().getPerArtifactStatus().find((s) => s.relativePath === "e.prg")?.steps.find((s) => s.name === "rebuild-byte-identical")?.status;
      check(stepOf() === "done", "a proven listing counts");
      const listing = join(proj, "e_disasm.tas");
      writeFileSync(listing, `${readFileSync(listing, "utf8")}\n; a human note added after the proof\n`);
      check(stepOf() === "pending", "…and an edit made after the proof no longer does (the record holds the hash it was measured at)");
    } finally { mcp.stop(); }
  } else skip("edit-after-proof", "64tass is not installed");
}

// ───────────────────────────────────────────────────────────── S6: units of different dialects
head("S6. KickAssembler and 64tass units build together");
{
  const proj = scratch("s6");
  mkdirSync(join(proj, "foreign"), { recursive: true });
  const loader = join(proj, "foreign", "loader.tas");
  writeFileSync(loader, ["        * = $c800", "load_file:", "        lda #$01", "        rts", "save_file:", "        rts", "CONST = $d020", ""].join("\n"));
  writeFileSync(join(proj, "main.asm"), [".pc = $c000 \"main\"", "        jsr load_file", "        sta CONST", "        rts", ""].join("\n"));
  writeFileSync(join(proj, "lib.asm"), [".pc = $c900 \"lib\"", "k_entry:", "        rts", ".label K_CONST = $d021", ""].join("\n"));
  writeFileSync(join(proj, "app.tas"), ["        * = $c100", "        jsr k_entry", "        sta K_CONST", "        rts", ""].join("\n"));
  writeFileSync(join(proj, "bad.asm"), [".pc = $ca00 \"bad\"", "        jsr load_file", "        jsr nowhere_label", "        rts", ""].join("\n"));
  if (!haveKick || !have64tass) {
    skip("mixed builds", `need both assemblers (KickAssembler: ${haveKick}, 64tass: ${have64tass})`);
  } else {
    const before = sha(loader);
    const run = await assembleUnits({ projectDir: proj, units: [
      { path: "main.asm", uses: ["foreign/loader.tas"] },
      { path: "foreign/loader.tas", foreign: true },
    ] });
    const byPath = new Map(run.built.map((u) => [u.path, u]));
    check(run.built.length === 2 && run.built[0].path === "foreign/loader.tas", "the provider is built first, whatever order the units were given in", run.built.map((u) => u.path).join(", "));
    check(byPath.get("foreign/loader.tas")?.assembler === "64tass" && byPath.get("main.asm")?.assembler === "kickassembler", "loader.tas is built with 64tass, main.asm with KickAssembler");
    const mainPrg = readFileSync(byPath.get("main.asm").outputPath);
    check(mainPrg.subarray(0, 2).equals(Buffer.from([0x00, 0xc0])) && mainPrg.subarray(2, 5).equals(Buffer.from([0x20, 0x00, 0xc8])) && mainPrg[5] === 0x8d && mainPrg[6] === 0x20 && mainPrg[7] === 0xd0, "main.asm's `jsr load_file` / `sta CONST` resolve to the loader's addresses ($C800, $D020)", mainPrg.toString("hex"));
    const eq = readFileSync(byPath.get("main.asm").equatesPath, "utf8");
    check(/\.label load_file = \$C800/.test(eq) && /\.label CONST = \$D020/.test(eq), "the loader's symbols became KickAssembler equates", eq);
    check(sha(loader) === before && byPath.get("foreign/loader.tas").sourceHashBefore === byPath.get("foreign/loader.tas").sourceHashAfter, "loader.tas is byte-for-byte unchanged on disk");
    check(filesUnder(join(proj, "foreign"), /./).length === 1, "…and nothing was written beside it");

    const reverse = await assembleUnits({ projectDir: proj, units: [{ path: "app.tas", uses: ["lib.asm"] }, { path: "lib.asm" }] });
    const app = reverse.built.find((u) => u.path === "app.tas");
    const appPrg = readFileSync(app.outputPath);
    check(app.assembler === "64tass" && appPrg.subarray(2, 5).equals(Buffer.from([0x20, 0x00, 0xc9])) && appPrg[5] === 0x8d && appPrg[6] === 0x21 && appPrg[7] === 0xd0, "the other way: a 64tass unit calls into a KickAssembler unit (k_entry = $C900, K_CONST = $D021)", appPrg.toString("hex"));
    check(/^k_entry = \$C900/m.test(readFileSync(app.equatesPath, "utf8")), "…through 64tass equates");

    let refusal = "";
    try { await assembleUnits({ projectDir: proj, units: [{ path: "foreign/loader.tas", foreign: true }, { path: "bad.asm", uses: ["foreign/loader.tas"] }] }); }
    catch (e) { refusal = e instanceof UnitBuildRefusal ? e.message : `WRONG ERROR ${e}`; }
    check(/"nowhere_label"/.test(refusal) && !/"load_file"/.test(refusal), "a label missing from the export is refused by name (and only that one)", refusal);
    let cycle = "";
    try { await assembleUnits({ projectDir: proj, units: [{ path: "main.asm", uses: ["app.tas"] }, { path: "app.tas", uses: ["main.asm"] }] }); } catch (e) { cycle = e.message; }
    check(/circle/.test(cycle), "units that use each other in a circle are refused", cycle);
  }
}
{
  // the MCP door: foreign registered with its dialect, result named per unit
  if (haveKick && have64tass) {
    const { proj, mcp, call, svc } = await openProject("s6-door", "kickass");
    try {
      mkdirSync(join(proj, "foreign"), { recursive: true });
      writeFileSync(join(proj, "foreign", "loader.tas"), "        * = $c800\nload_file:\n        rts\n");
      writeFileSync(join(proj, "main.asm"), ".pc = $c000 \"main\"\n        jsr load_file\n        rts\n");
      const before = sha(join(proj, "foreign", "loader.tas"));
      const out = await call("assemble_source", { units: [
        { path: "foreign/loader.tas", foreign: true },
        { path: "main.asm", uses: ["foreign/loader.tas"] },
      ] });
      check(/Built 2 units/.test(out) && /Assembler: 64tass/.test(out) && /Assembler: kickassembler/.test(out) && /Equates from: foreign\/loader\.tas/.test(out) && /unchanged on disk/.test(out), "assemble_source units: one answer per unit, the foreign file reported unchanged", out.slice(0, 600));
      const row = svc().listArtifacts().find((a) => a.path === join(proj, "foreign", "loader.tas"));
      check(row?.assembler === "64tass" && row.role === "foreign-source" && row.tags.includes("foreign"), "the foreign source is registered with its dialect", JSON.stringify(row && { a: row.assembler, r: row.role, t: row.tags }));
      check(sha(join(proj, "foreign", "loader.tas")) === before, "…and is still byte-for-byte what it was");
      const missing = await call("assemble_source", { units: [{ path: "main.asm" }] });
      check(/refused/.test(missing) && /load_file/.test(missing), "a unit that uses a label no unit defines is refused by name through the door", missing.slice(0, 300));
    } finally { mcp.stop(); }
  }
}

// ───────────────────────────────────────────────────────────── S7: a project rendered before
head("S7. a project rendered before this opens and reads as before");
{
  const proj = scratch("s7");
  new ProjectKnowledgeService(proj).initProject({ name: "rendered before" });
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const prgPath = join(proj, "artifacts", "prg", "old.prg");
  writeFileSync(prgPath, PRG);
  // both files, as the renderer used to write them
  const cli = (...a) => spawnSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), ...a, "--no-register"], { cwd: proj, encoding: "utf8" });
  const asm = join(proj, "artifacts", "prg", "old_disasm.asm");
  const tas = join(proj, "artifacts", "prg", "old_disasm.tas");
  check(cli("disasm-prg", prgPath, asm, "C000", "--no-analysis", "--dialect", "kickass").status === 0 && cli("disasm-prg", prgPath, tas, "C000", "--no-analysis", "--dialect", "64tass").status === 0, "the pre-914 state exists: both dialects on disk, no preference");
  const svc = new ProjectKnowledgeService(proj);
  const prgRow = svc.saveArtifact({ kind: "prg", scope: "input", title: "old.prg", path: prgPath, role: "disasm-target" });
  svc.saveArtifact({ kind: "listing", scope: "analysis", title: "old_disasm.asm", path: asm, role: "disasm", format: "asm", sourceArtifactIds: [prgRow.id] });
  svc.saveArtifact({ kind: "generated-source", scope: "generated", title: "old_disasm.tas", path: tas, role: "disasm-tass", format: "tass", sourceArtifactIds: [prgRow.id] });
  // an old stamp in the KickAssembler listing, as the old proof left it
  writeFileSync(asm, readFileSync(asm, "utf8").replace(/^(\/\/\*{28}\n)([\s\S]*?)(\/\/\*{28})/m, `$1$2// rebuild verified byte-identical against old.prg (20 bytes) with KickAssembler\n$3`));
  const hashes = [sha(asm), sha(tas)];
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1" } });
  try {
    await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-914", version: "1" } });
    mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const onboard = await mcp.call("agent_onboard", {});
    check(/# Agent Onboarding/.test(onboard) && /ASK THE HUMAN FIRST/.test(onboard), "it opens, and is asked for its dialect");
    const found = listingFor(proj, { path: prgPath }, new ProjectKnowledgeService(proj).listArtifacts());
    check(found?.path === asm && found.dialect === "kickass", "listingFor reads the KickAssembler file when both are there and nothing is chosen (as before)", JSON.stringify(found && { p: found.path, d: found.dialect }));
    const status = new ProjectKnowledgeService(proj).getPerArtifactStatus().find((s) => s.relativePath.endsWith("old.prg"));
    const step = (n) => status?.steps.find((s) => s.name === n)?.status;
    check(step("disasm-pass-1") === "done" && step("rebuild-byte-identical") === "done", "the status reads the old stamp in the old listing, as before", JSON.stringify(status?.steps.map((s) => [s.name, s.status])));
    const search = await mcp.call("project_search", { query: "helper OR rts", kind: "asm_section" });
    check(!/tool error/.test(search), "project_search still reads the listings", search.slice(0, 200));
    check(sha(asm) === hashes[0] && sha(tas) === hashes[1], "nothing was rewritten: both listings are byte-for-byte what they were");
    // choosing 64tass afterwards moves the reading to the .tas without deleting the .asm
    await mcp.call("agent_onboard", { preferred_assembler: "64tass" });
    const after = listingFor(proj, { path: prgPath }, new ProjectKnowledgeService(proj).listArtifacts());
    check(after?.dialect === "64tass" && existsSync(asm), "choosing 64tass later reads the .tas, and the .asm is left alone", JSON.stringify(after && after.dialect));
  } finally { mcp.stop(); }
}

// the reporter's state (#138): a 64tass project whose stored task still waits for `_disasm.asm`
head("S7b. a task stored before the lookup (it names the .asm) closes on the .tas");
{
  const { proj, mcp, call, svc } = await openProject("s7b", "64tass");
  try {
    writeFileSync(join(proj, "r.prg"), PRG);
    await call("disasm_prg", { prg_path: "r.prg", no_analysis: true });
    svc().emitNextStepTask({
      producedByTool: "analyze_prg", artifactIds: ["r.prg"], title: "Run disasm on r.prg (stored by an older version)",
      autoCloseHint: { kind: "file-exists", path: join(proj, "r_disasm.asm") },
    });
    await call("agent_onboard", {});
    const task = svc().listTasks().find((t) => /stored by an older version/.test(t.title));
    check(!existsSync(join(proj, "r_disasm.asm")) && task?.status === "done", "a `file-exists` hint on `_disasm.asm` is satisfied by the stem's .tas", JSON.stringify(task && { status: task.status }));
  } finally { mcp.stop(); }
}

for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  e2e-914: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
