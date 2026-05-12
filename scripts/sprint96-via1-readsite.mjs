#!/usr/bin/env node
// Sprint 96 / Bug 39 — direct $1800 read-site probe.
//
// External-review demand: log EVERY drive read of VIA1 PB ($1800) during
// the LISTEN $28 byte receive, with full state, to prove (or disprove)
// that the drive samples DATA at the wrong sub-instruction moment.
//
// Approach: monkey-patch DriveBus.read + IecBus.setC64Output from the
// script side so production bus code stays clean. Record:
//   - c64 cycle, drive cycle, drive PC, A/X/Y/P/SP
//   - drive RAM $77, $79, $85, $98
//   - effective IEC line state ATN/CLK/DATA
//   - C64 driver state (atnRel/clkRel/dataRel from CIA2 PA + DDR)
//   - drive driver state (atn-ack/clkRel/dataRel)
//   - last C64 $DD00 write: c64 cycle, value, ddr
//   - cycles since that $DD00 write
// Output: console table + JSONL to /tmp/sprint96-readsite.jsonl
// Acceptance gating from external review:
//   - if $1800 reads land OUTSIDE the CLK-released window the C64 just
//     opened, drive CPU needs cycle-stepped sub-instruction bus access.

import { existsSync, writeFileSync } from "node:fs";

const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { console.error("missing disk"); process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});
session.resetCold();

// Boot to BASIC ready.
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

const W = (n) => "$" + (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const B = (n) => "$" + (n & 0xff).toString(16).toUpperCase().padStart(2, "0");

// ---- last $DD00 write tracker (intercept IecBus.setC64Output) ----
let lastDd00 = { c64Cyc: -1, val: 0, ddr: 0 };
const origSetC64 = session.iecBus.setC64Output.bind(session.iecBus);
session.iecBus.setC64Output = (cia2Pa, ddrMask) => {
  lastDd00 = { c64Cyc: session.c64Cpu.cycles, val: cia2Pa, ddr: ddrMask };
  return origSetC64(cia2Pa, ddrMask);
};

// ---- $1800 read probe (intercept DriveBus.read) ----
const records = [];
const origRead = session.drive.bus.read.bind(session.drive.bus);
session.drive.bus.read = (addr) => {
  const a = addr & 0xffff;
  const v = origRead(addr);
  // Only log VIA1 PB reads ($1800 mirrors).
  if (a >= 0x1800 && a <= 0x180f && (a & 0x0f) === 0x00) {
    const dpc = session.drive.cpu.pc;
    // Window: drive ACPTR receive loop $E9C9..$EA22 covers wait-for-CLK +
    // bit-sample + ROR. Widen slightly for context.
    if (dpc >= 0xe800 && dpc <= 0xea50) {
      const ram = session.drive.bus.ram;
      const snap = session.iecBus.snapshot();
      records.push({
        n: records.length,
        c64Cyc: session.c64Cpu.cycles,
        drvCyc: session.drive.cpu.cycles,
        drvPc: dpc,
        a: session.drive.cpu.a, x: session.drive.cpu.x, y: session.drive.cpu.y,
        sp: session.drive.cpu.sp, p: session.drive.cpu.p,
        ram: { x77: ram[0x77], x79: ram[0x79], x85: ram[0x85], x98: ram[0x98] },
        line: { atn: snap.line.atn ? 1 : 0, clk: snap.line.clk ? 1 : 0, data: snap.line.data ? 1 : 0 },
        c64: { atnRel: snap.c64.atnReleased ? 1 : 0, clkRel: snap.c64.clkReleased ? 1 : 0, dataRel: snap.c64.dataReleased ? 1 : 0 },
        drv: { clkRel: snap.drive.clkReleased ? 1 : 0, dataRel: snap.drive.dataReleased ? 1 : 0, atnAck: snap.drive.atnAckReleased ? 1 : 0 },
        readVal: v & 0xff,
        dd00: { ...lastDd00, sinceCyc: lastDd00.c64Cyc < 0 ? -1 : session.c64Cpu.cycles - lastDd00.c64Cyc },
      });
    }
  }
  return v;
};

// ---- run until ACPTR completes or budget exhausted ----
// Stop conditions: $85 stops at the assembled byte (ROR completed) OR
// drive returns to idle ($EBFF) OR record cap.
const RECORD_CAP = 400;
const STEP_BUDGET = 8_000_000;
let prevX85 = -1;
for (let i = 0; i < STEP_BUDGET; i++) {
  session.runFor(1);
  if (records.length >= RECORD_CAP) break;
  // Early exit when post-receive: $77 still $28 AND $79 set AND drive
  // is past ACPTR.
  const ram = session.drive.bus.ram;
  if (records.length >= 8 && ram[0x77] === 0x28 && ram[0x79] !== 0 && session.drive.cpu.pc < 0xe900) break;
  if (records.length >= 8 && ram[0x85] !== prevX85) prevX85 = ram[0x85];
}

const ram = session.drive.bus.ram;
console.log(`\n=== Bug 39 read-site probe ===`);
console.log(`records: ${records.length}, last drvPC=${W(session.drive.cpu.pc)}`);
console.log(`drive RAM: $77=${B(ram[0x77])} $79=${B(ram[0x79])} $85=${B(ram[0x85])} $98=${B(ram[0x98])}`);
console.log(`expected:  $77=$28  $79=non-zero (listener active)  $85=$28 (LISTEN dev 8)\n`);

console.log(`# n  drvPc  drvCyc  c64Cyc  CLK(line/c64Rel/drvRel) DATA(line/c64Rel/drvRel) ATN  $85 $98  readVal  ΔsinceDD00 lastDD00=val/ddr`);
for (const r of records) {
  console.log(
    `${String(r.n).padStart(2)} ${W(r.drvPc)} ${String(r.drvCyc).padStart(8)} ${String(r.c64Cyc).padStart(8)}  ` +
    `CLK=${r.line.clk}/${r.c64.clkRel}/${r.drv.clkRel}  DATA=${r.line.data}/${r.c64.dataRel}/${r.drv.dataRel}  ATN=${r.line.atn}  ` +
    `$85=${B(r.ram.x85)} $98=${String(r.ram.x98).padStart(2)}  v=${B(r.readVal)}  ` +
    `Δ=${String(r.dd00.sinceCyc).padStart(5)} dd00=${B(r.dd00.val)}/${B(r.dd00.ddr)}`
  );
}

writeFileSync("/tmp/sprint96-readsite.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nJSONL written to /tmp/sprint96-readsite.jsonl`);

// Quick post-analysis: identify reads that came BEFORE c64 released CLK
// (c64.clkRel === 0) — those are the ones that would sample stale DATA.
const stale = records.filter((r) => r.drvPc >= 0xe87b && r.drvPc <= 0xe88f && r.c64.clkRel === 0);
const sampled = records.filter((r) => r.drvPc >= 0xea0b && r.drvPc <= 0xea18);
console.log(`\nClassifier:`);
console.log(`  reads in CLK-wait loop ($E87B..$E88F) seeing C64 still pulling CLK: ${stale.length}`);
console.log(`  reads at bit-sample window ($EA0B..$EA18): ${sampled.length}`);
if (sampled.length > 0) {
  const bits = sampled.map((r) => r.line.data === 0 ? 1 : 0); // line LOW → bit 1
  console.log(`  sampled bit pattern: ${bits.join(",")}`);
  console.log(`  expected for LISTEN $28 (LSB first): 0,0,0,1,0,1,0,0`);
}
