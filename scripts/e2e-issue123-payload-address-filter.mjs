#!/usr/bin/env node
// Issue #123 — list_payloads {address} keeps a payload exactly when the window list_payloads prints for it
// (win=...) covers the address. A synthetic 2-bank EasyFlash cartridge, one 8K ROML chip per bank, both at $8000.
//   1  list_payloads {}                  lists 2 payloads, win=$8000-$9FFF
//   2  address $8000 and 8000            Payloads: 2 (of 2), both chips named
//   3  address $9FFF                     the same 2
//   4  address $A000                     Payloads: 0 (of 2)
// Hermetic: temp project, stdio MCP server, no daemon.   npm run e2e:issue123-payload-address-filter
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  if (cond) passes++; else failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n        ${detail}` : ""}`);
};

function synthCrt() {
  const hdr = Buffer.alloc(0x40);
  hdr.write("C64 CARTRIDGE   ", 0, "latin1");
  hdr.writeUInt32BE(0x40, 0x10);
  hdr.writeUInt16BE(0x0100, 0x14);
  hdr.writeUInt16BE(32, 0x16);
  hdr[0x18] = 1; hdr[0x19] = 0;
  hdr.write("SYNTH TWO BANK", 0x20, "latin1");
  const chip = (bank) => {
    const c = Buffer.alloc(0x10 + 0x2000);
    c.write("CHIP", 0, "latin1");
    c.writeUInt32BE(0x10 + 0x2000, 4);
    c.writeUInt16BE(2, 8);
    c.writeUInt16BE(bank, 10);
    c.writeUInt16BE(0x8000, 12);
    c.writeUInt16BE(0x2000, 14);
    const code = [0xA9, bank, 0x8D, 0x20, 0xD0, 0x4C, 0x05, 0x80];
    for (let i = 0; i < 0x2000; i++) c[0x10 + i] = i < code.length ? code[i] : (i + bank * 7) & 0xff;
    return c;
  };
  return Buffer.concat([hdr, chip(0), chip(1)]);
}

const { ownerOfEntityId } = await import("../dist/symbols/window-residency.js");
check("a cartridge chip id names no owner", ownerOfEntityId("synth2:crt/synth2/00:chip:8000") === undefined);
check("a ram id still names its owner", ownerOfEntityId("wl:ram/eng:payload:1000") === "eng");

const dir = mkdtempSync(join(tmpdir(), "c64re-123-"));
let client;
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "synth2.crt"), synthCrt());
  client = new Client({ name: "e2e123", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist", "cli.js")],
    env: { ...process.env, C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_AUTOSTART: "0" }, stderr: "ignore",
  }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  await call("project_init", { preferred_assembler: "kickass", name: "synth2", project_dir: dir });
  await call("agent_onboard", {});
  const ex = await call("extract_crt", { crt_path: "input/crt/synth2.crt" });
  check("extract_crt ran", /Imported manifest|payload|chip/i.test(ex), ex.slice(0, 300));

  const all = await call("list_payloads", {});
  check("list_payloads {} lists 2 payloads", /Payloads: 2\b/.test(all), all);
  check("both chips show win=$8000-$9FFF", (all.match(/win=\$8000-\$9FFF/g) ?? []).length === 2, all);
  const ids = [...all.matchAll(/^\s+(\S+:chip:8000) \|/gm)].map((m) => m[1]);
  check("two chip payload ids", ids.length === 2, all);

  for (const a of ["$8000", "8000", "$9FFF"]) {
    const t = await call("list_payloads", { address: a });
    check(`address ${a}: Payloads: 2 (of 2)`, /Payloads: 2 \(of 2\)/.test(t), t);
    check(`address ${a}: both chips named`, ids.length === 2 && ids.every((id) => t.includes(`  ${id} |`)), t);
  }
  const out = await call("list_payloads", { address: "$A000" });
  check("address $A000: Payloads: 0 (of 2)", /Payloads: 0 \(of 2\)/.test(out), out);
} finally {
  try { await client?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${failures ? "RED" : "GREEN"} issue 123: ${passes} pass, ${failures} fail`);
process.exit(failures ? 1 : 0);
