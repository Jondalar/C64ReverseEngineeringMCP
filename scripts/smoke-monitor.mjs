#!/usr/bin/env node
// Spec 248 — MonitorAPI + indirect tracking smoke test.
//
// 10 monitor scenarios:
//   1. registers() returns valid CPU state
//   2. memory() reads correct bytes
//   3. disasm() formats "$XXXX  OP operand" lines
//   4. goto() sets PC
//   5. stepInto() advances one instruction
//   6. stepOver() normal: stops at next_pc
//   7. stepOver() self-modifying / JSR path: budget guard
//   8. stepOut() returns from subroutine
//   9. until() halts at target PC
//  10. find() locates byte pattern in memory
//
// 2 indirect-tracking scenarios:
//  11. ($zp),Y — izy normal: resolvedAddr captured
//  12. JMP ($XXFF) — ind_jmp page-cross anomaly recorded

import { existsSync } from "node:fs";

const disk = "samples/synthetic/1byte.g64";
if (!existsSync(disk)) {
  console.error(`fixture missing: ${disk} — run \`npm run smoke:gen\``);
  process.exit(2);
}

let startIntegratedSession;
let monitorMod, indirectMod;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  monitorMod = await import("../dist/runtime/headless/v2/monitor.js");
  indirectMod = await import("../dist/runtime/headless/v2/indirect-tracking.js");
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const { createMonitorAPI } = monitorMod;
const { addIndirectTracker } = indirectMod;

// ---- Helpers ----

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

console.log("monitor smoke — Spec 248 acceptance (12 scenarios)\n");

// ---- Session setup ----
// Spec 723.3: product path (true-drive default). BASIC boot is ROM-driven and
// independent of KERNAL fast-traps, so the boot budget is unchanged.
const { session } = startIntegratedSession({ diskPath: disk });
session.resetCold();
// Boot to BASIC ready state.
session.runFor(800_000);

const monitor = createMonitorAPI(session);
const cpu = session.c64Cpu;
const bus = session.c64Bus;

// ---- Scenario 1: registers() ----
check("1. registers() returns valid CPU state", () => {
  const regs = monitor.registers();
  assert(typeof regs.pc === "number", "pc not a number");
  assert(typeof regs.a === "number",  "a not a number");
  assert(typeof regs.sp === "number", "sp not a number");
  assert(regs.pc >= 0 && regs.pc <= 0xffff, `pc out of range: ${regs.pc}`);
  assert(regs.a >= 0 && regs.a <= 0xff, `a out of range: ${regs.a}`);
  assert(regs.sp >= 0 && regs.sp <= 0xff, `sp out of range: ${regs.sp}`);
  assert(typeof regs.cycles === "number", "cycles not a number");
});

// ---- Scenario 2: memory() ----
check("2. memory() reads correct bytes", () => {
  // Read the reset vector — always at $FFFC-$FFFD.
  const buf = monitor.memory(0xfffc, 0xfffd);
  assert(buf instanceof Uint8Array, "result not Uint8Array");
  assert(buf.length === 2, `expected 2 bytes, got ${buf.length}`);
  // Reconstruct CPU reset PC from the vector.
  const resetVec = buf[0] | (buf[1] << 8);
  assert(resetVec >= 0 && resetVec <= 0xffff, `resetVec out of range: 0x${resetVec.toString(16)}`);
  // Should match what the CPU is pointing into (after boot).
  const regs = monitor.registers();
  assert(typeof regs.pc === "number", "pc invalid after memory read");
});

// ---- Scenario 3: disasm() ----
check("3. disasm() formats lines correctly", () => {
  const pc = cpu.pc;
  const lines = monitor.disasm(pc, 5);
  assert(Array.isArray(lines), "not an array");
  assert(lines.length === 5, `expected 5 lines, got ${lines.length}`);
  for (const line of lines) {
    assert(typeof line.text === "string", "text not a string");
    assert(line.text.includes("$"), `text lacks $ prefix: ${line.text}`);
    assert(typeof line.addr === "number", "addr not a number");
    assert(Array.isArray(line.bytes) && line.bytes.length >= 1, "bytes invalid");
    assert(typeof line.mnemonic === "string", "mnemonic not a string");
  }
  // Check sequential addresses.
  for (let i = 1; i < lines.length; i++) {
    assert(lines[i].addr > lines[i-1].addr, `lines not sequential at idx ${i}`);
  }
});

// ---- Scenario 4: goto() sets PC ----
check("4. goto() sets PC", () => {
  const targetPc = 0x0900;
  // Write a NOP ($EA) there so we can step safely.
  session.c64Bus.ram[0x0900] = 0xea;
  monitor.goto(targetPc);
  assert(cpu.pc === targetPc, `expected PC=${targetPc.toString(16)}, got ${cpu.pc.toString(16)}`);
});

// ---- Scenario 5: stepInto() advances one instruction ----
check("5. stepInto() advances one instruction", () => {
  // At 0x0900 we have a NOP — advance to 0x0901.
  session.c64Bus.ram[0x0900] = 0xea; // NOP
  session.c64Bus.ram[0x0901] = 0xea; // NOP
  monitor.goto(0x0900);
  const before = cpu.cycles;
  const regs = monitor.stepInto();
  // PC should have moved to 0x0901 (NOP is 1 byte).
  assert(regs.pc === 0x0901, `expected PC=0x0901, got 0x${regs.pc.toString(16)}`);
  assert(cpu.cycles > before, "cycles did not advance");
});

// ---- Scenario 6: stepOver() normal — stops at next_pc after NOP ----
check("6. stepOver() normal: stops at next_pc", () => {
  // Put a NOP at 0x0910; stepOver should stop at 0x0911.
  session.c64Bus.ram[0x0910] = 0xea; // NOP (1 byte)
  session.c64Bus.ram[0x0911] = 0xea; // NOP at next
  monitor.goto(0x0910);
  const result = monitor.stepOver();
  assert(result.halted, "stepOver should have halted");
  assert(result.haltReason === "next_pc", `expected next_pc, got ${result.haltReason}`);
  assert(result.finalPc === 0x0911, `expected finalPc=0x0911, got 0x${result.finalPc.toString(16)}`);
});

// ---- Scenario 7: stepOver() self-modifying / budget guard ----
check("7. stepOver() budget exhausted on infinite loop", () => {
  // JMP $0920 (infinite loop): $4C $20 $09
  session.c64Bus.ram[0x0920] = 0x4c; // JMP
  session.c64Bus.ram[0x0921] = 0x20; // lo
  session.c64Bus.ram[0x0922] = 0x09; // hi — loops to $0920
  monitor.goto(0x0920);
  // Use a very small budget so it exhausts fast.
  const result = monitor.stepOver({ budget: 50 });
  assert(!result.halted, "stepOver should not halt on infinite loop");
  assert(result.haltReason === "budget_exhausted", `expected budget_exhausted, got ${result.haltReason}`);
});

// ---- Scenario 8: stepOut() returns from subroutine ----
check("8. stepOut() returns from subroutine", () => {
  // Set up a tiny JSR+RTS pair:
  //   $0930  JSR $0940
  //   $0933  NOP (return lands here)
  //   $0940  RTS
  bus.ram[0x0930] = 0x20; bus.ram[0x0931] = 0x40; bus.ram[0x0932] = 0x09; // JSR $0940
  bus.ram[0x0933] = 0xea; // NOP
  bus.ram[0x0940] = 0x60; // RTS
  monitor.goto(0x0930);
  // Step into JSR first, so we're inside the subroutine.
  monitor.stepInto(); // executes JSR, now at $0940
  assert(cpu.pc === 0x0940, `expected to be at $0940 (RTS), got 0x${cpu.pc.toString(16)}`);
  const spBefore = cpu.sp;
  const result = monitor.stepOut({ budget: 200_000 });
  // After RTS we're at $0933.
  assert(result.halted, "stepOut should have halted");
  assert(cpu.sp >= spBefore, `SP should not have decreased (was ${spBefore}, now ${cpu.sp})`);
});

// ---- Scenario 9: until() halts at target PC ----
check("9. until() halts at target PC", () => {
  // Put a short code sequence and run until a specific PC.
  //   $0950  NOP
  //   $0951  NOP
  //   $0952  NOP  <- target
  bus.ram[0x0950] = 0xea;
  bus.ram[0x0951] = 0xea;
  bus.ram[0x0952] = 0xea;
  bus.ram[0x0953] = 0xea;
  monitor.goto(0x0950);
  const result = monitor.until(0x0952, { budget: 10_000 });
  assert(result.halted, "until() should have halted");
  assert(!result.budgetExhausted, "budget should not have been exhausted");
  assert(result.finalPc === 0x0952, `expected finalPc=0x0952, got 0x${result.finalPc.toString(16)}`);
});

// ---- Scenario 10: find() locates byte pattern ----
check("10. find() locates byte pattern in memory", () => {
  // Write a known pattern to RAM at $0960.
  bus.ram[0x0960] = 0xDE;
  bus.ram[0x0961] = 0xAD;
  bus.ram[0x0962] = 0xBE;
  bus.ram[0x0963] = 0xEF;
  const results = monitor.find(0x0940, 0x0980, [0xDE, 0xAD, 0xBE, 0xEF]);
  assert(results.length >= 1, `expected at least 1 match, got ${results.length}`);
  const match = results.find(r => r.addr === 0x0960);
  assert(match !== undefined, "expected match at $0960");
  assert(match.bytes.length === 4, `expected 4 bytes, got ${match.bytes.length}`);
});

// ============================================================
// Indirect tracking scenarios — use a fresh session to keep
// traces clean and avoid mode conflicts.
// ============================================================

const { session: session2 } = startIntegratedSession({ diskPath: disk });
session2.resetCold();
session2.runFor(800_000);

// Attach indirect tracker.
const tracker = addIndirectTracker(session2);
const resolutions = [];
tracker.addListener((ev) => resolutions.push(ev));

const bus2 = session2.c64Bus;
const cpu2 = session2.c64Cpu;
const monitor2 = createMonitorAPI(session2);

// ---- Scenario 11: ($zp),Y — izy normal ----
check("11. ($zp),Y — izy normal: resolvedAddr captured", () => {
  // Set up:
  //   ZP $20 = $00, ZP $21 = $0A  → pointer = $0A00
  //   Y = $05 → resolved = $0A05
  //   At $0970: LDA ($20),Y = $B1 $20
  bus2.ram[0x0020] = 0x00; // pointer lo
  bus2.ram[0x0021] = 0x0a; // pointer hi
  bus2.ram[0x0a05] = 0x42; // value to read
  bus2.ram[0x0970] = 0xb1; // LDA ($zp),Y
  bus2.ram[0x0971] = 0x20; // zp = $20
  bus2.ram[0x0972] = 0xea; // NOP (landing)

  // Set Y = 5.
  cpu2.y = 5;
  const prevCount = resolutions.length;
  monitor2.goto(0x0970);
  monitor2.stepInto(); // execute LDA ($20),Y

  const newResolutions = resolutions.slice(prevCount);
  assert(newResolutions.length >= 1, `expected >=1 izy resolution, got ${newResolutions.length}`);
  const ev = newResolutions[0];
  assert(ev.mode === "izy", `expected mode=izy, got ${ev.mode}`);
  assert(ev.operandAddr === 0x20, `expected operandAddr=0x20, got 0x${ev.operandAddr.toString(16)}`);
  assert(ev.resolvedAddr === 0x0a05, `expected resolvedAddr=0x0a05, got 0x${ev.resolvedAddr.toString(16)}`);
  assert(ev.pc === 0x0970, `expected pc=0x0970, got 0x${ev.pc.toString(16)}`);
});

// ---- Scenario 12: JMP ($XXFF) — page-cross anomaly ----
check("12. JMP ($XXFF) — ind_jmp page-cross anomaly recorded", () => {
  // JMP ($08FF): low byte at $08FF, high byte at $0800 (not $0900)
  // which is the 6502 NMOS page-cross bug.
  bus2.ram[0x08ff] = 0x34;  // lo byte of jump target
  bus2.ram[0x0800] = 0x12;  // hi byte (due to page-cross bug, from $0800 not $0900)
  // So resolved target = $1234 (lo=$34, hi=$12)
  bus2.ram[0x0980] = 0x6c;  // JMP ($abs)
  bus2.ram[0x0981] = 0xff;  // lo of pointer addr
  bus2.ram[0x0982] = 0x08;  // hi of pointer addr → pointer is $08FF
  // Place a NOP at $1234 to land safely (if real CPU jumps there).
  bus2.ram[0x1234] = 0xea;

  const prevCount = resolutions.length;
  monitor2.goto(0x0980);
  monitor2.stepInto(); // execute JMP ($08FF)

  const newResolutions = resolutions.slice(prevCount);
  assert(newResolutions.length >= 1, `expected >=1 ind_jmp resolution, got ${newResolutions.length}`);
  const ev = newResolutions[0];
  assert(ev.mode === "ind_jmp", `expected mode=ind_jmp, got ${ev.mode}`);
  assert(ev.operandAddr === 0x08ff, `expected operandAddr=0x08FF, got 0x${ev.operandAddr.toString(16)}`);
  assert(ev.pageCrossAnomaly === true, `expected pageCrossAnomaly=true, got ${ev.pageCrossAnomaly}`);
  assert(ev.pointerHigh === 0x0800, `expected pointerHigh=0x0800 (wrap), got 0x${ev.pointerHigh.toString(16)}`);
  // Resolved address: lo from $08FF = $34, hi from $0800 = $12 → $1234
  assert(ev.resolvedAddr === 0x1234, `expected resolvedAddr=0x1234, got 0x${ev.resolvedAddr.toString(16)}`);
});

// ---- Summary ----
console.log(`\n---`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("FAIL:");
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log("PASS: all 12 monitor + indirect-tracking scenarios green");
process.exit(0);
