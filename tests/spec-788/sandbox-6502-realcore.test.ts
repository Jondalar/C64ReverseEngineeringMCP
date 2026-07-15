// Spec 788 tail (piece B) — sandbox_6502_run real-core ENGINE tests.
//
// `runSandboxRealCore` is the drop-in that replaces the flat-64K TS `Cpu6502`
// shadow behind the `sandbox_6502_run` tool: same SandboxRunOptions in, same
// SandboxRunResult out, but the routine executes on the TRX64 real 6502 core.
// These cases prove the produced SandboxRunResult is correct + faithfully
// shaped (so the tool's unchanged output formatter yields the same lines):
//   * a RAM routine writing a contiguous range (harvest + writtenSpan + writes)
//   * A/X/Y/SP seeding observed at ENTRY
//   * a stream-hook get_byte feed (harvest == fed stream, streamPos advances)
//   * a multi-range memory snapshot
//   * a read-only ROM overlay mapping is rejected (halt-and-report), not faked
//
// Run:
//   npx tsx tests/spec-788/sandbox-6502-realcore.test.ts

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { runSandboxRealCore } from "../../src/sandbox/index.js";
import { resolveTrx64Cli } from "../../src/sandbox/trx64cli.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ── Case 1: a RAM routine filling $0400..$0403, harvested + write-mapped. ────
// c000: LDX #$00 / LDA #$ab / STA $0400,X / INX / CPX #$04 / BNE / RTS
test("RAM routine — harvest, writtenSpan, distinct-write count, final regs", () => {
  const routine = [0xa2, 0x00, 0xa9, 0xab, 0x9d, 0x00, 0x04, 0xe8, 0xe0, 0x04, 0xd0, 0xf8, 0x60];
  const r = runSandboxRealCore({
    loads: [{ bytes: routine, address: 0xc000 }],
    initialPc: 0xc000,
    returnMemoryRanges: [{ start: 0x0400, end: 0x0403 }],
    maxSteps: 100_000,
  });
  assert.equal(r.stopReason, "sentinel_rts", "top-level RTS ⇒ sentinel_rts");
  assert.deepEqual(r.memorySnapshots[0]!.bytes, [0xab, 0xab, 0xab, 0xab], "harvest of $0400-$0403");
  assert.deepEqual(r.writtenSpan, { start: 0x0400, end: 0x0403, bytes: [0xab, 0xab, 0xab, 0xab] }, "write span");
  assert.equal(r.writes.length, 4, "4 distinct written addresses");
  assert.equal(r.finalState.a, 0xab, "final A");
  assert.equal(r.finalState.x, 0x04, "final X");
  assert.equal(r.finalState.y, 0x00, "final Y");
  assert.equal(r.finalState.sp, 0xff, "SP after RTS popped the staged sentinel");
  assert.equal(r.finalState.pc, 0xfffe, "PC = staged RTS sentinel landing");
  assert.equal(r.streamPos, 0, "no stream hooks");
  assert.equal(r.unimplementedOpcode, undefined, "full ISA ⇒ never an unimplemented op");
});

// ── Case 2: A/X/Y/SP seeded at ENTRY are observed by the routine. ────────────
// Reseeding SP moves it off $FD, so the staged RTS-sentinel ($01FE/$01FF) is
// unreachable (same in the shadow) — terminate via a stop_pc JMP instead.
// c000: STA $0410 / STX $0411 / STY $0412 / TSX / STX $0413 / JMP $c010
test("register seeding reaches entry — A/X/Y/SP stored from entry state", () => {
  const routine = [0x8d, 0x10, 0x04, 0x8e, 0x11, 0x04, 0x8c, 0x12, 0x04, 0xba, 0x8e, 0x13, 0x04, 0x4c, 0x10, 0xc0];
  const r = runSandboxRealCore({
    loads: [{ bytes: routine, address: 0xc000 }],
    initialPc: 0xc000,
    initialA: 0x11,
    initialX: 0x22,
    initialY: 0x33,
    initialSp: 0x80,
    stopPc: 0xc010,
    returnMemoryRanges: [{ start: 0x0410, end: 0x0413 }],
  });
  assert.equal(r.stopReason, "stop_pc");
  assert.deepEqual(r.memorySnapshots[0]!.bytes, [0x11, 0x22, 0x33, 0x80], "entry A/X/Y/SP");
});

// ── Case 3: a hooked get_byte PC is fed from the input stream. ───────────────
// c000: LDX #$00 / JSR $c100 (hooked) / STA $0420,X / INX / CPX #$04 / BNE / RTS
test("stream-hook get_byte — harvest == fed stream, streamPos advances", () => {
  const routine = [0xa2, 0x00, 0x20, 0x00, 0xc1, 0x9d, 0x20, 0x04, 0xe8, 0xe0, 0x04, 0xd0, 0xf5, 0x60];
  const r = runSandboxRealCore({
    loads: [
      { bytes: routine, address: 0xc000 },
      { bytes: [0x60], address: 0xc100 }, // real RTS body (never reached — hooked)
    ],
    initialPc: 0xc000,
    streamHookPcs: [0xc100],
    inputStream: [0x11, 0x22, 0x33, 0x44],
    returnMemoryRanges: [{ start: 0x0420, end: 0x0423 }],
  });
  assert.equal(r.stopReason, "sentinel_rts");
  assert.deepEqual(r.memorySnapshots[0]!.bytes, [0x11, 0x22, 0x33, 0x44], "stored stream bytes");
  assert.equal(r.streamPos, 4, "streamPos == bytes consumed");
  assert.equal(r.finalState.a, 0x44, "A holds the last streamed byte");
});

// ── Case 4: two independent memory ranges snapshot separately. ──────────────
// c000: LDA #$aa / STA $0430 / LDA #$bb / STA $0440 / RTS
test("multi-range snapshot — two returnMemoryRanges → two snapshots", () => {
  const routine = [0xa9, 0xaa, 0x8d, 0x30, 0x04, 0xa9, 0xbb, 0x8d, 0x40, 0x04, 0x60];
  const r = runSandboxRealCore({
    loads: [{ bytes: routine, address: 0xc000 }],
    initialPc: 0xc000,
    returnMemoryRanges: [
      { start: 0x0430, end: 0x0430 },
      { start: 0x0440, end: 0x0440 },
    ],
  });
  assert.equal(r.stopReason, "sentinel_rts");
  assert.equal(r.memorySnapshots.length, 2, "two snapshots");
  assert.deepEqual(r.memorySnapshots[0], { start: 0x0430, end: 0x0430, bytes: [0xaa] });
  assert.deepEqual(r.memorySnapshots[1], { start: 0x0440, end: 0x0440, bytes: [0xbb] });
  // Two distinct write runs.
  assert.equal(r.writes.length, 2, "two distinct written addresses");
});

// ── Case 5: stop_pc → the "stop_pc" vocab (not the RTS sentinel). ───────────
// c000: NOP / JMP $c000 (spin) ; stop_pc = $c000 hits before the first step.
test("stop_pc maps to the stop_pc stop reason", () => {
  // c000: LDA #$01 / STA $0450 / JMP $c005 ; stop at $c005
  const routine = [0xa9, 0x01, 0x8d, 0x50, 0x04, 0x4c, 0x05, 0xc0];
  const r = runSandboxRealCore({
    loads: [{ bytes: routine, address: 0xc000 }],
    initialPc: 0xc000,
    stopPc: 0xc005,
    returnMemoryRanges: [{ start: 0x0450, end: 0x0450 }],
    maxSteps: 100_000,
  });
  assert.equal(r.stopReason, "stop_pc", "explicit stop_pc breakpoint");
  assert.deepEqual(r.memorySnapshots[0]!.bytes, [0x01]);
});

// ── Case 6: a read-only ROM overlay mapping is rejected, not faked. ─────────
// (Runs even without trx64cli — resolveLoad throws before any spawn.)
test("read-only ROM overlay mapping is rejected (halt-and-report)", () => {
  for (const mapping of ["rom", "ef_roml", "ef_romh"] as const) {
    assert.throws(
      () => runSandboxRealCore({ loads: [{ bytes: [0x60], address: 0x8000, mapping }], initialPc: 0x8000 }),
      /read-only ROM overlay/,
      `mapping "${mapping}" must be rejected`,
    );
  }
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
console.log(`\nsandbox-6502-realcore: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
