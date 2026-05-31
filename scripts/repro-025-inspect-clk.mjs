// BUG-025 repro (separate backend, NOT the live UI port). Reproduce the
// Inspector/Frozen overlay poisoning Pause/Run resume:
//   Cpu65xxVice: alarm-dispatch guard tripped at clk=4294952194 (ctx=maincpu)
// Mirror the WS path: freezeWithProvenance (capture-on-freeze) + captureCheckpoint,
// then resume (runFor). Instrument c64Cpu.cycles (= maincpu clk) at every phase.
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { ensureRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const U32 = 0xffffffff >>> 0;
const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
const clkOf = (s) => s.c64Cpu.cycles >>> 0;

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = ensureRuntimeController(sessionId, session, () => {});

function dumpAlarms(tag) {
  const k = session.kernel;
  const ac = k.alarms?.maincpu;
  if (!ac) { console.log(`  [${tag}] no maincpu alarm context`); return; }
  const pend = [];
  for (let i = 0; i < ac.num_pending_alarms; i++) {
    const p = ac.pending_alarms[i];
    if (p) pend.push(`${p.alarm.name}@${hex(p.clk)}`);
  }
  console.log(`  [${tag}] clk=${hex(clkOf(session))} nextPending=${hex(ac.next_pending_alarm_clk)} numPending=${ac.num_pending_alarms}`);
  console.log(`        pending: ${pend.join(", ") || "(none)"}`);
}

try {
  // Boot a while so KERNAL + CIA alarms are live.
  session.runFor(400_000);
  console.log("\n== after boot ==");
  dumpAlarms("boot");
  const clkBoot = clkOf(session);

  // Mirror WS vic/inspect/open: freezeWithProvenance (needs runState running).
  ctrl.runState = "running";
  console.log("\n== freezeWithProvenance ==");
  ctrl.freezeWithProvenance();
  dumpAlarms("post-freeze");
  const clkFreeze = clkOf(session);

  console.log("\n== captureCheckpoint ==");
  const ref = await ctrl.captureCheckpoint();
  ctrl.checkpointRing.pin(ref.id);
  dumpAlarms("post-capture");
  const clkCap = clkOf(session);

  // Resume: this is monitor `g` / debug/continue → run loop → drainAlarms.
  console.log("\n== resume (runFor) ==");
  let tripped = null;
  try {
    session.runFor(40_000);
  } catch (e) { tripped = e.message; }
  dumpAlarms("post-resume");

  console.log("\n== summary (freeze+capture only) ==");
  console.log(`  clk boot=${hex(clkBoot)} freeze=${hex(clkFreeze)} capture=${hex(clkCap)} now=${hex(clkOf(session))}`);
  if (tripped) console.log(`  *** GUARD TRIPPED: ${tripped}`);

  // ---- Now test the RESTORE path: restore the pinned checkpoint into the live
  // machine (rewind), then resume. This is the one mutation a "frozen overlay"
  // could trigger that rewinds clk + re-arms alarms.
  console.log("\n== restoreCheckpoint(pinned) then resume ==");
  session.runFor(120_000); // advance well past the checkpoint clk first
  console.log(`  before restore clk=${hex(clkOf(session))} (checkpoint clk=${hex(clkCap)})`);
  let trip2 = null;
  try {
    await ctrl.restoreCheckpoint(ref.id);
    dumpAlarms("post-restore");
    console.log(`  after restore clk=${hex(clkOf(session))}`);
    session.runFor(40_000);
  } catch (e) { trip2 = e.message; }
  dumpAlarms("post-restore-resume");
  if (trip2) console.log(`  *** GUARD TRIPPED on restore-resume: ${trip2}`);

  // ---- Multiple inspect cycles (open/at/close) on a running machine ----
  console.log("\n== 3x freeze+capture+resume cycles ==");
  let trip3 = null;
  try {
    for (let i = 0; i < 3; i++) {
      ctrl.runState = "running";
      ctrl.freezeWithProvenance();
      const r2 = await ctrl.captureCheckpoint();
      ctrl.checkpointRing.pin(r2.id);
      ctrl.runState = "running";
      session.runFor(30_000);
      console.log(`  cycle ${i}: clk=${hex(clkOf(session))}`);
    }
  } catch (e) { trip3 = e.message; }
  if (trip3) console.log(`  *** GUARD TRIPPED in cycles: ${trip3}`);

  const anyTrip = tripped || trip2 || trip3;
  console.log(`\n  REPRO(inspect) ${anyTrip ? "HIT" : "not hit"}: ${anyTrip || "clean"}`);

  // ---- ROOT-CAUSE PROOF: no clkguard → maincpu_clk wraps at 2^32. Force clk
  // near CLOCK_MAX (as a ~72-min session would reach) and run. An alarm armed at
  // u32(clk+delta) wraps below clk → drainAlarms spins → the exact guard error.
  console.log("\n== root-cause: force clk near 2^32 (no clkguard) ==");
  session.c64Cpu.cycles = (U32 - 0x4000) >>> 0; // 0xFFFFC000, the wrap zone
  console.log(`  forced clk=${hex(clkOf(session))}`);
  let trip4 = null;
  try { session.runFor(40_000); } catch (e) { trip4 = e.message; }
  console.log(`  ${trip4 ? "*** GUARD TRIPPED: " + trip4 : "no trip (clk=" + hex(clkOf(session)) + ")"}`);
  console.log(`\n  ROOT-CAUSE PROVEN: ${trip4 ? "YES — clk wrap with un-warped alarms" : "no"}`);
} finally {
  stopIntegratedSession(sessionId);
}
