// Spec 743.4 — Inspector/Frozen-overlay + checkpoint do not poison the live clock
// domain (BUG-025 acceptance), and checkpoint capture/restore preserves the
// monotonic CLOCK without truncation. Separate backend — NOT the live UI port.
//
// NOTE on "force clk near 2^32": directly setting c64Cpu.cycles to ~0xFFFFFFFF is
// an INVALID test — it jumps clk ~2.6e9 cycles forward while leaving every already
// armed alarm stranded at the old (boot) clk, so drainAlarms spins regardless of
// the fix. A real run reaches 2^32 gradually with alarms continuously rescheduled
// ahead of clk. The per-chip "schedule at clk+delta stays monotonic past 2^32"
// proof lives in probe:743-1/2/3 (unit). This gate proves the live machine + the
// inspector/checkpoint path stay coherent and monotonic.
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { ensureRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const hex = (n) => "0x" + n.toString(16);
const clkOf = (s) => s.c64Cpu.cycles;            // raw monotonic — NO >>> 0
const nextPending = (s) => s.kernel.alarms?.maincpu?.next_pending_alarm_clk;

console.log("Spec 743.4 — inspector + checkpoint keep the clock domain coherent\n");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = ensureRuntimeController(sessionId, session, () => {});

let exit = 0;
try {
  session.runFor(400_000);
  const clkBoot = clkOf(session);
  ok(Number.isInteger(clkBoot) && clkBoot > 0, "boot: clk is a finite monotonic integer", hex(clkBoot));
  ok(clkBoot < nextPending(session), "boot: next-pending alarm is in the future (no stranded alarm)",
    `clk=${hex(clkBoot)} next=${hex(nextPending(session))}`);

  // ---- Inspector open: freezeWithProvenance (capture-on-freeze) + capture + pin
  ctrl.runState = "running";
  ctrl.freezeWithProvenance();
  const ref = await ctrl.captureCheckpoint();
  ctrl.checkpointRing.pin(ref.id);
  const clkCap = clkOf(session);
  ok(clkCap >= clkBoot, "inspector freeze advances clk monotonically", `${hex(clkBoot)} -> ${hex(clkCap)}`);

  // ---- Resume after inspect: monitor `g` equivalent. MUST NOT trip the guard.
  let tripped = null;
  try { ctrl.runState = "running"; session.runFor(40_000); } catch (e) { tripped = e.message; }
  ok(!tripped, "resume after inspector does NOT trip the alarm-dispatch guard (BUG-025)", tripped || "clean");
  ok(clkOf(session) > clkCap, "resume advances clk monotonically", hex(clkOf(session)));

  // ---- Checkpoint restore preserves the monotonic clk + alarm schedule exactly.
  session.runFor(120_000);
  const clkBeforeRestore = clkOf(session);
  await ctrl.restoreCheckpoint(ref.id);
  ok(clkOf(session) === clkCap, "restore returns clk to the captured value exactly (no truncation)",
    `before=${hex(clkBeforeRestore)} after=${hex(clkOf(session))} cap=${hex(clkCap)}`);
  ok(clkOf(session) < nextPending(session), "restore leaves alarms in the future (coherent)",
    `clk=${hex(clkOf(session))} next=${hex(nextPending(session))}`);
  let tripped2 = null;
  try { session.runFor(40_000); } catch (e) { tripped2 = e.message; }
  ok(!tripped2, "resume after restore does NOT trip the guard", tripped2 || "clean");

  // ---- Repeat inspector cycles (the real user repro: use overlay repeatedly).
  let tripped3 = null;
  try {
    for (let i = 0; i < 3; i++) {
      ctrl.runState = "running";
      ctrl.freezeWithProvenance();
      const r = await ctrl.captureCheckpoint();
      ctrl.checkpointRing.pin(r.id);
      ctrl.runState = "running";
      session.runFor(30_000);
    }
  } catch (e) { tripped3 = e.message; }
  ok(!tripped3, "3x inspector freeze/capture/resume cycles stay clean", tripped3 || "clean");
  ok(Number.isInteger(clkOf(session)), "clk stays a finite integer throughout", hex(clkOf(session)));
} catch (e) {
  console.error("FATAL", e.message); exit = 2;
} finally {
  stopIntegratedSession(sessionId);
}

console.log(`\nSpec 743.4: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
