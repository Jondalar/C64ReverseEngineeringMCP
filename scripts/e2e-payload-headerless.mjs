#!/usr/bin/env node
// A payload has no header unless it is a PRG. Only a CBM file from a disk directory (or a payload declared
// `format: prg`) is read with a 2-byte load address; a cartridge chip is raw ROM at its window base, taken from
// the CRT CHIP packet, never from the bytes.
//
//   H1 a cartridge chip is headerless     extract_crt: no listing is "diverged"; the listing starts at the window base
//                                         ($8000), not at the chip's first two bytes; the rebuild is byte-identical
//                                         to the chip file; EasyFlash ROML+ROMH and GMod2 alike
//   H2 a disk PRG keeps its header        extract_disk: the listing's origin is the file's own load address and its
//                                         rebuild is byte-identical
//   H3 a raw payload is headerless        register_payload format:raw + load_address: origin = that address,
//                                         first byte is code, not an address
//   H4 unknown is not invented            a raw payload with no load address is refused by name
//
// Hermetic: synthetic CRT / D64 built here, a temp project outside the repo, MCP over stdio. No ROMs, no runtime.
// The rebuild checks need KickAssembler / 64tass: without one they report "not verified" and skip loudly.
// Run: npm run e2e:payload-headerless
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Buffer } from "node:buffer";
import { chipBytes, bankSwitchCode, HW_EASYFLASH, HW_GMOD2, makeCrt } from "./lib/cartridge-fixture-909.mjs";
import { d64WithPrg } from "./lib/d64-fixture.mjs";
import { makeChecker, load, ROOT } from "./lib/e2e-906-harness.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-payload-headerless");
const { check, head } = T;
console.log("Payloads are headerless unless they are PRG files\n");

const dir = mkdtempSync(join(tmpdir(), "c64re-e2e-hdrless-"));
check(!dir.startsWith(ROOT), "project dir is outside the repo", dir);
mkdirSync(join(dir, "media"), { recursive: true });
// bank 0: lda #n / sta $DE00 / jmp $8000 — its first two bytes ($A9 $nn) would be the bogus origin $nnA9
const GM = makeCrt({ name: "G", hardwareType: HW_GMOD2, banks: [{ bank: 0, code: bankSwitchCode(1), fill: 0xea }] });
const EF = makeCrt({ name: "E", hardwareType: HW_EASYFLASH, banks: [{ bank: 0, code: bankSwitchCode(2), fill: 0x60 }, { bank: 1, code: [0xa9, 0x05, 0x60], fill: 0x60, at: 0x10 }] });
writeFileSync(join(dir, "media", "gm.crt"), GM);
writeFileSync(join(dir, "media", "ef.crt"), EF);
// a real PRG on a disk: load $0801-ish custom address $C000, lda #$07 / sta $d020 / rts
const PRG = Uint8Array.from([0x00, 0xc0, 0xa9, 0x07, 0x8d, 0x20, 0xd0, 0x60]);
writeFileSync(join(dir, "media", "t.d64"), d64WithPrg("HDRPRG", PRG));
// a raw block: first two bytes $A9 $05 would read as origin $05A9
const RAW = Uint8Array.from([0xa9, 0x05, 0x8d, 0x21, 0xd0, 0x60]);
writeFileSync(join(dir, "media", "blob.bin"), RAW);

const { runPayloadReverseWorkflow, renderPrgReverseWorkflowResult } = await load("lib/prg-workflow.js");
const m = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_AUTOSTART: "0" } });
await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-hdrless", version: "1" } });
m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const call = m.call;
const listingsUnder = (root) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/_disasm\.asm$/.test(e.name)) out.push(p); } };
  if (existsSync(root)) walk(root);
  return out;
};
let dir2;
const runWf = async (payloadId) => {
  try { return renderPrgReverseWorkflowResult(await runPayloadReverseWorkflow({ projectRoot: dir2, payloadId, mode: "quick", rebuildViews: false })); }
  catch (e) { return `refused: ${e instanceof Error ? e.message : String(e)}`; }
};
const origin = (asm) => (/\.pc\s*=\s*\$([0-9A-Fa-f]{4})/.exec(asm) ?? [])[1]?.toUpperCase();
try {
  await call("project_init", { preferred_assembler: "kickass", project_dir: dir, name: "hdrless" });
  await call("agent_onboard", { project_dir: dir });

  head("H1. cartridge chips are headerless");
  const eg = await call("extract_crt", { project_dir: dir, crt_path: "media/gm.crt" });
  const ee = await call("extract_crt", { project_dir: dir, crt_path: "media/ef.crt" });
  const rb = (t) => /Rebuild: (\d+) byte-identical, (\d+) diverged, (\d+) not verified/.exec(t);
  const rg = rb(eg), re = rb(ee);
  check(rg && re, "H1.1 both extracts report a rebuild verdict", `${rg} ${re}`);
  check(rg && re && +rg[2] === 0 && +re[2] === 0, "H1.2 no chip listing is diverged", `${rg?.[0]} | ${re?.[0]}`);
  const chipListings = listingsUnder(join(dir, "artifacts", "generated", "payloads"));
  check(chipListings.length === 3, "H1.3 three chip listings (GMod2 1 + EasyFlash 2)", String(chipListings.length));
  check(chipListings.every((p) => origin(readFileSync(p, "utf8")) === "8000"), "H1.4 every chip listing starts at the window base $8000, not at the chip's first two bytes", chipListings.map((p) => origin(readFileSync(p, "utf8"))).join(","));
  check(chipListings.some((p) => readFileSync(p, "utf8").includes("$DE00")), "H1.5 the first chip byte is code (the $DE00 store is disassembled)");
  check(!/no load address is known/.test(eg), "H1.6 a chip's load address is known (CHIP packet), the answer does not claim otherwise");

  head("H5. a LUT's destination is the LLM's reading, never written by the tool");
  mkdirSync(join(dir, "analysis", "runtime_luts"), { recursive: true });
  writeFileSync(join(dir, "analysis", "runtime_luts", "all_luts.json"), JSON.stringify({ tracks: { entries: [{ idx: 0, ef_bank: 0, src_addr: "8000", length: 32, dest: "1000", flag: "$00" }] } }));
  const bulk = await call("bulk_create_cart_chunk_payloads", { project_dir: dir });
  const created = /Created: (\d+)/.exec(bulk);
  const lp5 = await call("list_payloads", { project_dir: dir, limit: 100 });
  const chunkRows = lp5.split("\n").filter((l) => /cart-chunk|tracks/.test(l) && !/:chip:/.test(l));
  check(created && +created[1] >= 1, "H5.1 bulk_create promotes the LUT chunk", bulk.split("\n").slice(0, 6).join(" | "));
  check(chunkRows.length >= 1 && chunkRows.every((l) => /load=—/.test(l)), "H5.2 the promoted chunk carries NO load address (the LUT's $1000 is not recorded)", chunkRows.join(" || "));
  check(/NO load address/.test(bulk) && /\$1000/.test(bulk) && /proposal/.test(bulk), "H5.3 the answer says the LLM must declare it, and shows the LUT's value as a proposal", bulk.split("\n").slice(-4).join(" | "));

  head("H2. a disk PRG keeps its 2-byte header");
  const ed = await call("extract_disk", { project_dir: dir, image_path: "media/t.d64" });
  const rd = rb(ed);
  // Without KickAssembler or 64tass nothing can be rebuilt: the extract says "not verified". That is a loud skip,
  // never a pass — and only when no assembler is on this machine; with one, "not verified" is a failure.
  const haveAssembler = !!process.env.C64RE_KICKASS_JAR && existsSync(process.env.C64RE_KICKASS_JAR)
    || [process.env.C64RE_64TASS_BIN, "/opt/homebrew/bin/64tass", "/usr/local/bin/64tass", "/usr/bin/64tass"].some((p) => p && existsSync(p))
    || (process.env.PATH ?? "").split(delimiter).some((d) => d && (existsSync(join(d, "64tass")) || existsSync(join(d, "64tass.exe"))));
  if (rd && +rd[1] === 0 && +rd[2] === 0 && +rd[3] >= 1 && !haveAssembler) {
    console.log("  SKIP  H2.1 the PRG listing rebuilds byte-identical — no KickAssembler or 64tass on this machine; skipped, NOT passed");
  } else {
    check(rd && +rd[1] >= 1 && +rd[2] === 0, "H2.1 the PRG listing rebuilds byte-identical", rd?.[0] ?? ed.split("\n").slice(0, 6).join(" | "));
  }
  const diskListings = listingsUnder(join(dir, "artifacts", "generated")).filter((p) => !chipListings.includes(p));
  check(diskListings.some((p) => origin(readFileSync(p, "utf8")) === "C000"), "H2.2 its origin is the file's own load address $C000", diskListings.map((p) => origin(readFileSync(p, "utf8"))).join(","));

  // a project of its own: register_payload is gated while a mapped project has empty required slots
  dir2 = mkdtempSync(join(tmpdir(), "c64re-e2e-hdrless2-"));
  mkdirSync(join(dir2, "media"), { recursive: true });
  writeFileSync(join(dir2, "media", "blob.bin"), RAW);
  await call("project_init", { preferred_assembler: "kickass", project_dir: dir2, name: "hdrless-raw" });
  await call("agent_onboard", { project_dir: dir2 });
  head("H3 / H4. a raw payload is headerless, and unknown is not invented");
  const rp = await call("register_payload", { project_dir: dir2, name: "blob", source_prg_path: join(dir2, "media", "blob.bin"), load_address: 0xc100, format: "raw" });
  check(!/refused|error/i.test(rp.split("\n")[0]), "H3.1 register_payload format:raw + load_address is accepted", rp.split("\n").slice(0, 4).join(" | "));
  const rl = await call("list_payloads", { project_dir: dir2, limit: 50 });
  const blobRow = rl.split("\n").find((l) => /\bblob\b/.test(l)) ?? "";
  const bid = blobRow.split("|")[0].trim();
  const wr = await runWf(bid);
  const blobAsm = listingsUnder(join(dir2, "artifacts", "generated")).filter((p) => /blob/i.test(p));
  check(blobAsm.length > 0 && blobAsm.every((p) => origin(readFileSync(p, "utf8")) === "C100"), "H3.2 the raw payload's listing starts at its declared address $C100, not at its first two bytes ($05A9)", `${bid} ${blobAsm.map((p) => origin(readFileSync(p, "utf8"))).join(",")} ${wr.split("\n").slice(0, 4).join(" | ")}`);
  // unknown stays unknown: a raw block registered with no load address
  dir2 = mkdtempSync(join(tmpdir(), "c64re-e2e-hdrless3-"));
  mkdirSync(join(dir2, "media"), { recursive: true });
  writeFileSync(join(dir2, "media", "blob.bin"), RAW);
  await call("project_init", { preferred_assembler: "kickass", project_dir: dir2, name: "hdrless-unknown" });
  await call("agent_onboard", { project_dir: dir2 });
  const rp2 = await call("register_payload", { project_dir: dir2, name: "blob2", source_prg_path: join(dir2, "media", "blob.bin"), format: "raw" });
  const rl2 = await call("list_payloads", { project_dir: dir2, limit: 50 });
  const row2 = rl2.split("\n").find((l) => /\bblob2\b/.test(l)) ?? "";
  const w2 = await runWf(row2.split("|")[0].trim());
  check(/no load address/i.test(w2) && listingsUnder(join(dir2, "artifacts", "generated")).length === 0, "H4.1 a raw payload with no load address is refused with 'no load address'; no listing is made from its bytes", `${rp2.split("\n")[0]} / ${w2.split("\n").slice(0, 3).join(" | ")}`);
} finally {
  m.proc.kill();
}
process.exit(T.done());
