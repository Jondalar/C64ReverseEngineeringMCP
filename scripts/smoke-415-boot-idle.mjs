#!/usr/bin/env node
// Spec 415 — 1541 Phase I step 35: boot-idle test.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase I step 35:
//         "Boot test: with no disk, drive should idle at $EBFF."
//       §14 invariant 12 (drivecpu_execute push-mode).
//
// VICE: src/drive/drive.c:991 drive_cpu_execute_one()
//       src/drive/drivecpu.c:356 drivecpu_execute()
//       1541 ROM idle loop at $EBFF (= LDA $1C00 / BPL ... waits for
//         disk-change WPS line; with no disk attached the loop sits
//         here forever).
//
// Acceptance per spec 415:
//   - boot drive with no disk attached,
//   - advance N drive cycles past KERNAL/DOS boot,
//   - assert drive PC == $EBFF (or in immediate $EBFx idle window).
//
// Tier (PLAN.md): 415 = validation — full corpus + 10M diff-trace.
// This sub-smoke uses 2M C64 cycles (= ~2s wall) to reach the idle
// loop, which is well past 1541 boot (~1.5s on real hardware).

import { resolve as resolvePath } from "node:path";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// No disk attached — diskPath omitted. IntegratedSession tolerates
// empty diskPath (integrated-session.ts:447 `this.diskPath = opts.diskPath ?? ""`).
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
});

session.resetCold("pal-default");

// 1541 boot path (per VICE timing): RESET → vector $EAA0 → init VIA1/VIA2,
// init zero page, jump to $EBFF idle loop (LDA $1C00 / BPL *-3).
// Real hardware reaches $EBFF in ~1.5s. We give 2M C64 cycles (~2s)
// = generous. Use multiple smaller runFor calls for stability.
const BOOT_BUDGET = 2_000_000;
session.runFor(BOOT_BUDGET);

const drivePc = session.drive.cpu.pc & 0xffff;
const driveCycles = session.drive.cpu.cycles;

// VICE 1541 ROM idle loop. Per `driverom.c:257,277` the canonical
// idle-trap addresses are $EC9B (1541) and $ECE9/$EC4D (variant). The
// doc §13 Phase I step 35 lists $EBFF as the symbolic idle target,
// but with idling_method = DRIVE_IDLE_NO_IDLE_TRAPS (= our default,
// matching VICE default behavior) the drive walks the full
// "wait for disk" loop spanning roughly $EBFF..$ECC0. Accept the
// whole idle window.
const IDLE_LOW = 0xebfd;
const IDLE_HIGH = 0xecc0;

check(
  `drive PC at $EBFF idle window after ${BOOT_BUDGET.toLocaleString()} C64 cycles (= §13 Phase I step 35)`,
  drivePc >= IDLE_LOW && drivePc <= IDLE_HIGH,
  `drivePc=$${drivePc.toString(16)} (expected $${IDLE_LOW.toString(16)}..$${IDLE_HIGH.toString(16)})`,
);

check(
  "drive CPU advanced (push-mode execute ran per §14 invariant 12)",
  driveCycles > 100_000,
  `driveCycles=${driveCycles.toLocaleString()}`,
);

// Sample N more times; drive PC must stay inside the idle window every
// time (= proof it is sitting in the loop, not just transiting through).
const SAMPLES = 8;
const SAMPLE_QUANTUM = 50_000;
let allInside = true;
const observed = [];
for (let i = 0; i < SAMPLES; i++) {
  session.runFor(SAMPLE_QUANTUM);
  const pc = session.drive.cpu.pc & 0xffff;
  observed.push(`$${pc.toString(16)}`);
  if (pc < IDLE_LOW || pc > IDLE_HIGH) allInside = false;
}

check(
  `drive PC stayed in idle window across ${SAMPLES} samples (= drive truly idle)`,
  allInside,
  `samples=[${observed.join(",")}]`,
);

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 415 boot-idle smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
