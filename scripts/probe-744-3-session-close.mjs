// BUG-027 Blocker 3 / Spec 744.3 — closing a session stops the RuntimeController
// run loop so it no longer pegs a CPU core, and frees the session. The idle ~100%
// CPU was an orphaned controller: stopIntegratedSession only deleted the session
// from the map and left the controller's scheduled tick (setImmediate/setTimeout)
// ticking forever. The close path must dispose the controller (cancel the loop).
import { startIntegratedSession, stopIntegratedSession, getIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { ensureRuntimeController, getRuntimeController, disposeRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 744.3 — runtime_session_close stops the run loop + frees the session\n");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = ensureRuntimeController(sessionId, session, () => {});

// Start the autonomous run loop (the state that pegs the core when left running).
ctrl.run();
ok(ctrl.runState === "running", "controller running after run()", ctrl.runState);
ok(getRuntimeController(sessionId) === ctrl, "controller is registered");

// ---- Close: dispose the controller (cancels the scheduled tick) + drop session.
if (ctrl.traceRun?.isActive?.()) await ctrl.traceRun.stop();
disposeRuntimeController(sessionId);
const removed = stopIntegratedSession(sessionId);

ok(ctrl.runState === "stopped", "dispose stopped the controller (run loop cancelled)", ctrl.runState);
ok(getRuntimeController(sessionId) === undefined, "controller removed from registry (no orphan loop)");
ok(getIntegratedSession(sessionId) === undefined, "session removed from registry");
ok(removed === true, "stopIntegratedSession reported removal");

// A tick after dispose must be inert (runState guards it) — no further work.
let threw = null;
try { ctrl.tick?.(); } catch (e) { threw = e.message; }
ok(!threw && ctrl.runState === "stopped", "tick after dispose is a no-op (stays stopped)", threw || "inert");

// Idempotent: closing again must not throw and reports nothing to remove.
let threw2 = null;
try { disposeRuntimeController(sessionId); } catch (e) { threw2 = e.message; }
const removed2 = stopIntegratedSession(sessionId);
ok(!threw2, "second dispose is idempotent (no throw)", threw2 || "ok");
ok(removed2 === false, "second stop reports already-gone", String(removed2));

console.log(`\nSpec 744.3: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
