#!/usr/bin/env node
// Spec 611 phase 611.7f.7 — post-ATN-release $DD00 wait probe per Codex 07:00.
//
// C64 KERNAL $EEA9..$EEB2 decoded from kernal-901227-03.bin:
//   $EEA9  AD 00 DD    LDA $DD00       ; read CIA2 PA (= IEC input bits)
//   $EEAC  CD 00 DD    CMP $DD00       ; read again, compare
//   $EEAF  D0 F8       BNE $EEA9       ; if different, retry
//   $EEB1  0A          ASL A           ; shift bit 7 → carry
//   $EEB2  60          RTS             ; carry = DATA state (1=released)
//
// This is the **wait-stable** subroutine. C64 spins until two consecutive
// $DD00 reads return the same byte. If our bridge produces DIFFERENT
// overlay values between back-to-back reads (= vice advances between
// reads + iecLineSample changes), C64 spins forever.
//
// Per Codex 07:00, capture window = t=8447000..8449000 + tail.
// Log every $DD00 read with c64Pc, returned byte, vice sample, drv_data[8],
// cpu_port. Identify whether returns differ across consecutive reads.
//
// Read-only. No source mutation.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
const vice = k.drive1541;
const driveCpu = vice.driveCpu;
const viceIec = driveCpu.iecBus;
const via1 = driveCpu.via1;
const iecBus = k.iecBus;
const core = iecBus.core;

const events = [];
const MAX = 2000;
const state = { armed: false, captureEnabled: false, triggered: false, t0: 0, until: 0 };
function rec(ev) {
  if (!state.captureEnabled || events.length >= MAX) return;
  events.push({ ...ev, dt: ev.t - (events.length ? events[events.length - 1].t : state.t0) });
}

// --- Trigger on ATN-RELEASE (= first c64AtnReleased=true after a false) ---
const origSetLines = driveCpu.setC64IecLines.bind(driveCpu);
let prevAtn = viceIec.c64AtnReleased;
driveCpu.setC64IecLines = (a, c, d) => {
  if (!state.triggered && a === true && prevAtn === false && state.armed) {
    state.triggered = true;
    state.captureEnabled = true;
    state.t0 = session.c64Cpu.cycles;
    state.until = session.c64Cpu.cycles + 50000;
    console.log(`Trigger fired (ATN-release) at t=${session.c64Cpu.cycles}`);
  }
  prevAtn = a;
  if (state.captureEnabled) {
    rec({
      kind: "iecLineDrive",
      t: session.c64Cpu.cycles,
      c64Pc: session.c64Cpu.pc & 0xffff,
      cia2Pa: (session.cia2?.pra ?? 0) & 0xff,
      atn: a ? 1 : 0, clk: c ? 1 : 0, data: d ? 1 : 0,
    });
  }
  return origSetLines(a, c, d);
};

// --- Spy on buildC64InputBits (= $DD00 read) ---
const origBuildC64 = iecBus.buildC64InputBits.bind(iecBus);
iecBus.buildC64InputBits = (effClk, cs) => {
  const pre = {
    cpuPort: core.cpu_port & 0xff,
    drvData8: core.drv_data[8] & 0xff,
    drvBus8: core.drv_bus[8] & 0xff,
  };
  const result = origBuildC64(effClk, cs);
  if (state.captureEnabled) {
    const sample = vice.iecLineSample();
    rec({
      kind: "c64Dd00Read",
      t: session.c64Cpu.cycles,
      c64Pc: session.c64Cpu.pc & 0xffff,
      returnedDd00: result & 0xff,
      dataIn: (result & 0x80) ? "rel(1)" : "PULL(0)",
      clkIn: (result & 0x40) ? "rel(1)" : "PULL(0)",
      cpuBus: core.cpu_bus & 0xff,
      cpuPort: core.cpu_port & 0xff,
      drvData8: core.drv_data[8] & 0xff,
      drvBus8: core.drv_bus[8] & 0xff,
      // Spec 611 phase 611.7f.9 — also peek drv_bus[9..11] for clobber check.
      drvBus9: core.drv_bus[9] & 0xff,
      drvBus10: core.drv_bus[10] & 0xff,
      drvBus11: core.drv_bus[11] & 0xff,
      pre,
      viceData: !sample.drv_data_pull ? "rel" : "pull",
      viceClk: !sample.drv_clk_pull ? "rel" : "pull",
      viceAtna: !sample.drv_atna_pull ? "rel" : "pull",
      drvPc: driveCpu.pc & 0xffff,
      drvClk: driveCpu.cpu.clk,
    });
  }
  return result;
};

// --- Drive PRB writes ---
const origWrite = via1.write.bind(via1);
via1.write = (reg, value) => {
  const r = reg & 0x0f;
  const v = value & 0xff;
  if (state.captureEnabled && r === 0x00) {
    rec({
      kind: "drvPbWrite",
      t: session.c64Cpu.cycles,
      drvPc: driveCpu.pc & 0xffff,
      prb: v,
    });
  }
  return origWrite(reg, value);
};

// === Run ===
const ramMount = await mountMedia(session, 8, diskPath);
if (ramMount.errors?.length) { console.error(ramMount.errors); process.exit(1); }
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
state.armed = true;

const PAL_HZ = 985_248;
const hardTimeout = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < hardTimeout) {
  session.runFor(20_000);
  if (state.triggered && session.c64Cpu.cycles >= state.until) break;
  if (events.length >= MAX) break;
}
state.captureEnabled = false;
console.log(`Capture END at t=${session.c64Cpu.cycles}, ${events.length} events`);

// === Output ===
console.log("");
console.log("=== Post-ATN-release event stream ===");
console.log("");

let prevDd00 = null;
let consecutiveDd00 = 0;
let consecutiveDiff = 0;

for (const e of events) {
  if (e.kind === "iecLineDrive") {
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `c64=$${e.c64Pc.toString(16).padStart(4,"0")} ` +
      `PA=$${e.cia2Pa.toString(16).padStart(2,"0")}  ` +
      `bridge.iecLineDrive(atn=${e.atn} clk=${e.clk} data=${e.data})`,
    );
    prevDd00 = null;
  } else if (e.kind === "drvPbWrite") {
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}  ` +
      `DRV PB write = $${e.prb.toString(16).padStart(2,"0")}`,
    );
    prevDd00 = null;
  } else if (e.kind === "c64Dd00Read") {
    consecutiveDd00++;
    const changeFlag = prevDd00 !== null && prevDd00 !== e.returnedDd00 ? " ⚠CHANGED" : "";
    if (changeFlag) consecutiveDiff++;
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `c64=$${e.c64Pc.toString(16).padStart(4,"0")} ` +
      `RD$DD00→$${e.returnedDd00.toString(16).padStart(2,"0")} ` +
      `cpu_bus=$${e.cpuBus.toString(16).padStart(2,"0")} ` +
      `cpu_port=$${e.cpuPort.toString(16).padStart(2,"0")} ` +
      `drv_data[8]=$${e.drvData8.toString(16).padStart(2,"0")} ` +
      `drv_bus[8]=$${e.drvBus8.toString(16).padStart(2,"0")} ` +
      `bus[9/10/11]=$${e.drvBus9.toString(16)}/$${e.drvBus10.toString(16)}/$${e.drvBus11.toString(16)} ` +
      `vice(D=${e.viceData} C=${e.viceClk} A=${e.viceAtna}) ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}${changeFlag}`,
    );
    prevDd00 = e.returnedDd00;
  }
}

console.log("");
console.log(`=== Stats ===`);
console.log(`Total $DD00 reads: ${consecutiveDd00}`);
console.log(`Reads where $DD00 value CHANGED from previous: ${consecutiveDiff}`);
console.log(`(C64 $EEAC CMP $DD00 / BNE $EEA9: any change = retry; spin happens if many changes)`);
console.log("");
console.log(`=== C64 KERNAL $EEA9..$EEB2 (decoded from kernal-901227-03.bin) ===`);
console.log(`$EEA9  AD 00 DD    LDA $DD00       ; read CIA2 PA bits`);
console.log(`$EEAC  CD 00 DD    CMP $DD00       ; read again, compare`);
console.log(`$EEAF  D0 F8       BNE $EEA9       ; if different, retry`);
console.log(`$EEB1  0A          ASL A           ; bit 7 → carry`);
console.log(`$EEB2  60          RTS             ; carry = DATA bit (1=released)`);
console.log(`Caller branches on carry: serial-bus DATA released/pulled check.`);
