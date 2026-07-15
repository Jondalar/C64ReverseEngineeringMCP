// Spec 788 Slice 1 piece B — sandbox_depack real-core CAPABILITY.
//
// Proves the rerouted engine harvests correct bytes for a depacker whose dest
// lands in the $E000-$FFFF banking region, and demonstrates the class of
// behaviour the flat-64K TS shadow structurally could NOT do: reading real
// KERNAL ROM. On the real core, $E000 under the standard $37 memory config is
// KERNAL ROM; on the flat shadow $E000 is plain (unloaded → zero) RAM.
//
// Run:
//   npx tsx tests/spec-788/depack-reroute-capability.test.ts

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  genericSandboxDepack,
  genericSandboxDepackTs,
  resolveTrx64Cli,
  type SandboxDepackOptions,
} from "../../src/sandbox/sandbox-depack-generic.js";
import { runSandbox } from "../../src/sandbox/sandbox-runner.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kernalPath = resolvePath(repoRoot, "resources", "roms", "kernal-901227-03.bin");

// Same XOR-decrypt copy routine as the parity fixture (Y-indexed, no ZP writes).
function xorCopyRoutine(len: number, key: number): Uint8Array {
  return Uint8Array.from([
    0xa0, 0x00, 0xb1, 0x52, 0x49, key & 0xff, 0x91, 0xfb,
    0xc8, 0xc0, len & 0xff, 0xd0, 0xf5, 0x60,
  ]);
}

// ── Case 1: dest in the $E000-$FFFF region, harvested on the real core. ─────
test("depacker writing to $E000 dest — real core harvests correct bytes", () => {
  const packed = Uint8Array.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
  const key = 0x5a;
  const opts: SandboxDepackOptions = {
    packed,
    residentLoader: xorCopyRoutine(packed.length, key),
    residentLoadAddress: 0xc000,
    entryPc: 0xc000,
    initialZp: { 0xfb: 0x00, 0xfc: 0xe0 }, // dst = $E000
    destAddress: 0xe000,
  };
  const expected = Uint8Array.from(Array.from(packed, (b) => b ^ key));

  const real = genericSandboxDepack(opts);
  assert.equal(real.destAddress, 0xe000, "dest $E000");
  assert.deepEqual(Array.from(real.unpacked), Array.from(expected), "real-core $E000 harvest");
  assert.equal(real.stopReason, "sentinel_rts");

  // Under --io $34 (all-RAM) the shadow also serves $E000 as RAM, so it agrees
  // here — this case proves the new path handles the high region, NOT a
  // divergence. The divergence (real ROM at $E000) is Case 2.
  const shadow = genericSandboxDepackTs(opts);
  assert.deepEqual(Array.from(shadow.unpacked), Array.from(real.unpacked),
    "shadow all-RAM agrees on the $E000 dest");
});

// ── Case 2: read REAL KERNAL ROM at $E000 — the flat shadow cannot. ─────────
test("real KERNAL ROM at $E000 under $37 — shadow structurally cannot", () => {
  if (!existsSync(kernalPath)) {
    throw new Error(`kernal ROM missing at ${kernalPath}`);
  }
  const kernal = readFileSync(kernalPath);
  const kernalByte0 = kernal[0]!; // $E000 in the KERNAL ROM
  assert.notEqual(kernalByte0, 0x00, "KERNAL byte at $E000 should be non-zero for a meaningful contrast");

  // Routine: LDA $E000 ; STA $C000 ; RTS. $C000 is always RAM, so it is
  // harvestable regardless of banking.
  const routine = Uint8Array.from([0xad, 0x00, 0xe0, 0x8d, 0x00, 0xc0, 0x60]);

  // Real core, --io $37 (KERNAL visible): LDA $E000 reads the ROM byte.
  const cli = resolveTrx64Cli();
  const tmp = mkdtempSync(join(tmpdir(), "c64re-cap-"));
  let realByte: number;
  try {
    const routineFile = join(tmp, "romread.bin");
    writeFileSync(routineFile, routine);
    const stdout = execFileSync(cli, [
      "sandbox",
      "--load", `${routineFile}@$c000`,
      "--entry", "$c000", "--direct-entry",
      "--io", "$37",
      "--harvest", "$c000:1",
      "--json",
    ], { env: { ...process.env, C64RE_ROOT: process.env.C64RE_ROOT ?? repoRoot }, encoding: "utf8" });
    const j = JSON.parse(stdout) as { stopReason: string; harvest: { hex: string } };
    assert.equal(j.stopReason, "sentinel_rts");
    realByte = parseInt(j.harvest.hex.slice(0, 2), 16);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Flat-64K TS shadow: $E000 is unloaded RAM → reads 0, stores 0 to $C000.
  const shadowRun = runSandbox({
    loads: [{ bytes: routine, address: 0xc000 }],
    initialPc: 0xc000,
    maxSteps: 1000,
  });
  assert.equal(shadowRun.stopReason, "sentinel_rts");
  const shadowByte = shadowRun.writtenMap[0xc000];

  // The real core sees the actual KERNAL byte; the flat shadow sees 0.
  assert.equal(realByte, kernalByte0, `real core reads KERNAL $E000 = $${kernalByte0.toString(16)}`);
  assert.equal(shadowByte, 0x00, "flat shadow has no KERNAL at $E000 → reads 0");
  assert.notEqual(realByte, shadowByte, "real-core ROM read differs from the shadow");
});

// ── Runner. ──────────────────────────────────────────────────────────────
if (!existsSync(resolveTrx64Cli())) {
  console.log(`[skip] trx64cli not found at ${resolveTrx64Cli()} — build it in ../TRX64`);
  process.exit(0);
}
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ndepack-reroute-capability: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
