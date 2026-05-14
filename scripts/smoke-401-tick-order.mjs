#!/usr/bin/env node
// Spec 401 — Tick-order smoke.
//
// Doctrine: 1:1 VICE x64sc port. This smoke proves that the CPU's
// per-cycle CLK_INC equivalent (= Cpu65xxVice.tick()) drains alarms in
// the canonical VICE order described in docs/vice-c64-arch.md §11
// step 1.a + §13 invariant 1.
//
// Test pattern (per spec 401 acceptance + refinement Q9):
//   1. Build a Cpu65xxVice with an alarm context.
//   2. Schedule an alarm at clk = TARGET.
//   3. Load a NOP loop in synthetic RAM at PC=$0200 (the alarm itself
//      is fired by tick()'s drain hook, not by any instruction).
//   4. executeCycle() until the alarm fires; capture clk-at-fire.
//   5. Assert clk_fire == TARGET (= alarm-drain runs BEFORE clk++,
//      so the dispatch happens at the SAME cycle as the assert clk,
//      not at clk + 1).
//
// VICE source cite: src/mainc64cpu.c:97-110 `interrupt_delay()` runs
// `while (maincpu_clk >= alarm_context_next_pending_clk(...)) dispatch`
// BEFORE the CLK_INC's `maincpu_clk++` (c64cpusc.c:47). The alarm
// callback's `cpuClk` parameter reflects the cycle at which dispatch
// fired.
//
// Smoke is intentionally CPU-only (no CIA / VIC) so it isolates the
// foundation primitive. CIA-driven IRQ alignment is covered by
// smoke-cia-fidelity (22/22).

import {
  alarm_context_new,
  alarm_new,
  alarm_set,
  alarm_unset,
} from "../dist/runtime/headless/alarm/alarm-context.js";
import { Cpu65xxVice } from "../dist/runtime/headless/cpu/cpu65xx-vice.js";

// --- Tracing memory: minimal CpuMemory shim. ---
function makeRam() {
  const ram = new Uint8Array(0x10000);
  return {
    ram,
    read(a) { return ram[a & 0xffff]; },
    write(a, v) { ram[a & 0xffff] = v & 0xff; },
  };
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// ---------------- Test 1: alarm fires at exact clk ----------------
//
// Schedule alarm at TARGET = 50. After fewer than 50 cycles, alarm
// must NOT have fired. After exactly enough cycles to reach clk=50,
// alarm fires inside tick() BEFORE the clk++ on that cycle, so the
// callback observes cpuClk == 50.
{
  const ctx = alarm_context_new("smoke-401-target");
  const mem = makeRam();
  // PC=$0200 is a NOP infinite loop ($EA $EA ... = NOP, NOP, ...).
  // NOP = 2 cycles each (opcode fetch + implied dummy).
  for (let i = 0x0200; i < 0x0300; i++) mem.ram[i] = 0xea;
  // Reset vector at $FFFC/$FFFD points to $0200 (in case caller's
  // reset() reads the vector).
  mem.ram[0xfffc] = 0x00;
  mem.ram[0xfffd] = 0x02;

  // Callback receives `offset` = (cpu_clk_at_dispatch - alarm_assert_clk)
  // per VICE alarm.h callback contract. fire-clk = TARGET + offset.
  const fireLog = []; // {offset, cpuClkAtFire}
  let alarmRef = null;
  let cpuRef = null;
  const alarm = alarm_new(ctx, "test-alarm", (offset, _data) => {
    fireLog.push({ offset, cpuClkAtFire: cpuRef ? cpuRef.clk : -1 });
    if (alarmRef) alarm_unset(alarmRef);
  }, null);
  alarmRef = alarm;

  const cpu = new Cpu65xxVice({ memBus: mem, alarmContext: ctx });
  cpuRef = cpu;
  cpu.reset(0x0200);
  cpu.flags = 0x20; // I clear

  const TARGET = 50;
  alarm_set(alarm, TARGET);

  // Run enough cycles to comfortably pass TARGET. With per-cycle
  // alarm drain (Cpu65xxVice.perCycleAlarmDrain=true) the dispatch
  // lands on the cycle equal to TARGET. With the legacy opcode-
  // boundary drain (=false), the dispatch lands at the next opcode
  // boundary at or after TARGET (= ≤ TARGET + 1 since NOP = 2 cyc).
  for (let i = 0; i < 100; i++) {
    cpu.executeCycle();
    if (fireLog.length > 0) break;
  }

  check("alarm fired at least once", fireLog.length >= 1,
    `fireLog=${JSON.stringify(fireLog)}`);

  if (fireLog.length >= 1) {
    const { offset, cpuClkAtFire } = fireLog[0];
    if (Cpu65xxVice.perCycleAlarmDrain) {
      // 1:1 VICE x64sc: drain on every CLK_INC; the dispatch happens
      // when clk first reaches TARGET — offset = 0.
      check(
        "VICE-faithful: alarm offset=0 at fire (per-cycle drain)",
        offset === 0,
        `offset=${offset} cpuClkAtFire=${cpuClkAtFire} TARGET=${TARGET}`,
      );
      check(
        "VICE-faithful: cpu.clk == TARGET at fire (drain BEFORE clk++)",
        cpuClkAtFire === TARGET,
        `cpuClkAtFire=${cpuClkAtFire} TARGET=${TARGET}`,
      );
    } else {
      // Legacy opcode-boundary drain: alarm fires at the next opcode
      // boundary at or after clk=TARGET. NOP = 2 cycles → boundaries at
      // 0, 2, 4, ..., 50, 52. Offset = (cpu_clk_at_boundary - TARGET) is
      // small but non-negative. cpu_clk_at_fire is whatever clk the
      // boundary check ran at.
      check(
        "opcode-boundary drain: offset >= 0 (alarm not fired before TARGET)",
        offset >= 0 && offset <= 2,
        `offset=${offset} cpuClkAtFire=${cpuClkAtFire} TARGET=${TARGET}`,
      );
      check(
        "opcode-boundary drain: cpu.clk at fire == TARGET + offset",
        cpuClkAtFire === TARGET + offset,
        `cpuClkAtFire=${cpuClkAtFire} TARGET=${TARGET} offset=${offset}`,
      );
    }
  }
}

// ---------------- Test 2: alarm scheduled in the past dispatches immediately ----------------
//
// VICE: an alarm scheduled with clk < current maincpu_clk fires on the
// next CLK_INC (drain loop fires it). This must hold in our port too.
{
  const ctx = alarm_context_new("smoke-401-past");
  const mem = makeRam();
  for (let i = 0x0200; i < 0x0300; i++) mem.ram[i] = 0xea;
  mem.ram[0xfffc] = 0x00; mem.ram[0xfffd] = 0x02;
  const fireLog = [];
  let pastAlarmRef = null;
  let pastCpuRef = null;
  const alarm = alarm_new(ctx, "past-alarm", (offset, _data) => {
    fireLog.push({ offset, cpuClkAtFire: pastCpuRef ? pastCpuRef.clk : -1 });
    if (pastAlarmRef) alarm_unset(pastAlarmRef);
  }, null);
  pastAlarmRef = alarm;

  const cpu = new Cpu65xxVice({ memBus: mem, alarmContext: ctx });
  pastCpuRef = cpu;
  cpu.reset(0x0200);
  cpu.flags = 0x20;
  // Advance clock a bit before scheduling.
  for (let i = 0; i < 10; i++) cpu.executeCycle();
  const clkAtSchedule = cpu.clk;
  // Schedule in the past (= clk already elapsed). VICE drains as soon
  // as `maincpu_clk >= next_pending_alarm_clk`, so this should fire
  // on the next CLK_INC. The offset == clkAtSchedule - 5 - assertClk
  // and the cpu clk at fire reflects when the next drain ran.
  const PAST = clkAtSchedule - 5;
  alarm_set(alarm, PAST);

  // One more cycle should drain it (per-cycle drain) or the next opcode
  // boundary (boundary drain). Either way, ≤ 2 more cycles.
  cpu.executeCycle();
  if (fireLog.length === 0) cpu.executeCycle();
  check(
    "past-clk alarm fires within two CLK_INCs",
    fireLog.length === 1,
    `fireLog=${JSON.stringify(fireLog)} PAST=${PAST}`,
  );
  if (fireLog.length === 1) {
    const { offset, cpuClkAtFire } = fireLog[0];
    check(
      "past-clk alarm: offset = (cpuClkAtFire - PAST), drain at first eligible CLK_INC",
      offset === cpuClkAtFire - PAST && offset >= 0,
      `offset=${offset} cpuClkAtFire=${cpuClkAtFire} PAST=${PAST}`,
    );
  }
}

// ---------------- Test 3: maincpu_ba_low_flags exists + reader returns false by default ----------------
//
// Spec 401 / OQ-400-Q3 — the field is added but VIC-II is not yet wired
// to write it (spec 404). For spec 401 the reader must exist and return
// `false` (= no BA-low). VIC-II writer comes in spec 404 Phase D.
{
  const mem = makeRam();
  const cpu = new Cpu65xxVice({ memBus: mem });
  check(
    "maincpu_ba_low_flags field is present and zero",
    cpu.maincpu_ba_low_flags === 0,
    `maincpu_ba_low_flags=${cpu.maincpu_ba_low_flags}`,
  );
  check(
    "baLowVicii() reader returns false (no BA-low when VIC unwired)",
    cpu.baLowVicii() === false,
  );
  check(
    "MAINCPU_BA_LOW_VICII constant exposed",
    Cpu65xxVice.MAINCPU_BA_LOW_VICII === 0x01,
    `value=${Cpu65xxVice.MAINCPU_BA_LOW_VICII}`,
  );
  check(
    "MAINCPU_BA_LOW_REU constant exposed",
    Cpu65xxVice.MAINCPU_BA_LOW_REU === 0x02,
    `value=${Cpu65xxVice.MAINCPU_BA_LOW_REU}`,
  );
}

// ---------------- Report ----------------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 401 tick-order smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
console.log(
  `note: perCycleAlarmDrain=${Cpu65xxVice.perCycleAlarmDrain} ` +
  `(spec 401 / OQ-401-1; toggle in cpu65xx-vice.ts to switch drain mode)`,
);
process.exit(failed > 0 ? 1 : 0);
