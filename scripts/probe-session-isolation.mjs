#!/usr/bin/env node
// AUDIT GATE (headless-runtime-singleton-audit.md, Befund A) — proves that the
// headless runtime is SINGLE-MACHINE-PER-PROCESS hiding under a multi-session
// API: constructing a SECOND IntegratedSession in the same process rebinds the
// process-global literal-port VIC (vicii-types.ts:335 singleton + setFetchHost/
// setIrqHost last-writer-wins, integrated-session.ts:1192/1224) onto session B,
// so session A — untouched by the user — renders corrupted afterwards. This is
// the user's "LLM-started session looks different in the UI; ui.sh restart
// fixes it" bug.
//
// STATUS TODAY: RED (corruption reproduced = bug documented).
// ACCEPTANCE once a remediation lands (Option A: one machine per process):
//   session A's render is BYTE-IDENTICAL before and after session B is built.
//   Flip EXPECT_ISOLATED=1 to assert the fixed contract.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);

const EXPECT_ISOLATED = process.env.EXPECT_ISOLATED === "1";
const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

const NEW = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });

function renderHist(session, tag) {
  const path = `/tmp/iso-${tag}.png`;
  session.renderToPng(path, {});
  const img = PNG.sync.read(readFileSync(path));
  // dominant colors in the text band (rows ~24..90 of the 384x272 crop)
  const counts = new Map();
  for (let y = 24; y < 90; y++) for (let x = 20; x < 364; x++) {
    const o = (y * img.width + x) * 4;
    const k = `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { bg: top[0]?.[0] ?? "", fg: top[1]?.[0] ?? "", signature: top.slice(0, 3).map(([c, n]) => `${c}x${n}`).join("|") };
}

// --- Session A: boot to READY, capture its correct render ----------------------
const a = NEW();
a.session.resetCold("pal-default");
a.session.runFor(4_000_000, { cycleBudget: 4_000_000 });
const a1 = renderHist(a.session, "A1");
gate("session A boots to a non-empty text screen", a1.fg !== "" && a1.bg !== "", a1.signature);

// --- Session B: construct a SECOND machine in the SAME process -----------------
// Its constructor (installLiteralPortRenderer → setFetchHost/setIrqHost +
// vicii.regs = B.vic.regs) rebinds the process-global VIC onto B.
const b = NEW();
b.session.resetCold("pal-default");
// Make B visually distinct: background -> black ($D021 = 0). If the global VIC
// is shared, this bleeds into A's next render.
b.session.c64Bus.write(0xd021, 0x00);
b.session.runFor(200_000, { cycleBudget: 200_000 });

// --- Re-render session A — it was NOT touched by the user ----------------------
a.session.runFor(100_000, { cycleBudget: 100_000 }); // one+ frame through the (now B-bound) global VIC
const a2 = renderHist(a.session, "A2");

const identical = a1.bg === a2.bg && a1.fg === a2.fg;
if (EXPECT_ISOLATED) {
  gate("FIXED CONTRACT: session A render unchanged after building session B", identical,
    `A1=${a1.signature}  A2=${a2.signature}`);
} else {
  gate("BUG REPRODUCED: session A render CORRUPTED after building session B (not isolated)", !identical,
    `A1.bg=${a1.bg} A1.fg=${a1.fg} -> A2.bg=${a2.bg} A2.fg=${a2.fg}`);
}

stopIntegratedSession(a.sessionId);
stopIntegratedSession(b.sessionId);
console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
console.log(EXPECT_ISOLATED
  ? "(asserting the FIXED single-machine-per-process contract)"
  : "(asserting the BUG is present — run with EXPECT_ISOLATED=1 after the fix lands)");
process.exit(failures.length ? 1 : 0);
