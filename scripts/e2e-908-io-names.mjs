#!/usr/bin/env node
// Spec 908 — I/O registers have names in every listing, also when the image covers $D000-$DFFF.
//
// Hermetic: temp projects, one synthetic PRG assembled from a listing here (scripts/lib/908-prgs.mjs,
// asm6502-mini.mjs) that spans $0801-$EFFF, synthetic .crt images, MCP over stdio. No ROMs, no game
// bytes, no media, no runtime, no :4312. The rebuild halves need KickAssembler (and 64tass for the
// second dialect) and SKIP LOUDLY without them — every assertion on the listing text runs either way.
//
//   S1  every register has a name: graph_find, a mirror, both readers of the store agree
//   S2  an image over $D000-$DFFF names its operands; the equate block is exactly the names used
//   S3  a human label at an I/O address wins
//   S4  the project says the window is RAM here (memoryMap), for one routine's code only
//   S5  the cartridge window follows the cartridge type
//   D3  memoryMap through write_annotations / merge_annotations / the loader
//
//   npm run e2e:908

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMcp } from "./lib/mcp-stdio.mjs";
import { ioWindowPrg } from "./lib/908-prgs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
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

console.log("Spec 908 — I/O registers have names in every listing\n");

const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const haveKick = existsSync(jar) || spawnSync("sh", ["-c", "command -v kickass"], { stdio: "ignore" }).status === 0;
const have64tass = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;

const projects = [];
async function openProject(name, env = {}) {
  const proj = mkdtempSync(join(tmpdir(), `c64re-908-${name}-`));
  projects.push(proj);
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0", C64RE_FULL_TOOLS: "1", ...env } });
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-908", version: "1" } });
  mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await mcp.call("project_init", { name });
  await mcp.call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  return { proj, mcp, call: mcp.call };
}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const { prg, labels } = ioWindowPrg();
const ENTRIES = [hex4(labels.main), hex4(labels.dep)];
const REL = "artifacts/prg/t908.prg";

/** the I/O equate block of a listing: name -> address */
function ioEquates(asm) {
  const lines = asm.split("\n");
  const at = lines.findIndex((l) => /^\/\/ I\/O registers this listing names/.test(l));
  const out = new Map();
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length && lines[i].trim() !== ""; i += 1) {
    const m = /^\s+\.label (\w+) = \$([0-9A-F]{4})/.exec(lines[i]);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}
/** the text of one routine's lines in a listing: from its label to the next label that is not a data/xref label */
const linesFrom = (asm, startLabel, count) => {
  const l = asm.split("\n");
  const at = l.findIndex((x) => x.startsWith(`${startLabel}:`));
  return at < 0 ? [] : l.slice(at + 1, at + 1 + count);
};

// ───────────────────────────────────────────────────────────── S1: the names exist
head("S1. every I/O register has a name");
{
  const { mcp, call } = await openProject("s1");
  try {
    const find = async (q) => call("graph_find", { query: q });
    const cases = [["$D011", "vic_ctrl1"], ["$D020", "vic_border"], ["$D418", "sid_volume"], ["$DC0D", "cia1_icr"], ["$DD00", "cia2_pra"]];
    for (const [addr, name] of cases) {
      const out = await find(addr);
      const line = out.split("\n").find((l) => l.startsWith("[io]")) ?? "";
      check(new RegExp(`^\\[io\\] \\${addr} ${name} \\| id=c64:io:`).test(line) && /\|\s*\S[^|]*$/.test(line), `S1 ${addr} reads ${name}, with its description`, line);
    }
    const mirror = (await find("$D051")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(/^\[io\] \$D051 vic_ctrl1 \|/.test(mirror) && /mirror of vic_ctrl1 \(\+\$40\)/.test(mirror), "S1 the mirror $D051 is vic_ctrl1, and says it is a mirror", mirror);
    const sidMirror = (await find("$D420")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(/sid_v1_freq_lo/.test(sidMirror) && /mirror/.test(sidMirror), "S1 a SID mirror ($D420 = $D400 + 32) is named as its register", sidMirror);
    const cia = (await find("$DC1D")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(/cia1_icr/.test(cia) && /mirror/.test(cia), "S1 a CIA mirror ($DC1D = $DC0D + 16) is named as its register", cia);
    const colour = (await find("$D828")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(/color_ram/.test(colour), "S1 colour RAM is color_ram (a cell reads as base + offset)", colour);
    const unused = (await find("$D02F")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(!/vic_/.test(unused), "S1 an address the chip has no register at ($D02F) is not given a register name", unused);
    const byAlias = (await find("SCROY")).split("\n").find((l) => l.startsWith("[io]")) ?? "";
    check(/vic_ctrl1/.test(byAlias), "S1 the book's label (SCROY) still finds the register by search", byAlias);
  } finally { mcp.stop(); }

  // the store itself: one rule, held by both readers
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(ROOT, "resources", "platform-kb.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT address, io_name FROM platform_node WHERE platform = 'c64' AND io_name IS NOT NULL ORDER BY address").all();
  const names = rows.map((r) => r.io_name);
  check(names.every((n) => n.length <= 20 && /^[a-z][a-z0-9_]*$/.test(n)), "S1 every name is a lower-case identifier of at most 20 characters", names.filter((n) => n.length > 20 || !/^[a-z][a-z0-9_]*$/.test(n)).join(", "));
  check(new Set(names).size === names.length, "S1 no two registers share a name");
  const covered = (lo, hi) => { for (let a = lo; a <= hi; a += 1) if (!rows.some((r) => r.address === a)) return false; return true; };
  check(covered(0xd000, 0xd02e) && covered(0xd400, 0xd41c) && covered(0xdc00, 0xdc0f) && covered(0xdd00, 0xdd0f) && rows.some((r) => r.address === 0xd800),
    "S1 every VIC-II ($D000-$D02E), SID ($D400-$D41C), CIA 1 and CIA 2 register and colour RAM has a name");
  db.close();
  const { PlatformKb } = await import(pathToFileURL(join(ROOT, "dist", "platform-kb", "read.js")).href);
  const kb = new PlatformKb();
  const cjs = require(join(ROOT, "dist", "pipeline", "lib", "platform-kb.cjs"));
  let disagree = "";
  for (let a = 0xd000; a <= 0xdfff && !disagree; a += 1) {
    const e = kb.ioRegister("c64", a);
    const c = cjs.platformIoRegister(a);
    if ((e?.name ?? null) !== (c?.name ?? null) || (e?.base ?? null) !== (c?.base ?? null) || (e?.offset ?? null) !== (c?.offset ?? null)) disagree = `$${hex4(a)}: ${JSON.stringify(e)} vs ${JSON.stringify(c)}`;
  }
  check(disagree === "", "S1 the MCP half and the pipeline half of the store answer alike for all of $D000-$DFFF", disagree);
  kb.close();
}

// ───────────────────────────────────────────────────────────── S2: the image covers the window
head("S2. an image over $D000-$DFFF names its I/O operands");
const USED = ["cia1_icr", "cia2_pra", "color_ram", "sid_v1_freq_lo", "sid_volume", "vic_border", "vic_ctrl1", "vic_raster"];
{
  const { mcp, call, proj } = await openProject("s2");
  try {
    writeFileSync(join(proj, REL), prg);
    await call("analyze_prg", { prg_path: REL, entry_points: ENTRIES });
    const out = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    const asm = readFileSync(join(proj, "artifacts/prg/t908_disasm.asm"), "utf8");
    const tas = readFileSync(join(proj, "artifacts/prg/t908_disasm.tas"), "utf8");
    const mainLines = linesFrom(asm, "W080D", 12).join("\n");
    check(/lda\s+vic_ctrl1\b/.test(mainLines) && /sta\s+vic_border\b/.test(mainLines) && /sta\s+sid_volume\b/.test(mainLines) && /lda\s+cia1_icr\b/.test(mainLines),
      "S2 lda $D011 / sta $D020 / sta $D418 / lda $DC0D read vic_ctrl1, vic_border, sid_volume, cia1_icr", mainLines);
    check(/sta\s+cia2_pra\b/.test(mainLines) && /lda\s+vic_ctrl1\+\$40/.test(mainLines), "S2 …sta $DD00 reads cia2_pra and the mirror $D051 reads vic_ctrl1+$40", mainLines);
    check(/sta\s+color_ram\+\$28/.test(mainLines) && /sta\s+color_ram,x/.test(mainLines), "S2 …colour RAM reads color_ram+$28, and indexed color_ram,x", mainLines);
    check(/sta\s+\$D030\b/.test(mainLines), "S2 an address the chip has no register at ($D030) stays an address", mainLines);
    check(/sta\s+sid_v1_freq_lo,x/.test(asm) && /sta\s+vic_raster\b/.test(asm), "S2 the depacker's and its helper's stores read as registers when nothing says otherwise", asm.split("\n").filter((l) => /sid_v1|vic_raster/.test(l)).join("\n"));
    const eq = ioEquates(asm);
    check([...eq.keys()].sort().join() === USED.join() && eq.get("vic_ctrl1") === "D011" && eq.get("color_ram") === "D800" && eq.get("cia2_pra") === "DD00",
      "S2 the equate block defines exactly the names used, at their register addresses", `${[...eq.entries()].map(([k, v]) => `${k}=$${v}`).join(" ")}`);
    check(/^WD011:/m.test(asm) && /^WD020:/m.test(asm) && /^WDC0D:/m.test(asm), "S2 data labels under $D000 are still placed (the bytes at the register addresses keep their label lines)", asm.split("\n").filter((l) => /^WD[0-9A-F]{3}:/.test(l)).slice(0, 4).join("\n"));
    check(/sta\s+sid_volume\b/.test(tas) && /lda\s+vic_ctrl1\+\$40/.test(tas) && /(sid_volume|vic_ctrl1)\s*=\s*\$D/.test(tas), "S2 the 64tass listing carries the same names and defines them", tas.split("\n").filter((l) => /sid_volume|vic_ctrl1/.test(l)).slice(0, 4).join("\n"));
    if (haveKick) check(/rebuild verified byte-identical/.test(out), "S2 the KickAssembler rebuild is byte-identical", out.split("\n").filter((l) => /rebuild/.test(l)).join("\n"));
    else skip(`S2 KickAssembler rebuild: not found at ${jar} (set C64RE_KICKASS_JAR) — skipped, not passed`);
    if (have64tass) {
      const bin = join(proj, "tass-out.bin");
      const r = spawnSync("64tass", ["-C", "--nostart", "-o", bin, join(proj, "artifacts/prg/t908_disasm.tas")], { encoding: "utf8" });
      const built = existsSync(bin) ? readFileSync(bin) : Buffer.alloc(0);
      check(r.status === 0 && Buffer.compare(built, prg.subarray(2)) === 0, "S2 the 64tass listing assembles to the same bytes", `${r.status} ${r.stderr?.slice(0, 300)}`);
    } else skip("S2 64tass rebuild: 64tass not on PATH — skipped, not passed");

    // the same program without an analysis: the linear renderer names them too
    const lin = await openProject("s2-lin");
    try {
      writeFileSync(join(lin.proj, REL), prg);
      const lout = await lin.call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
      const lasm = readFileSync(join(lin.proj, "artifacts/prg/t908_disasm.asm"), "utf8");
      check(/lda\s+vic_ctrl1\b/.test(lasm) && /sta\s+vic_border\b/.test(lasm) && ioEquates(lasm).get("vic_border") === "D020", "S2 without an analysis the linear listing names its operands and defines them too", lasm.split("\n").filter((l) => /vic_/.test(l)).slice(0, 4).join("\n"));
      if (haveKick) check(/rebuild verified byte-identical/.test(lout), "S2 …and rebuilds byte-identical", lout.split("\n").filter((l) => /rebuild/.test(l)).join("\n"));
    } finally { lin.mcp.stop(); }

    // a project whose name limit is shorter than a register name: the name is refused out loud, the address stays
    const shortProj = await openProject("s2-short");
    try {
      const pj = join(shortProj.proj, "knowledge", "project.json");
      const meta = JSON.parse(readFileSync(pj, "utf8"));
      meta.naming = { ...(meta.naming ?? {}), maxLabelLength: 12 };
      writeFileSync(pj, JSON.stringify(meta, null, 2));
      writeFileSync(join(shortProj.proj, REL), prg);
      await shortProj.call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
      const sasm = readFileSync(join(shortProj.proj, "artifacts/prg/t908_disasm.asm"), "utf8");
      check(/sta\s+\$D400,x/.test(sasm) && !/sid_v1_freq_lo/.test(sasm.split("\n").filter((l) => !l.startsWith("//")).join("\n")) && /sid_v1_freq_lo.*over this project's limit of 12/.test(sasm) && /lda\s+vic_ctrl1\b/.test(sasm),
        "S2 a name past the project's length limit is refused in the listing (said so), the shorter ones are still used", sasm.split("\n").filter((l) => /sid_v1|limit/.test(l)).join("\n"));
    } finally { shortProj.mcp.stop(); }
  } finally { mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── S3: a human label wins
head("S3. a human label at an I/O address wins");
{
  const { mcp, call, proj } = await openProject("s3");
  try {
    writeFileSync(join(proj, REL), prg);
    await call("write_annotations", { prg_path: REL, labels: [{ address: "D011", label: "scroll_ctl" }], segments: [{ start: "D200", end: "D23F", kind: "sprite", label: "spr_frame" }] });
    await call("analyze_prg", { prg_path: REL, entry_points: ENTRIES });
    const out = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    const asm = readFileSync(join(proj, "artifacts/prg/t908_disasm.asm"), "utf8");
    const code = asm.split("\n").filter((l) => !l.startsWith("//")).join("\n");
    check(/lda\s+scroll_ctl\b/.test(code) && /sta\s+scroll_ctl\b/.test(code), "S3 operands to $D011 read scroll_ctl", asm.split("\n").filter((l) => /scroll_ctl/.test(l)).join("\n"));
    check(!/vic_ctrl1/.test(code) && !ioEquates(asm).has("vic_ctrl1"), "S3 vic_ctrl1 is not emitted — not as an operand, not as an equate");
    check(/lda\s+scroll_ctl\+\$40/.test(code), "S3 the mirror $D051 of a labelled register reads label+$40");
    check(/sta\s+vic_border\b/.test(code), "S3 the registers nobody labelled keep their platform name");
    check(/^spr_frame:/m.test(asm) && /^scroll_ctl:/m.test(asm), "S3 the labels under $D000 are still placed as labels", asm.split("\n").filter((l) => /^(spr_frame|scroll_ctl):/.test(l)).join("\n"));
    if (haveKick) check(/rebuild verified byte-identical/.test(out), "S3 the rebuild is byte-identical", out.split("\n").filter((l) => /rebuild/.test(l)).join("\n"));
    if (have64tass) {
      const bin = join(proj, "tass-out.bin");
      const r = spawnSync("64tass", ["-C", "--nostart", "-o", bin, join(proj, "artifacts/prg/t908_disasm.tas")], { encoding: "utf8" });
      check(r.status === 0 && Buffer.compare(existsSync(bin) ? readFileSync(bin) : Buffer.alloc(0), prg.subarray(2)) === 0, "S3 …and so is the 64tass listing", `${r.status} ${r.stderr?.slice(0, 300)}`);
    }
  } finally { mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── S4: the window is RAM here
head("S4. the project says the window is RAM for one routine");
{
  const { mcp, call, proj } = await openProject("s4");
  try {
    writeFileSync(join(proj, REL), prg);
    const dep = hex4(labels.dep);
    const w = await call("write_annotations", { prg_path: REL, routines: [{ address: dep, name: "depacker" }], memoryMap: [{ start: "d000", end: "$DFFF", as: "ram", routines: [dep] }] });
    check(/1 memoryMap range/.test(w), "S4 write_annotations takes memoryMap", w.split("\n")[0]);
    const written = JSON.parse(readFileSync(join(proj, "artifacts/prg/t908_annotations.json"), "utf8"));
    check(JSON.stringify(written.memoryMap) === JSON.stringify([{ start: "D000", end: "DFFF", as: "ram", routines: [dep] }]), "S4 …in one spelling", JSON.stringify(written.memoryMap));
    await call("analyze_prg", { prg_path: REL, entry_points: ENTRIES });
    const out = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    const asm = readFileSync(join(proj, "artifacts/prg/t908_disasm.asm"), "utf8");
    const depLines = linesFrom(asm, "depacker", 6).join("\n");
    check(/sta\s+WD011\b/.test(depLines) && /sta\s+WD400,x/.test(depLines), "S4 the depacker's stores render as data labels, not registers", depLines);
    check(!/\/\/ (SCROY|FRELO1)/.test(depLines), "S4 …and carry no register comment", depLines);
    check(/sta\s+vic_raster\b/.test(asm), "S4 a routine the depacker CALLS is its own routine: its store to $D012 is still a register");
    const mainLines = linesFrom(asm, "W080D", 12).join("\n");
    check(/lda\s+vic_ctrl1\b/.test(mainLines) && /sta\s+sid_volume\b/.test(mainLines), "S4 the rest of the code keeps its register names", mainLines);
    check(ioEquates(asm).has("vic_ctrl1") && !ioEquates(asm).has("sid_v1_freq_lo"), "S4 the equate block holds only the names still used (sid_v1_freq_lo is gone with its only user)", [...ioEquates(asm).keys()].join(" "));
    if (haveKick) check(/rebuild verified byte-identical/.test(out), "S4 the rebuild is byte-identical", out.split("\n").filter((l) => /rebuild/.test(l)).join("\n"));

    // no routines: the declaration holds for the whole listing
    await call("write_annotations", { prg_path: REL, overwrite: true, memoryMap: [{ start: "D000", end: "DFFF", as: "ram" }] });
    await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    const all = readFileSync(join(proj, "artifacts/prg/t908_disasm.asm"), "utf8");
    check(!/\b(vic_|sid_|cia[12]_|color_ram)/.test(all.split("\n").filter((l) => !l.startsWith("//")).join("\n")) && !all.includes("// I/O registers this listing names"),
      "S4 a range without routines holds everywhere: no register is named, and no block is written");

    // precedence: a human label beats the declaration
    await call("write_annotations", { prg_path: REL, overwrite: true, routines: [{ address: dep, name: "depacker" }], labels: [{ address: "D011", label: "scroll_ctl" }], memoryMap: [{ start: "D000", end: "DFFF", as: "ram", routines: [dep] }] });
    await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    const both = readFileSync(join(proj, "artifacts/prg/t908_disasm.asm"), "utf8");
    check(/sta\s+scroll_ctl\b/.test(linesFrom(both, "depacker", 4).join("\n")), "S4 human label > declared RAM: the depacker's store to a labelled $D011 reads the label", linesFrom(both, "depacker", 4).join("\n"));

    // a hand-written file with a memoryMap the loader cannot take: skipped and said, the rest applies
    const file = join(proj, "artifacts/prg/t908_annotations.json");
    writeFileSync(file, JSON.stringify({ version: 1, binary: "t908.prg", segments: [], labels: [], routines: [], memoryMap: [{ start: "C000", end: "C0FF", as: "ram" }, { start: "D000", end: "D0FF", as: "rom" }, { start: "D000", end: "DFFF", as: "ram", routines: [dep] }] }));
    const loud = await call("disasm_prg", { prg_path: REL, entry_points: ENTRIES });
    check(/skipped 2/.test(loud) && /memoryMap\[0\].*not a range inside \$D000-\$DFFF/.test(loud) && /memoryMap\[1\].*as="rom"/.test(loud), "S4 the loader skips a memoryMap entry outside the window or with an unknown `as`, and says which", loud.split("\n").filter((l) => /annotations\]|memoryMap/.test(l)).join("\n"));
  } finally { mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── S5: the cartridge window
head("S5. $DE00-$DFFF follow the cartridge type");
{
  // one 8 KiB bank at $8000: lda #$01 / sta $DE00 / sta $DE02 / sta $DF00 / lda #$80 / sta $DE00 / rts
  const BANK = Buffer.alloc(0x2000, 0xea);
  Buffer.from([0xa9, 0x01, 0x8d, 0x00, 0xde, 0x8d, 0x02, 0xde, 0x8d, 0x00, 0xdf, 0xa9, 0x80, 0x8d, 0x00, 0xde, 0x8d, 0x06, 0xde, 0x60]).copy(BANK, 0);
  const crtImage = (hardwareType, name) => {
    const header = Buffer.alloc(0x40, 0);
    header.write("C64 CARTRIDGE   ", 0, "latin1");
    header.writeUInt32BE(0x40, 0x10);
    header.writeUInt16BE(0x0100, 0x14);
    header.writeUInt16BE(hardwareType, 0x16);
    header.writeUInt8(0, 0x18);
    header.writeUInt8(1, 0x19);
    header.write(name, 0x20, "latin1");
    const chip = Buffer.alloc(0x10, 0);
    chip.write("CHIP", 0, "latin1");
    chip.writeUInt32BE(0x10 + BANK.length, 4);
    chip.writeUInt16BE(0, 8);
    chip.writeUInt16BE(0, 10);
    chip.writeUInt16BE(0x8000, 12);
    chip.writeUInt16BE(BANK.length, 14);
    return Buffer.concat([header, chip, BANK]);
  };
  const listingOf = (out) => {
    const p = /^Output: (.+)$/m.exec(out)?.[1];
    return p && existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const code = (asm) => asm.split("\n").filter((l) => !l.startsWith("//")).join("\n");
  const { mcp, call, proj } = await openProject("s5");
  try {
    mkdirSync(join(proj, "artifacts"), { recursive: true });
    const bank = async (hw, name) => {
      writeFileSync(join(proj, "artifacts", `${name}.crt`), crtImage(hw, name));
      await call("extract_crt", { crt_path: `artifacts/${name}.crt`, output_dir: `analysis/extracted_${name}` });
      const out = await call("disasm", { path: `analysis/extracted_${name}/chips/bank_00_8000.bin`, load_address: "8000", import_graph: false });
      return { out, asm: listingOf(out) };
    };
    const gm = await bank(60, "gmod2");
    check(/sta\s+gmod2_ctrl\b/.test(code(gm.asm)) && /sta\s+gmod2_ctrl\+\$02\b/.test(code(gm.asm)) && /sta\s+cart_io_df00\b/.test(code(gm.asm)), "S5 a GMod2 stores to gmod2_ctrl (the IO1 page is one register: +$02); IO2 is neutral", code(gm.asm).split("\n").filter((l) => /\$DE|gmod2|cart_io/.test(l)).join("\n"));
    check(ioEquates(gm.asm).get("gmod2_ctrl") === "DE00" && ioEquates(gm.asm).get("cart_io_df00") === "DF00", "S5 …and the equates define them", [...ioEquates(gm.asm).entries()].join(" "));
    if (have64tass) {
      const tas = gm.out.match(/^Output: (.+)\.asm$/m)?.[1];
      const bin = join(proj, "gm-out.bin");
      const r = spawnSync("64tass", ["-C", "--nostart", "-o", bin, `${tas}.tas`], { encoding: "utf8" });
      check(r.status === 0 && Buffer.compare(existsSync(bin) ? readFileSync(bin) : Buffer.alloc(0), BANK) === 0, "S5 the bank listing with its cartridge names assembles to the same bytes (64tass)", `${r.status} ${r.stderr?.slice(0, 300)}`);
    } else skip("S5 64tass rebuild: 64tass not on PATH — skipped, not passed");
    const ef = await bank(32, "easyflash");
    check(/sta\s+ef_bank\b/.test(code(ef.asm)) && /sta\s+ef_ctrl\b/.test(code(ef.asm)) && !/gmod2/.test(ef.asm), "S5 an EasyFlash stores to ef_bank / ef_ctrl", code(ef.asm).split("\n").filter((l) => /ef_|\$DE/.test(l)).join("\n"));
    const md = await bank(19, "magicdesk");
    check(/sta\s+magicdesk_bank\b/.test(code(md.asm)) && /sta\s+magicdesk_bank\+\$06\b/.test(code(md.asm)), "S5 a Magic Desk stores to magicdesk_bank", code(md.asm).split("\n").filter((l) => /magicdesk|\$DE/.test(l)).join("\n"));
    const mb = await bank(86, "megabyter");
    check(/sta\s+megabyter_bank\b/.test(code(mb.asm)) && /sta\s+megabyter_mode\b/.test(code(mb.asm)) && /sta\s+megabyter_mode\+\$04\b/.test(code(mb.asm)),
      "S5 a MegaByter splits on A1: $DE00 is the bank, $DE02 and $DE06 the mode register", code(mb.asm).split("\n").filter((l) => /megabyter|\$DE/.test(l)).join("\n"));
  } finally { mcp.stop(); }
  // no cartridge known: the neutral name, never a hardware claim
  const none = await openProject("s5-none");
  try {
    mkdirSync(join(none.proj, "artifacts"), { recursive: true });
    writeFileSync(join(none.proj, "artifacts/stray.bin"), BANK);
    const out = await none.call("disasm", { path: "artifacts/stray.bin", load_address: "8000", import_graph: false });
    const asm = listingOf(out);
    check(/sta\s+cart_io_de00\b/.test(code(asm)) && /sta\s+cart_io_de02\b/.test(code(asm)) && !/ef_bank|gmod2/.test(asm), "S5 an unknown cartridge type reads cart_io_de00 / cart_io_de02", code(asm).split("\n").filter((l) => /cart_io|\$DE/.test(l)).join("\n"));
    const off = await none.call("disasm", { path: "artifacts/stray.bin", load_address: "8000", import_graph: false, platform: "none" });
    check(!/cart_io_|vic_|ef_bank/.test(listingOf(off)), "S5 platform none names nothing, as before");
  } finally { none.mcp.stop(); }
}

// ───────────────────────────────────────────────────────────── D3: the doors
head("D3. memoryMap through write_annotations and merge_annotations");
{
  const { mcp, call, proj } = await openProject("d3");
  try {
    writeFileSync(join(proj, REL), prg);
    const dep = hex4(labels.dep);
    const refused = async (memoryMap) => call("write_annotations", { prg_path: REL, overwrite: true, memoryMap });
    const outside = await refused([{ start: "C000", end: "C0FF", as: "ram" }]);
    check(/REFUSED/.test(outside) && /memoryMap\[0\].*not inside \$D000-\$DFFF/.test(outside), "D3 a range outside $D000-$DFFF is refused, by index", outside.split("\n").slice(0, 5).join(" | "));
    const badAs = await refused([{ start: "D000", end: "DFFF", as: "rom" }]);
    check(/REFUSED/.test(badAs) && /as="rom"/.test(badAs), "D3 an unknown `as` is refused", badAs.split("\n").slice(0, 5).join(" | "));
    const twice = await refused([{ start: "D000", end: "DFFF", as: "ram" }, { start: "D000", end: "DFFF", as: "io" }]);
    check(/REFUSED/.test(twice) && /already declared as "ram" by memoryMap\[0\]/.test(twice), "D3 one range declared as two things is refused", twice.split("\n").slice(0, 5).join(" | "));
    const same = await refused([{ start: "D000", end: "DFFF", as: "ram", routines: ["C000"] }, { start: "D000", end: "DFFF", as: "ram", routines: ["C100"] }]);
    const sameDoc = JSON.parse(readFileSync(join(proj, "artifacts/prg/t908_annotations.json"), "utf8"));
    check(!/REFUSED/.test(same) && sameDoc.memoryMap.length === 1 && sameDoc.memoryMap[0].routines.join() === "C000,C100", "D3 the same range twice is one claim, its routines joined", JSON.stringify(sameDoc.memoryMap));

    // merge: agreement collapses, a disagreement is a contradiction named memoryMap:<range>
    const frag = (name, memoryMap) => ({ name, memoryMap });
    const agree = await call("merge_annotations", { prg_path: REL, overwrite: true, fragments: [frag("A", [{ start: "D000", end: "DFFF", as: "ram", routines: [dep] }]), frag("B", [{ start: "D000", end: "DFFF", as: "ram", routines: ["C100"] }])] });
    const agreeDoc = JSON.parse(readFileSync(join(proj, "artifacts/prg/t908_annotations.json"), "utf8"));
    check(!/REFUSED/.test(agree) && agreeDoc.memoryMap?.length === 1 && agreeDoc.memoryMap[0].routines.join() === `${dep},C100`, "D3 merge: two readings that agree on `as` are one claim, routines joined", agree.split("\n").slice(0, 4).join(" | "));
    const clash = await call("merge_annotations", { prg_path: REL, overwrite: true, fragments: [frag("A", [{ start: "D000", end: "DFFF", as: "ram" }]), frag("B", [{ start: "D000", end: "DFFF", as: "io" }])] });
    check(/REFUSED/.test(clash) && /memoryMap:D000-DFFF/.test(clash) && /A\s+\$D000-\$DFFF\s+ram/.test(clash) && /B\s+\$D000-\$DFFF\s+io/.test(clash), "D3 merge: conflicting `as` for one range is a contradiction, key memoryMap:D000-DFFF, both sides named", clash.split("\n").slice(0, 8).join(" | "));
    const resolved = await call("merge_annotations", {
      prg_path: REL, overwrite: true,
      fragments: [frag("A", [{ start: "D000", end: "DFFF", as: "ram" }]), frag("B", [{ start: "D000", end: "DFFF", as: "io" }])],
      resolutions: [{ key: "memoryMap:D000-DFFF", winner: "B", why: "the loader sets $01 to $35 before this code runs; A read the depacker's window" }],
    });
    const resolvedDoc = JSON.parse(readFileSync(join(proj, "artifacts/prg/t908_annotations.json"), "utf8"));
    check(!/REFUSED/.test(resolved) && resolvedDoc.memoryMap?.length === 1 && resolvedDoc.memoryMap[0].as === "io" && /Recorded 1 resolution/.test(resolved), "D3 merge: a resolution picks the winner and is recorded as a finding", resolved.split("\n").slice(0, 6).join(" | "));
    const deleted = await call("merge_annotations", {
      prg_path: REL, overwrite: true, dry_run: false,
      fragments: [frag("A", [{ start: "D000", end: "DFFF", as: "ram" }]), frag("B", [{ start: "D000", end: "DFFF", as: "io" }])],
      resolutions: [{ key: "memoryMap:$D000-$DFFF", delete: true, why: "neither reading is certain; the project leaves the default" }],
    });
    const deletedDoc = JSON.parse(readFileSync(join(proj, "artifacts/prg/t908_annotations.json"), "utf8"));
    check(!/REFUSED/.test(deleted) && deletedDoc.memoryMap === undefined, "D3 merge: delete removes the range (key spelling `memoryMap:$D000-$DFFF` is read)", deleted.split("\n").slice(0, 4).join(" | "));
  } finally { mcp.stop(); }
}

for (const p of projects) rmSync(p, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
