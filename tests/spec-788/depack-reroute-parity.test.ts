// Spec 788 Slice 1 piece B — sandbox_depack real-core CORRECTNESS.
//
// Originally a one-time migration cross-check that compared the rerouted
// `sandbox_depack` engine (`genericSandboxDepack`, on the TRX64 real 6502 core)
// against the flat-64K TS `Cpu6502` shadow (`genericSandboxDepackTs`). Spec 788
// tail piece C deleted the shadow, so this is now a standalone CORRECTNESS
// assertion: the synthetic depacker fixtures (XOR-copy + RLE) have deterministic
// KNOWN unpacked bytes, computed independently in-test — the real-core engine
// must reproduce them byte-for-byte, and the tool prose must reflect them.
//
// Run:
//   npx tsx tests/spec-788/depack-reroute-parity.test.ts
//
// Requires the sibling `trx64cli` (../TRX64/target/release/trx64cli) and the
// C64 ROMs under resources/roms (both present in the dev tree).

import { strict as assert } from "node:assert";
import {
  genericSandboxDepack,
  resolveTrx64Cli,
  type SandboxDepackOptions,
  type SandboxDepackResult,
} from "../../src/sandbox/sandbox-depack-generic.js";
import { existsSync } from "node:fs";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ── Fixtures (hand-assembled 6502, verified against trx64cli). ─────────────

// XOR-decrypt copy: out[Y] = src[Y] ^ key, Y = 0..len-1, then RTS. Uses Y-index
// register only (no zero-page writes) so the write-set is exactly the dest run.
//   A0 00      LDY #$00
//   B1 52      LDA ($52),Y     ; src[Y]
//   49 kk      EOR #key
//   91 FB      STA ($fb),Y     ; dst[Y]
//   C8         INY
//   C0 ll      CPY #len
//   D0 F5      BNE loop
//   60         RTS
function xorCopyRoutine(len: number, key: number): Uint8Array {
  return Uint8Array.from([
    0xa0, 0x00, 0xb1, 0x52, 0x49, key & 0xff, 0x91, 0xfb,
    0xc8, 0xc0, len & 0xff, 0xd0, 0xf5, 0x60,
  ]);
}

// RLE decruncher: packed = [count, value] pairs, count 0 terminates. src ptr in
// $52/$53, dst ptr in $fb/$fc (both advanced in zero-page → those ZP writes are
// NOT part of the dest output). Each output byte is stored exactly once.
const RLE_ROUTINE = Uint8Array.from([
  0xa0, 0x00,             // LDY #$00
  0xb1, 0x52,             // [next] LDA ($52),Y   ; count
  0xf0, 0x1d,             // BEQ done
  0xaa,                   // TAX
  0xe6, 0x52,             // INC $52
  0xd0, 0x02,             // BNE +
  0xe6, 0x53,             // INC $53
  0xb1, 0x52,             // [+] LDA ($52),Y      ; value
  0x91, 0xfb,             // [fill] STA ($fb),Y   ; dst = value
  0xe6, 0xfb,             // INC $fb
  0xd0, 0x02,             // BNE ++
  0xe6, 0xfc,             // INC $fc
  0xca,                   // [++] DEX
  0xd0, 0xf5,             // BNE fill
  0xe6, 0x52,             // INC $52
  0xd0, 0x02,             // BNE +++
  0xe6, 0x53,             // INC $53
  0x4c, 0x02, 0xc0,       // [+++] JMP next
  0x60,                   // [done] RTS
]);

function rleExpand(pairs: number[]): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const count = pairs[i]!;
    if (count === 0) break;
    for (let n = 0; n < count; n++) out.push(pairs[i + 1]!);
  }
  return Uint8Array.from(out);
}

// ── Prose reproduction (mirrors src/server-tools/sandbox-depack.ts:110-118). ─
interface FixedProse {
  inputAbs: string; offset: number; packedLen: number;
  residentAbs: string; residentLoadAddress: number; residentLen: number;
  outPath: string;
}
function renderProse(result: SandboxDepackResult, fx: FixedProse): string {
  const prgLen = 2 + result.unpacked.length;
  return [
    `sandbox_depack finished.`,
    `Input: ${fx.inputAbs} +$${fx.offset.toString(16)} (${fx.packedLen} bytes)`,
    `Resident loader: ${fx.residentAbs} @ $${fx.residentLoadAddress.toString(16)} (${fx.residentLen} bytes)`,
    `Entry PC: $${result.entryPc.toString(16)}`,
    `Output: ${fx.outPath} (${prgLen} bytes incl. load header)`,
    `Dest: $${result.destAddress.toString(16)} unpacked=${result.unpacked.length}`,
    `Sandbox: ${result.steps} steps, stop=${result.stopReason}, total writes=${result.writes.length}`,
  ].join("\n");
}

// Assert the real-core engine reproduces the independently-computed expected
// bytes, and that the tool prose reflects the known result facts.
function assertCorrect(
  name: string,
  opts: SandboxDepackOptions,
  expected: Uint8Array,
  expectedDest: number,
): void {
  const real = genericSandboxDepack(opts);

  // 1) unpacked bytes byte-identical to the independently-computed expectation.
  assert.deepEqual(Array.from(real.unpacked), Array.from(expected), `${name}: real-core unpacked != expected`);

  // 2) engine-visible result fields have their known-correct values.
  assert.equal(real.destAddress, expectedDest, `${name}: destAddress`);
  assert.equal(real.entryPc, opts.entryPc, `${name}: entryPc`);
  assert.equal(real.stopReason, "sentinel_rts", `${name}: stopReason`);
  assert.equal(real.writes.length, expected.length, `${name}: writes.length == unpacked length`);

  // 3) the sandbox_depack tool output prose renders and reflects the known facts.
  const fx: FixedProse = {
    inputAbs: "/proj/input.bin", offset: 0, packedLen: opts.packed.length,
    residentAbs: "/proj/resident.bin", residentLoadAddress: opts.residentLoadAddress,
    residentLen: opts.residentLoader.length, outPath: "/proj/analysis/depack/input-0000.prg",
  };
  const prose = renderProse(real, fx);
  assert.ok(prose.startsWith("sandbox_depack finished."), `${name}: prose header`);
  assert.ok(
    prose.includes(`Dest: $${expectedDest.toString(16)} unpacked=${expected.length}`),
    `${name}: prose dest/unpacked line`,
  );
  assert.ok(prose.includes("stop=sentinel_rts"), `${name}: prose stop reason`);
}

// ── Cases. ─────────────────────────────────────────────────────────────────

test("XOR-decrypt copy — real-core bytes match known expectation (no captureRange, auto-dest)", () => {
  const packed = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  const key = 0x5a;
  const opts: SandboxDepackOptions = {
    packed,
    residentLoader: xorCopyRoutine(packed.length, key),
    residentLoadAddress: 0xc000,
    entryPc: 0xc000,
    initialZp: { 0xfb: 0x00, 0xfc: 0x40 }, // dst = $4000
    // destAddress unset → exercise largest-contiguous-run auto-detect.
  };
  const expected = Uint8Array.from(Array.from(packed, (b) => b ^ key));
  assertCorrect("xor-copy", opts, expected, 0x4000);
});

test("RLE decruncher — variable-length output matches known expectation (captureRange path)", () => {
  const pairs = [3, 0x41, 2, 0x42, 4, 0x43, 5, 0xff, 0]; // AAA BB CCCC (0xff)x5
  const packed = Uint8Array.from(pairs);
  const expected = rleExpand(pairs);
  const dst = 0x4000;
  const opts: SandboxDepackOptions = {
    packed,
    residentLoader: RLE_ROUTINE,
    residentLoadAddress: 0xc000,
    entryPc: 0xc000,
    initialZp: { 0xfb: dst & 0xff, 0xfc: (dst >> 8) & 0xff },
    // captureRange confines the write-set to the dest window (drops the ZP
    // pointer-advance writes) so the reported total-writes == unpacked length.
    captureRange: { start: dst, end: dst + expected.length - 1 },
  };
  assertCorrect("rle", opts, expected, dst);
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
console.log(`\ndepack-reroute-parity: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
