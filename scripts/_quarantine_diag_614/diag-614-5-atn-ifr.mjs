#!/usr/bin/env node
// Spec 614.5 first-divergence diag — VIA1d1541 IFR/IER during LOAD"$",8.
//
// Hypothesis chain: drive stuck in $E9E0 byte-receive outer loop, ATNA
// never enabled. ATNA is enabled by the drive ROM's ATN-IRQ handler
// (CA1 IRQ from $1800). Check whether:
//   (a) CA1 IRQ ever fires (IFR bit 1 set)
//   (b) CA1 IRQ ever taken (IER bit 1 set AND IRQ vectored)
//   (c) Drive PC ever reaches ATN handler ($FE67 / $E853 region)

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);  // boot to READY

const vice = session.kernel.drive1541;
const diskunit = vice.diskunit;
const via1 = diskunit?.via1d1541;
if (!via1) { console.error("FAIL: no via1d1541"); process.exit(1); }

console.log(`initial via1.ifr=$${via1.ifr.toString(16)} ier=$${via1.ier.toString(16)}`);
console.log(`initial drv_data[8]=$${(session.iecBus.core.drv_data[8] ?? 0).toString(16)}`);

// Snapshots: drive PC, via1 IFR, IER, drv_data[8] at each tickToClock fire.
let trackEnabled = false;
let snapshots = [];
let atnPullSeen = false;
let ca1IrqEverSet = false;
let atnHandlerReached = false;
let iecLineDriveLog = [];

const origIecDrive = vice.iecLineDrive.bind(vice);
vice.iecLineDrive = (c64Side, effClk) => {
  if (trackEnabled && iecLineDriveLog.length < 30) {
    iecLineDriveLog.push({
      clk: effClk,
      atn: c64Side.bus_atn,
      clk_line: c64Side.bus_clk,
      data: c64Side.bus_data,
      via1_ifr_before: via1.ifr,
      via1_ier_before: via1.ier,
    });
  }
  return origIecDrive(c64Side, effClk);
};

const origTickToClock = vice.tickToClock.bind(vice);
let tickEvery = 0;
vice.tickToClock = (clk) => {
  const r = origTickToClock(clk);
  if (trackEnabled && (++tickEvery % 64 === 0)) {
    const probe = vice.debugProbe?.();
    const pc = probe?.drive_pc ?? 0;
    if (pc >= 0xfe60 && pc <= 0xfeff) atnHandlerReached = true;
    if (pc >= 0xe850 && pc <= 0xe900) atnHandlerReached = true;
    if (via1.ifr & 0x02) ca1IrqEverSet = true;  // CA1 IRQ flag
    if (snapshots.length < 60) {
      snapshots.push({
        clk,
        pc: pc,
        ifr: via1.ifr,
        ier: via1.ier,
        drv_data8: session.iecBus.core.drv_data[8] ?? 0,
        cpu_port: session.iecBus.core.cpu_port ?? 0,
      });
    }
  }
  return r;
};

trackEnabled = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 5 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
trackEnabled = false;

console.log("\n=== first 10 iecLineDrive events ===");
for (const e of iecLineDriveLog.slice(0, 10)) {
  console.log(`  clk=${e.clk}  ATN=${e.atn?1:0} CLK=${e.clk_line?1:0} DATA=${e.data?1:0}  via1_ifr=$${e.via1_ifr_before.toString(16)} ier=$${e.via1_ier_before.toString(16)}`);
}

console.log("\n=== sampled snapshots (every 64th tickToClock during LOAD) ===");
for (const s of snapshots.slice(0, 25)) {
  console.log(`  clk=${s.clk}  drv_pc=$${s.pc.toString(16).padStart(4,"0")}  ifr=$${s.ifr.toString(16).padStart(2,"0")}  ier=$${s.ier.toString(16).padStart(2,"0")}  drv_data8=$${s.drv_data8.toString(16).padStart(2,"0")}  cpu_port=$${s.cpu_port.toString(16).padStart(2,"0")}`);
}

console.log("\n=== final state ===");
console.log(`  via1.ifr=$${via1.ifr.toString(16)}  ier=$${via1.ier.toString(16)}`);
console.log(`  drv_data[8]=$${(session.iecBus.core.drv_data[8] ?? 0).toString(16)}  (bit4 = ${(session.iecBus.core.drv_data[8] & 0x10) ? "released=ATNA-DISABLED" : "pulled=ATNA-ENABLED"})`);
console.log(`  ca1IrqEverSet=${ca1IrqEverSet}  atnHandlerReached=${atnHandlerReached}`);
console.log(`  iecLineDrive fires: ${iecLineDriveLog.length}`);
console.log(`  c64Pc=$${session.c64Cpu.pc.toString(16)}`);
