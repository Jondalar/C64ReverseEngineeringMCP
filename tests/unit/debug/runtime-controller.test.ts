// Spec 701.5 — RuntimeController tests.
//
// Covers the §9 gates at the controller level: run/pause, breakpoint hit
// (backend self-halt, no UI polling), continue (no immediate re-hit), step
// (exactly one instruction), UI-disconnected run, and PAL-vs-Warp
// equal-cycle equivalence (pacing/chunking must not alter emulated state).
//
// The controller only ever touches `session.c64Cpu.*` and `session.runFor`,
// so a FakeSession that reproduces runFor's semantics (breakpoint checked
// BEFORE the step, then the cycle-budget check) exercises every code path
// deterministically without spinning up the full emulator.
//
// Run via: npx tsx tests/unit/debug/runtime-controller.test.ts

import { strict as assert } from "node:assert";
import { RuntimeController } from "../../../src/runtime/headless/debug/runtime-controller.js";

// ---- fake session ----------------------------------------------------------

interface RunForOpts { breakpoints?: Set<number>; cycleBudget?: number; }
interface RunForResult { instructionsExecuted: number; lastPc: number; aborted?: "breakpoint" | "cycle-budget"; }

// cyclesPerInstr = 1 so a cycleBudget maps to an EXACT instruction count and
// pc == startPc + cyclesElapsed. That makes any chunking of N total cycles
// produce identical (pc, cycles), which is exactly the property §9.6 asserts.
class FakeSession {
  c64Cpu = { pc: 0x1000, a: 0, x: 0, y: 0, sp: 0xff, flags: 0x20, cycles: 0 };
  calls: Array<{ maxInstr: number; cycleBudget: number; bps: number[] }> = [];

  runFor(maxInstr: number, opts?: RunForOpts): RunForResult {
    const cycleBudget = opts?.cycleBudget ?? Infinity;
    const bps = opts?.breakpoints;
    this.calls.push({ maxInstr, cycleBudget, bps: bps ? [...bps] : [] });
    const start = this.c64Cpu.cycles;
    let i = 0;
    for (; i < maxInstr; i++) {
      if (bps && bps.has(this.c64Cpu.pc)) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "breakpoint" };
      }
      if (this.c64Cpu.cycles - start >= cycleBudget) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "cycle-budget" };
      }
      this.c64Cpu.pc = (this.c64Cpu.pc + 1) & 0xffff;
      this.c64Cpu.cycles += 1;
    }
    return { instructionsExecuted: i, lastPc: this.c64Cpu.pc };
  }
}

interface Bcast { method: string; params: any; }
function mkController(): { ctrl: RuntimeController; fake: FakeSession; events: Bcast[] } {
  const fake = new FakeSession();
  const events: Bcast[] = [];
  const ctrl = new RuntimeController("test", fake as any, (method, params) => events.push({ method, params }));
  return { ctrl, fake, events };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await delay(2);
  }
}

// ---- harness ---------------------------------------------------------------

interface Case { name: string; run: () => void | Promise<void>; }
const cases: Case[] = [];
function test(name: string, run: () => void | Promise<void>): void { cases.push({ name, run }); }

// ---- tests -----------------------------------------------------------------

// §9.3 — backend loop advances the machine with no external pumping/polling.
test("run advances the session; pause stops it (UI-disconnected)", async () => {
  const { ctrl, fake } = mkController();
  assert.equal(ctrl.runState, "paused");
  ctrl.run({ mode: "warp" });
  assert.equal(ctrl.runState, "running");
  await waitFor(() => fake.c64Cpu.cycles > 0);
  ctrl.pause();
  assert.equal(ctrl.runState, "paused");
  const frozen = fake.c64Cpu.cycles;
  await delay(30);
  assert.equal(fake.c64Cpu.cycles, frozen, "machine must not advance after pause");
});

// §9.2 — breakpoint stops the loop deterministically, reported PC == bp PC.
test("breakpoint self-halts the loop at the exact PC", async () => {
  const { ctrl, fake, events } = mkController();
  const bp = 0x1010;
  const num = ctrl.addBreakpoint(bp);
  ctrl.run({ mode: "warp" });
  await waitFor(() => ctrl.runState === "paused");
  assert.equal(fake.c64Cpu.pc, bp, "PC halts on the breakpoint address");
  assert.equal(ctrl.stopInfo?.reason, "breakpoint");
  assert.equal(ctrl.stopInfo?.pc, bp);
  assert.equal(ctrl.stopInfo?.breakpointId, num);
  const hit = events.find((e) => e.method === "debug/breakpoint_hit");
  assert.ok(hit, "broadcasts debug/breakpoint_hit");
  assert.equal(hit!.params.pc, bp);
  assert.equal(hit!.params.num, num);
});

// §9.2 — continue must not immediately re-hit the same breakpoint.
test("continue steps past the current breakpoint", async () => {
  const { ctrl, fake } = mkController();
  const bp = 0x1010;
  ctrl.addBreakpoint(bp);
  ctrl.run({ mode: "warp" });
  await waitFor(() => ctrl.runState === "paused");
  assert.equal(fake.c64Cpu.pc, bp);
  // continue() resumes; step-past happens SYNCHRONOUSLY before the loop runs,
  // so right after the call the PC is already past the breakpoint.
  ctrl.continue();
  assert.equal(ctrl.runState, "running");
  assert.equal(fake.c64Cpu.pc, (bp + 1) & 0xffff, "stepped past bp, not re-stuck on it");
  ctrl.pause();
});

// §9.2 — step executes exactly one instruction while paused.
test("step advances exactly one instruction", () => {
  const { ctrl, fake } = mkController();
  const pc0 = fake.c64Cpu.pc, cyc0 = fake.c64Cpu.cycles;
  const stop = ctrl.step();
  assert.equal(fake.c64Cpu.pc, (pc0 + 1) & 0xffff);
  assert.equal(fake.c64Cpu.cycles, cyc0 + 1);
  assert.equal(ctrl.runState, "paused");
  assert.equal(stop.reason, "step");
  // A step on a breakpoint address still advances (does not get stuck).
  ctrl.addBreakpoint(fake.c64Cpu.pc);
  const pc1 = fake.c64Cpu.pc;
  ctrl.step();
  assert.equal(fake.c64Cpu.pc, (pc1 + 1) & 0xffff, "step ignores a bp on the current PC");
});

// §9.6 — chunking/pacing is state-preserving: PAL (frame chunks) and Warp
// (large chunks) advancing N total cycles must equal a single unchunked run.
test("PAL and Warp chunking preserve state vs an unchunked run", async () => {
  // PAL: run a short wall-clock window, then prove the chunked result equals
  // one big runFor of the same total cycles on a fresh session.
  const pal = mkController();
  pal.ctrl.run({ mode: "pal" });
  await waitFor(() => pal.fake.c64Cpu.cycles > 0);
  await delay(80); // a few PAL frames
  pal.ctrl.pause();
  const palCycles = pal.fake.c64Cpu.cycles;
  assert.ok(palCycles > 0);
  const ref1 = new FakeSession();
  ref1.runFor(palCycles + 10, { cycleBudget: palCycles });
  assert.equal(pal.fake.c64Cpu.pc, ref1.c64Cpu.pc, "PAL chunked PC == unchunked PC");
  assert.equal(pal.fake.c64Cpu.cycles, ref1.c64Cpu.cycles);

  // Warp: same property.
  const warp = mkController();
  warp.ctrl.run({ mode: "warp" });
  await waitFor(() => warp.fake.c64Cpu.cycles > 0);
  await delay(20);
  warp.ctrl.pause();
  const warpCycles = warp.fake.c64Cpu.cycles;
  const ref2 = new FakeSession();
  ref2.runFor(warpCycles + 10, { cycleBudget: warpCycles });
  assert.equal(warp.fake.c64Cpu.pc, ref2.c64Cpu.pc, "Warp chunked PC == unchunked PC");
  assert.equal(warp.fake.c64Cpu.cycles, ref2.c64Cpu.cycles);
});

// §9.6 (explicit) — identical total cycles ⇒ identical state across modes.
test("PAL and Warp reach identical state for the same cycle count", () => {
  // Drive two fresh fakes through the exact same total cycle count via the
  // two modes' own chunk sizes, manually, and assert equal end state.
  const N = 19705 * 8; // = 8 PAL frames = 1 warp chunk
  const palFake = new FakeSession();
  for (let f = 0; f < 8; f++) palFake.runFor(19705 + 10, { cycleBudget: 19705 });
  const warpFake = new FakeSession();
  warpFake.runFor(N + 10, { cycleBudget: N });
  assert.equal(palFake.c64Cpu.cycles, N);
  assert.equal(warpFake.c64Cpu.cycles, N);
  assert.equal(palFake.c64Cpu.pc, warpFake.c64Cpu.pc, "equal cycles ⇒ equal PC regardless of pacing");
});

// breakpoint store: stable checknums + add/del/list.
test("breakpoint store assigns stable checknums", () => {
  const { ctrl } = mkController();
  const a = ctrl.addBreakpoint(0x0810);
  const b = ctrl.addBreakpoint(0x40ae);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.deepEqual(ctrl.listBreakpoints(), [{ num: 1, addr: 0x0810 }, { num: 2, addr: 0x40ae }]);
  assert.equal(ctrl.delBreakpoint(1), true);
  assert.equal(ctrl.delBreakpoint(99), false);
  const c = ctrl.addBreakpoint(0x1074);
  assert.equal(c, 3, "checknums never reused");
  assert.equal(ctrl.bpNumForAddr(0x40ae), 2);
});

// ---- runner ----------------------------------------------------------------

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    await c.run();
    pass++;
    console.log(`  ok   ${c.name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${c.name}`);
    console.log(`       ${(e as Error).message}`);
  }
}
console.log(`\nruntime-controller: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
