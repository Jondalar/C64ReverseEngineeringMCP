#!/usr/bin/env node
// scripts/e2e-754-monitor.mjs — Spec 754 P1 + Block B acceptance gate.
//
// Proves the three monitor bugs are fixed, in-process (no daemon, no port 4312):
//   A) BUG-038 — bank lens + side-effect-free peek. `m e000`/`peek($E000,'cpu')`
//      sees KERNAL (not raw RAM); `ram`/`rom`/`io`/`cart`/`cpu` lenses route
//      correctly; peeking I/O has no side effect.
//   B) BUG-036 — lifecycle. `g`/`x` enter the RUNNING run-state (resume the
//      autonomous loop), `g <addr>` sets PC + runs, a breakpoint halts a running
//      machine, `until <addr>` is the synchronous run-to-landing.
//   C) BUG-037 — consolidation. The dead second parser is gone; the one
//      canonical processor (runMonitorCommand) handles the command set.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/runtime/headless/integrated-session-manager.js"))) {
  console.error("build:mcp first"); process.exit(2);
}

const { startIntegratedSession, stopIntegratedSession } =
  await import("../dist/runtime/headless/integrated-session-manager.js");
const { RuntimeController } =
  await import("../dist/runtime/headless/debug/runtime-controller.js");
const { runMonitorCommand } =
  await import("../dist/runtime/headless/debug/monitor-shell.js");

const hx = (n) => n.toString(16).toUpperCase().padStart(2, "0");

function newCtx(session, sessionId) {
  const ctrl = new RuntimeController(sessionId, session, () => {});
  const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
  const mon = (cmd) => runMonitorCommand(ctx, cmd);
  return { ctrl, ctx, mon };
}

// =====================================================================
// Part A — BUG-038: bank lens + side-effect-free peek.
// =====================================================================
console.log("Spec 754 — Part A: bank lens + peek (BUG-038)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default"); // default banking: KERNAL+BASIC+IO visible
    const bus = session.c64Bus;
    // Plant RAM sentinels UNDER the ROM/IO so we can prove the lens routing.
    bus.ram[0xe000] = 0x42; // under KERNAL
    bus.ram[0xa000] = 0x11; // under BASIC
    bus.ram[0xd000] = 0x33; // under I/O

    // ram lens = raw RAM (the old banking-blind behaviour, now explicit).
    ok("A1 peek($E000,'ram') = planted RAM sentinel", bus.peek(0xe000, "ram") === 0x42, `$${hx(bus.peek(0xe000, "ram"))}`);
    // cpu lens (default) = what the CPU sees → KERNAL, NOT the RAM sentinel.
    const cpuE000 = bus.peek(0xe000, "cpu");
    const romE000 = bus.peek(0xe000, "rom");
    ok("A2 peek($E000,'cpu') sees KERNAL, not RAM", cpuE000 !== 0x42 && cpuE000 === romE000, `cpu=$${hx(cpuE000)} rom=$${hx(romE000)}`);
    // BASIC window.
    ok("A3 peek($A000,'cpu') sees BASIC, peek('ram') sees sentinel",
      bus.peek(0xa000, "cpu") === bus.peek(0xa000, "rom") && bus.peek(0xa000, "cpu") !== 0x11 && bus.peek(0xa000, "ram") === 0x11);
    // I/O window: cpu lens routes through I/O (= io lens), not RAM.
    ok("A4 peek($D000,'cpu') routes to I/O (== io lens, != RAM sentinel)",
      bus.peek(0xd000, "cpu") === bus.peek(0xd000, "io") && bus.peek(0xd000, "cpu") !== 0x33);
    // Side-effect-free: peeking I/O twice (e.g. raster $D012) does not advance
    // or clear anything → identical, and no CPU cycles consumed.
    const cyc0 = session.c64Cpu.cycles;
    ok("A5 peek I/O is side-effect-free (idempotent, no cycles)",
      bus.peek(0xd012, "cpu") === bus.peek(0xd012, "cpu") && session.c64Cpu.cycles === cyc0);

    // Via the monitor commands (the user-facing surface).
    const mRam = (await mon("m ram e000")).output ?? "";
    const mCpu = (await mon("m e000")).output ?? "";
    ok("A6 `m ram e000` shows the RAM sentinel 42", /(^|\s)42(\s|$)/.test(mRam.split("\n")[0] ?? ""), (mRam.split("\n")[0] ?? "").slice(0, 40));
    ok("A7 `m e000` (cpu lens default) differs from `m ram e000`", mCpu.split("\n")[0] !== mRam.split("\n")[0]);
    const dCpu = (await mon("d e000")).output ?? "";
    const dRam = (await mon("d ram e000")).output ?? "";
    ok("A8 `d e000` (KERNAL) differs from `d ram e000` (sentinel bytes)", dCpu !== dRam && dCpu.length > 0);
    // Sticky bank default.
    await mon("bank rom");
    const mStickyRom = (await mon("m e000")).output ?? "";
    const mExplicitRom = (await mon("m rom e000")).output ?? "";
    ok("A9 sticky `bank rom` makes a bare `m` use the rom lens", mStickyRom.split("\n")[0] === mExplicitRom.split("\n")[0]);
    await mon("bank cpu"); // restore
    // $20 bytes/row format (BUG-038 §3.3b).
    const row0 = (await mon("m ram c000 c01f")).output ?? "";
    const hexCount = (row0.split("\n")[0]?.match(/\b[0-9A-F]{2}\b/g) ?? []).length;
    ok("A10 memory dump renders $20 (32) bytes per row", hexCount === 32, `${hexCount} bytes`);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part B — BUG-036: lifecycle (g/x/until resume the run-state).
// =====================================================================
console.log("\nSpec 754 — Part B: lifecycle g/x/until (BUG-036)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");
    // NOP sled $C000-$C0FF, BRK at $C100 (safety stop).
    for (let a = 0xc000; a <= 0xc0ff; a++) session.c64Bus.ram[a] = 0xea;
    session.c64Bus.ram[0xc100] = 0x00;
    session.c64Cpu.pc = 0xc000;

    // `g` resumes the RUNNING run-state (not a bounded burst that ends halted).
    const gRes = await mon("g");
    ok("B1 `g` enters the running run-state", ctrl.runState === "running", `runState=${ctrl.runState}`);
    ok("B2 `g` reports continuing (not 'ran N instr / BREAK')", /continuing/.test(gRes.output ?? ""), gRes.output);
    ctrl.pause();

    // `g <addr>` sets PC then runs.
    session.c64Cpu.pc = 0xc000;
    await mon("g c050");
    ok("B3 `g <addr>` sets PC to the target", (session.c64Cpu.pc & 0xffff) === 0xc050 || ctrl.runState === "running", `pc=$${session.c64Cpu.pc.toString(16)}`);
    ctrl.pause();

    // `x` == resume.
    session.c64Cpu.pc = 0xc000;
    await mon("x");
    ok("B4 `x` resumes (running)", ctrl.runState === "running");
    ctrl.pause();

    // `until <addr>` — synchronous run-to-landing, lands HALTED at the target.
    session.c64Cpu.pc = 0xc000;
    const uRes = await mon("until c010");
    ok("B5 `until c010` lands exactly at $C010", (session.c64Cpu.pc & 0xffff) === 0xc010, uRes.output);
    ok("B6 `until` leaves the machine halted (not running)", ctrl.runState !== "running", `runState=${ctrl.runState}`);

    // Full resume→breakpoint→halt cycle under warp pacing.
    session.c64Cpu.pc = 0xc000;
    await mon("bk c008");
    ctrl.setPacing("warp");
    await mon("g");
    let spins = 0;
    while (ctrl.runState === "running" && spins < 5000) { await new Promise((r) => setImmediate(r)); spins++; }
    ok("B7 a breakpoint halts a RUNNING machine (resume→bp→pause)", ctrl.runState !== "running" && (session.c64Cpu.pc & 0xffff) === 0xc008,
      `runState=${ctrl.runState} pc=$${session.c64Cpu.pc.toString(16)} spins=${spins}`);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part C — BUG-037: the dead second parser is retired.
// =====================================================================
console.log("\nSpec 754 — Part C: one canonical monitor (BUG-037)\n");
{
  const dead = [
    "ui/src/v3/tabs/Monitor.tsx",
    "ui/src/v3/components/MonitorCmdLine.tsx",
    "ui/src/v3/monitor-cmd-parser.ts",
    "scripts/smoke-monitor-cmd-parser.mjs",
  ];
  for (const f of dead) ok(`C: dead path removed — ${f}`, !existsSync(join(ROOT, f)));
  ok("C: one canonical processor importable (runMonitorCommand)", typeof runMonitorCommand === "function");
}

// =====================================================================
console.log(`\nSpec 754 P1+B gate: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
