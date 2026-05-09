#!/usr/bin/env node
// Spec 293 — VIC-II light pen smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const lp = await import(`${REPO}/dist/runtime/headless/vic/light-pen.js`);
const irq = await import(`${REPO}/dist/runtime/headless/vic/vic-irq.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 293 light pen smoke ===\n");

const s = lp.createLightPenState();
const i = irq.createVicIrqState();

// 1. Initial state.
check("init: x=0", s.x === 0);
check("init: y=0", s.y === 0);
check("init: !triggered", !s.triggered);

// 2. First trigger latches + sets LP IRQ flag.
const ok1 = lp.triggerLightPen(s, i, 100, 150);
check("first trigger returns true", ok1);
check("x latched = 100", s.x === 100);
check("y latched = 150", s.y === 150);
check("triggered=true after trigger", s.triggered);
check("LP IRQ bit 3 set in $D019",
  (i.status & irq.VICII_IRQ_LIGHTPEN) !== 0);

// 3. Read returns latched, doesn't clear.
const r13 = lp.readD013(s);
check("readD013 = 100", r13 === 100);
const r14 = lp.readD014(s);
check("readD014 = 150", r14 === 150);
check("after read: still triggered", s.triggered);

// 4. Second trigger same frame ignored.
const ok2 = lp.triggerLightPen(s, i, 200, 250);
check("second trigger returns false (= one-shot)", !ok2);
check("x still 100 (not 200)", s.x === 100);

// 5. resetLightPenLatch allows re-trigger.
lp.resetLightPenLatch(s);
check("after reset: !triggered", !s.triggered);
const ok3 = lp.triggerLightPen(s, i, 200, 250);
check("after reset: trigger fires again", ok3);
check("x = 200 now", s.x === 200);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
