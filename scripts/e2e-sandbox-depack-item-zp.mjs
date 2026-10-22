#!/usr/bin/env node
// sandbox_depack — a batch item can seed its own zero page.
//
// One resident depacker often runs over several streams that differ only in a
// zero-page pointer (a source or end address the caller sets before the JSR).
// `items` could override initial_a/x/y but not initial_zp, so such a batch had
// to be split into one call per stream. This gate drives the registered tool
// handler and asserts:
//
//   1. an item's initial_zp reaches the CPU for that item only;
//   2. keys the item does not name keep the shared initial_zp value;
//   3. an item without initial_zp runs with the shared map unchanged.
//
// Requires a built `trx64cli` in the sibling TRX64 checkout; skips loudly without one.

import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const { registerSandboxDepackTool } = await import(
  pathToFileURL(join(ROOT, "dist/server-tools/sandbox-depack.js")).href
);
const { resolveTrx64Cli } = await import(pathToFileURL(join(ROOT, "dist/sandbox/trx64cli.js")).href);

if (!existsSync(resolveTrx64Cli())) {
  console.log(`  SKIPPED — no trx64cli at ${resolveTrx64Cli()}. Build it in the sibling TRX64 checkout.`);
  console.log(`\nGREEN  sandbox_depack item zp: skipped (no runtime binary).`);
  process.exit(0);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

// Capture the handler and parse its arguments the way the MCP server does.
let schema, handler;
const server = { tool: (_name, _desc, s, h) => { schema = s; handler = h; } };
const dir = testTmpDir("c64re-item-zp-");
registerSandboxDepackTool(server, { projectDir: () => dir });

// A "depacker" that writes its two zero-page seeds to $4000/$4001, then RTS.
writeFileSync(join(dir, "resident.bin"), Uint8Array.from([
  0xa5, 0xfb,       // LDA $FB
  0x8d, 0x00, 0x40, // STA $4000
  0xa5, 0xfc,       // LDA $FC
  0x8d, 0x01, 0x40, // STA $4001
  0x60,             // RTS
]));
writeFileSync(join(dir, "packed.bin"), Uint8Array.from([0x00]));

const args = z.object(schema).parse({
  input_path: "packed.bin",
  resident_loader_path: "resident.bin",
  resident_load_address: "0300",
  entry_pc: "0300",
  source_load_address: "2000",
  dest_address: "4000",
  initial_zp: { fb: 0x99, fc: 0x77 },
  items: [
    { output_path: "a.prg", initial_zp: { fb: 0x11 } },
    { output_path: "b.prg", initial_zp: { fb: 0x22 } },
    { output_path: "c.prg" },
  ],
});
await handler(args);

const out = (f) => {
  const p = join(dir, f);
  return existsSync(p) ? Buffer.from(readFileSync(p).subarray(2)).toString("hex") : "missing";
};
ok("item a: its own $FB, shared $FC", out("a.prg") === "1177", out("a.prg"));
ok("item b: its own $FB, shared $FC", out("b.prg") === "2277", out("b.prg"));
ok("item c: no initial_zp, shared map", out("c.prg") === "9977", out("c.prg"));
rmSync(dir, { recursive: true, force: true });

if (fails.length) {
  console.log(`\nRED  sandbox_depack item zp: ${pass} pass, ${fails.length} fail.`);
  process.exit(1);
}
console.log(`\nGREEN  sandbox_depack item zp: ${pass} pass, 0 fail.`);
