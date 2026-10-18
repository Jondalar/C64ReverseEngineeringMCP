#!/usr/bin/env node
// A cartridge bank listed on its own: where the names go, how the address is read, what $DE00 is called.
//
// Three things a real GMod2 bank (CRT hardware type 60, bank 0 at $8000) got wrong, one gate for each:
//
//   A  `disasm` with space "crt" + bank filed every graph node under the RAM space, so a
//      `model_assert` boundary in the crt space held nothing. Now the names go where the call says,
//      a bank alone means the cartridge, a space the graph does not have is refused, and a re-import
//      with another space moves the nodes.
//   B  `load_address: "8000"` — one address rule: a string is hex ("8000", "$8000", "0x8000" are $8000),
//      a JSON number is taken as given (32768 is $8000; 8000 is $1F40, as the tool text says), and a
//      relocated listing reads the string the same way.
//   C  a store to $DE00 was commented "EF_BANK EasyFlash bank register" on every cartridge. The comment now
//      follows the cartridge type recorded for the bytes (the .crt header's hardware type, through the
//      artifact lineage / the extraction directory / the project's only cartridge), and where no type is
//      known it is the neutral "cartridge I/O $DE00".
//
// Hermetic: temp projects, synthetic .crt images and one 8 KiB bank of synthetic code, MCP over stdio.
// No ROMs, no runtime, no :4312, no KickAssembler needed (the rebuild line is not asserted).
//
//   npm run e2e:cartridge-bank

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startMcp } from "./lib/mcp-stdio.mjs";

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

console.log("A cartridge bank listed on its own — space/bank, load_address, $DE00\n");

// ── the bytes: one 8 KiB bank at $8000 whose first instructions touch the cartridge window
//   8000  lda #$01 / sta $DE00 / sta $DE02 / sta $DF00 / lda #$80 / sta $DE00 / rts
const BANK = Buffer.alloc(0x2000, 0xea);
Buffer.from([0xa9, 0x01, 0x8d, 0x00, 0xde, 0x8d, 0x02, 0xde, 0x8d, 0x00, 0xdf, 0xa9, 0x80, 0x8d, 0x00, 0xde, 0x60]).copy(BANK, 0);

/** A .crt image: the 64-byte header, then one CHIP packet (bank 0 at $8000). */
function crtImage(hardwareType, name) {
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
}

const projects = [];
async function openProject(name) {
  const proj = mkdtempSync(join(tmpdir(), `c64re-cartbank-${name}-`));
  projects.push(proj);
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0" } });
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-cartbank", version: "1" } });
  mcp.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await mcp.call("project_init", { preferred_assembler: "kickass", name });
  await mcp.call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts"), { recursive: true });
  return { proj, mcp, call: mcp.call };
}
const listingOf = (out) => {
  const p = /^Output: (.+)$/m.exec(out)?.[1];
  return p && existsSync(p) ? readFileSync(p, "utf8") : "";
};
// the instruction lines that match: since Spec 908 an operand in the window reads as the cartridge's register NAME (the
// address is in the equate), so the comment is found on the line that names the register
const commentsFor = (asm, re) => asm.split("\n").filter((l) => /^ {6}[a-z]{3}\s/.test(l) && re.test(l)).join("\n");

let main;
try {
  main = await openProject("main");
  const { proj, call } = main;
  const put = (name) => { writeFileSync(join(proj, "artifacts", name), BANK); return `artifacts/${name}`; };

  // ═══ A. the space and the bank ═════════════════════════════════════════════════
  head("A. disasm files the names under the space and bank it was given");
  const gm = put("gm_bank.bin");
  const plain = put("plain_bank.bin");
  // Spec 909: a bank lives inside a cartridge. These loose bank files are banks of the ONE cartridge this project
  // holds, so it is registered first (extract_crt) and the names are filed under it — the answer says so.
  mkdirSync(join(proj, "media"), { recursive: true });
  writeFileSync(join(proj, "media", "van-helsing.crt"), crtImage(60, "VAN HELSING"));
  await call("extract_crt", { project_dir: proj, crt_path: "media/van-helsing.crt" });
  await call("write_annotations", { prg_path: gm, routines: [{ address: "8000", name: "bank_entry" }], labels: [{ address: "8011", label: "bank_tail" }] });
  await call("write_annotations", { prg_path: plain, routines: [{ address: "8300", name: "plain_entry" }] });
  // what the registered cartridge's own extract already put in the graph (member kinds only) — the model counts it too
  const memberNodes = () => { const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"), { readOnly: true }); try { return Number(db.prepare("SELECT COUNT(DISTINCT id) AS n FROM nodes WHERE kind IN ('routine','segment','payload','data_block','entry')").get().n); } finally { db.close(); } };
  const baseNodes = memberNodes();
  const a1 = await call("disasm", { path: gm, load_address: "8000", space: "crt", bank: 0 });
  check(/Graph: imported 1 routines/.test(a1), "A1 the listing is imported with space crt, bank 0", a1.split("\n").filter((l) => /Graph|refus/i.test(l)).join(" | "));
  const a2 = await call("disasm", { path: plain, load_address: "8000" });
  check(/Graph: imported 1 routines/.test(a2), "A2 CONTROL: a second bank listed with no space is imported too", a2.split("\n").filter((l) => /Graph|refus/i.test(l)).join(" | "));
  const crtBoundary = await call("model_assert", {
    name: "Van Helsing cartridge loader", level: "container", address_start: 0x8000, address_end: 0x9fff,
    space: "crt", bank: 0, description: "the bank 0 loader of the cartridge", evidence: ["gm_bank.bin listing"],
  });
  check(/\[crt\/van-helsing\]/.test(crtBoundary) && /contains: 1 routine/.test(crtBoundary), "A3 a crt-space boundary at bank 0 holds the routine (and names the cartridge it is in)", crtBoundary);
  check(new RegExp(`1/${baseNodes + 2} nodes placed, ${baseNodes + 1} orphaned`).test(crtBoundary), "A4 …and only that one: the bank listed with no space is not in it (it is RAM)", crtBoundary.split("\n").slice(-2).join(" | "));
  const bankOnly = put("bank_only.bin");
  await call("write_annotations", { prg_path: bankOnly, routines: [{ address: "8100", name: "bank_only_entry" }] });
  const a5 = await call("disasm", { path: bankOnly, load_address: "8000", bank: 0 });
  const crtAgain = await call("model_assert", {
    name: "Second look", level: "component", address_start: 0x8000, address_end: 0x9fff,
    space: "crt", bank: 0, description: "the same bank again, as a component", evidence: ["bank_only.bin listing"],
  });
  check(/Graph: imported 1 routines/.test(a5) && /contains: 2 routines?/.test(crtAgain), "A5 a bank alone means the cartridge: its routine joined the crt boundary", crtAgain.split("\n").slice(0, 2).join(" | "));
  const noBank = await call("disasm", { path: plain, load_address: "8000", space: "crt" });
  check(/refused/.test(noBank) && /pass bank/.test(noBank), "A6 space crt without a bank is refused, naming bank", noBank.split("\n").slice(0, 4).join(" | "));
  const wrongSpace = await call("disasm", { path: plain, load_address: "8000", space: "roml", bank: 0 });
  check(/refused/.test(wrongSpace) && /ram, crt/.test(wrongSpace), "A7 a space the graph does not have is refused, listing the ones it has", wrongSpace.split("\n").slice(0, 4).join(" | "));
  const bankRam = await call("disasm", { path: plain, load_address: "8000", space: "ram", bank: 3 });
  check(/refused/.test(bankRam), "A8 a bank beside space ram is refused", bankRam.split("\n").slice(0, 4).join(" | "));
  // moving it: the same file, listed again with the cartridge space, leaves RAM and joins the bank
  const moved = await call("disasm", { path: plain, load_address: "8000", space: "crt", bank: 0 });
  const crtThird = await call("model_assert", {
    name: "Third look", level: "component", address_start: 0x8000, address_end: 0x9fff,
    space: "crt", bank: 0, description: "the bank once more, after moving the plain one", evidence: ["plain_bank.bin listing"],
  });
  check(/Graph: imported/.test(moved) && /contains: 3 routines?/.test(crtThird), "A9 listed again with another space, the names move there", crtThird.split("\n").slice(0, 2).join(" | "));

  // ═══ B. the load address ═══════════════════════════════════════════════════════
  head("B. load_address is read by the one address rule — with relocations too");
  const reloc = [{ fileStart: "8010", fileEnd: "803F", runtimeAddr: "C000" }];
  for (const [label, value] of [["\"8000\"", "8000"], ["\"$8000\"", "$8000"], ["\"0x8000\"", "0x8000"], ["the JSON number 32768", 32768]]) {
    const plainRead = await call("disasm", { path: plain, load_address: value, import_graph: false });
    const relocRead = await call("disasm", { path: plain, load_address: value, relocations: reloc, import_graph: false });
    check(/load_address \$8000 given/.test(plainRead) && /running \$8000-\$9FFF/.test(plainRead), `B1 ${label} reads $8000 (no relocations)`, plainRead.split("\n")[0]);
    check(/load_address \$8000 given/.test(relocRead) && !/refused/.test(relocRead) && /relocation rendering/.test(relocRead), `B2 ${label} reads $8000 with relocations, and renders them`, relocRead.split("\n").slice(0, 3).join(" | "));
  }
  const numeric = await call("disasm", { path: plain, load_address: 8000, relocations: reloc, import_graph: false });
  check(/\$1F40/.test(numeric) && /refused/.test(numeric), "B3 the JSON number 8000 is taken as given ($1F40) — and the relocation outside it is refused by name", numeric.split("\n").slice(0, 5).join(" | "));

  // ═══ C. what $DE00 is called ═══════════════════════════════════════════════════
  head("C. the comment on $DE00 follows the cartridge the bytes belong to");
  const extract = async (hw, name) => {
    const crtRel = `artifacts/${name}.crt`;
    writeFileSync(join(proj, crtRel), crtImage(hw, name));
    const out = await call("extract_crt", { crt_path: crtRel, output_dir: `analysis/extracted_${name}` });
    return { out, chip: `analysis/extracted_${name}/chips/bank_00_8000.bin` };
  };
  const gmod2 = await extract(60, "gmod2");
  check(existsSync(join(proj, gmod2.chip)), "C0 extract_crt wrote the GMod2 bank (hardware type 60)", gmod2.out.split("\n").slice(0, 3).join(" | "));
  const c1 = await call("disasm", { path: gmod2.chip, load_address: "8000", import_graph: false });
  const asm1 = listingOf(c1);
  const de00 = commentsFor(asm1, /\sgmod2_ctrl\s/);
  check(/GMod2 control register/.test(de00) && !/EasyFlash|EF_BANK/.test(asm1), "C1 a store to $DE00 in a GMod2 bank reads as the GMod2 control register", de00);
  check(/EEPROM DI/.test(de00) && /EEPROM CLK/.test(de00) && /EEPROM CS/.test(de00) && /bit 7 = EEPROM DO/.test(de00), "C2 …naming the bank bits, the EEPROM CS/CLK/DI and DO on bit 7 of a read", de00);
  check(/Cartridge: GMod2 \(CRT hardware type 60, from /.test(c1), "C3 the answer says which cartridge it took and why", c1.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  check(/GMod2 control register/.test(commentsFor(asm1, /gmod2_ctrl\+\$02/)),
    "C4 the IO1 page is one register on a GMod2: $DE02 is it too (gmod2_ctrl+$02)", commentsFor(asm1, /gmod2_ctrl\+\$02/));
  check(!/GMod2|EasyFlash|EF_/.test(commentsFor(asm1, /cart_io_df00/)) && commentsFor(asm1, /cart_io_df00/) !== "", "C4b …and IO2 ($DF00) is not claimed for it", commentsFor(asm1, /cart_io_df00/));

  const ef = await extract(32, "easyflash");
  const c5 = await call("disasm", { path: ef.chip, load_address: "8000", import_graph: false });
  const asm5 = listingOf(c5);
  check(/EF_BANK EasyFlash bank register/.test(asm5) && /EF_CTRL/.test(asm5), "C5 an EasyFlash bank still reads EF_BANK / EF_CTRL", commentsFor(asm5, /\sef_(bank|ctrl)\s/));

  const md = await extract(19, "magicdesk");
  const c6 = await call("disasm", { path: md.chip, load_address: "8000", import_graph: false });
  const asm6 = listingOf(c6);
  check(/Magic Desk bank register/.test(asm6) && !/EasyFlash|EF_/.test(asm6), "C6 a Magic Desk bank reads as the Magic Desk register", commentsFor(asm6, /magicdesk_bank/));

  const loose = put("loose_bank.bin");
  const c7 = await call("disasm", { path: loose, load_address: "8000", import_graph: false });
  const asm7 = listingOf(c7);
  check(/cartridge I\/O \$DE00/.test(asm7) && /cartridge I\/O \$DE02/.test(asm7) && !/EasyFlash|EF_|GMod2|Magic Desk/.test(asm7),
    "C7 bytes of no known cartridge (three types in the project, none theirs) get the neutral \"cartridge I/O $DE00\"", commentsFor(asm7, /cart_io_de0/));
  check(!/Cartridge:/.test(c7), "C8 …and the answer claims no cartridge", c7.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  // the sibling chip of the GMod2, after the others exist: lineage still decides, not the project's mix
  const c9 = await call("disasm", { path: gmod2.chip, load_address: "8000", import_graph: false });
  check(/GMod2 control register/.test(listingOf(c9)), "C9 with three cartridges in the project, the GMod2's own bank is still read as a GMod2 (lineage, not majority)", c9.split("\n").filter((l) => /Cartridge|refus|Output/.test(l)).join(" | ") + commentsFor(listingOf(c9), /gmod2_ctrl/));
  const noPlatform = await call("disasm", { path: gmod2.chip, load_address: "8000", import_graph: false, platform: "none" });
  check(!/EasyFlash|EF_BANK|GMod2 control/.test(listingOf(noPlatform)), "C10 platform none names nothing, as before");
  main.mcp.stop();

  // the project's only cartridge decides for bytes that came from nowhere in particular
  const solo = await openProject("solo");
  writeFileSync(join(solo.proj, "artifacts/solo.crt"), crtImage(60, "solo"));
  await solo.call("extract_crt", { crt_path: "artifacts/solo.crt", output_dir: "analysis/extracted_solo" });
  writeFileSync(join(solo.proj, "artifacts/stray.bin"), BANK);
  const c11 = await solo.call("disasm", { path: "artifacts/stray.bin", load_address: "8000", import_graph: false });
  check(/GMod2 control register/.test(listingOf(c11)) && /the project's only cartridge/.test(c11), "C11 a project that holds one cartridge names its window for it, and says so", c11.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  const none = await openProject("none");
  writeFileSync(join(none.proj, "artifacts/stray.bin"), BANK);
  const c12 = await none.call("disasm", { path: "artifacts/stray.bin", load_address: "8000", import_graph: false });
  check(/cartridge I\/O \$DE00/.test(listingOf(c12)) && !/EF_BANK|EasyFlash/.test(listingOf(c12)), "C12 a project with no cartridge at all: neutral, never EasyFlash", commentsFor(listingOf(c12), /cart_io_de00/));
  solo.mcp.stop();
  none.mcp.stop();
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  the gate itself could not run: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  try { main?.mcp.stop(); } catch { /* gone */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  cartridge bank listing: ${pass} pass, ${failCount} fail.`);
if (!failCount && !process.env.C64RE_KEEP) for (const p of projects) { try { rmSync(p, { recursive: true, force: true }); } catch { /* temp */ } }
else console.log(`projects: ${projects.join(" ")}`);
process.exit(failCount ? 1 : 0);
