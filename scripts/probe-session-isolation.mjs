#!/usr/bin/env node
// GATE (docs/headless-runtime-singleton-audit.md) — one-machine-per-process.
//
// The runtime core is single-machine-per-process: the literal-port VIC is a
// module-global singleton (vicii-types.ts:335) and the vice1541 drive stack uses
// module-global hooks. Constructing a SECOND IntegratedSession in one process
// rebinds those globals (setFetchHost/setIrqHost + vicii.regs, last-writer-wins)
// and corrupts the first session's rendering — the user's "LLM-started session
// renders black in the UI; ui.sh restart fixes it" bug.
//
// FIX (Option A): the product session authority `runtimeSessions.start()` does
// NOT build a second machine — it ATTACHES to the existing one (shared-attach).
// This gate asserts that contract (PART 1) and documents the underlying hazard
// the guard protects against (PART 2, informational).
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession, listIntegratedSessions } =
  await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { runtimeSessions } = await import(`${D}/runtime/headless/runtime-session-service.js`);

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

function renderSig(session, tag) {
  const path = `/tmp/iso-${tag}.png`;
  session.renderToPng(path, {});
  const img = PNG.sync.read(readFileSync(path));
  const counts = new Map();
  for (let y = 24; y < 90; y++) for (let x = 20; x < 364; x++) {
    const o = (y * img.width + x) * 4;
    const k = `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { bg: top[0]?.[0] ?? "", fg: top[1]?.[0] ?? "", sig: top.slice(0, 3).map(([c, n]) => `${c}x${n}`).join("|") };
}
const OPTS = { mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" };

// ============================================================================
// PART 1 — PRODUCT CONTRACT (the fix): runtimeSessions.start attaches, never
// builds a second machine. THIS is the gate.
// ============================================================================
console.log("PART 1 — product contract (runtimeSessions.start = one machine per process):");
const a = runtimeSessions.start(OPTS);
gate("first start CONSTRUCTS a machine (attached=false)", a.attached === false);
a.session.resetCold("pal-default");
a.session.runFor(4_000_000, { cycleBudget: 4_000_000 });
const a1 = renderSig(a.session, "P1A1");
gate("session A boots to a non-empty text screen", a1.fg !== "" && a1.bg !== "", a1.sig);

const b = runtimeSessions.start(OPTS);
gate("second start ATTACHES (attached=true)", b.attached === true);
gate("second start returns the SAME machine (same session id)", b.sessionId === a.sessionId, `${a.sessionId} vs ${b.sessionId}`);
gate("exactly ONE machine in the process", listIntegratedSessions().length === 1, `${listIntegratedSessions().length}`);

// run A forward — it must be UNCHANGED (no second machine ever clobbered it)
a.session.runFor(100_000, { cycleBudget: 100_000 });
const a2 = renderSig(a.session, "P1A2");
gate("session A render UNCHANGED after the second start (no corruption)",
  a1.bg === a2.bg && a1.fg === a2.fg, `A1=${a1.sig}  A2=${a2.sig}`);
await runtimeSessions.close(a.sessionId);

// ============================================================================
// PART 2 — HAZARD DEMONSTRATION (informational, not gated): the RAW low-level
// primitive startIntegratedSession is unguarded by design — calling it twice in
// one process IS the corruption the product guard above prevents. Do NOT call
// startIntegratedSession twice in product code; go through runtimeSessions.start.
// ============================================================================
console.log("\nPART 2 — hazard the guard protects against (raw startIntegratedSession ×2, informational):");
const ra = startIntegratedSession(OPTS);
ra.session.resetCold("pal-default");
ra.session.runFor(4_000_000, { cycleBudget: 4_000_000 });
const ra1 = renderSig(ra.session, "P2A1");
const rb = startIntegratedSession(OPTS); // second RAW machine — rebinds the global VIC
rb.session.resetCold("pal-default");
rb.session.c64Bus.write(0xd021, 0x00); // B background -> black
rb.session.runFor(200_000, { cycleBudget: 200_000 });
ra.session.runFor(100_000, { cycleBudget: 100_000 });
const ra2 = renderSig(ra.session, "P2A2");
const corrupted = !(ra1.bg === ra2.bg && ra1.fg === ra2.fg);
console.log(`  ${corrupted ? "demonstrated" : "not-reproduced"}: raw ×2 ${corrupted ? "CORRUPTS" : "did not corrupt"} the first machine` +
  ` (A1.bg=${ra1.bg} -> A2.bg=${ra2.bg}) — this is why product code must use runtimeSessions.start`);
stopIntegratedSession(ra.sessionId);
stopIntegratedSession(rb.sessionId);

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
