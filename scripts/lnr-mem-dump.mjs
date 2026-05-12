// LNR comprehensive memory + I/O dump (headless).
// Captures C64 RAM $0000-$FFFF, drive RAM $0000-$07FF,
// CIA/VIC/VIA I/O register state, CPU+drive PC/regs,
// at multiple phases. Mirrors VICE-side dump.

import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
const repoRoot = resolvePath(import.meta.dirname, "..");

const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);
const { mountMedia } = await import(`${repoRoot}/dist/runtime/headless/media/mount.js`);
const { openStore, closeStore } = await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);

const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/lnr-mem-dump-${date}`);
mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "memdump.duckdb");

const PAL_HZ = 985_248;
const meta = {
  runId: `lnr-memdump-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`,
  source: "headless", capturedAt: new Date().toISOString(),
  writerVersion: process.env.C64RE_GIT_SHA ?? "dev",
  c64ClockHz: PAL_HZ, driveClockHz: 1_000_000,
  c64ClockZero: 0n, driveClockZero: 0n, driveToC64Offset: 0n,
};
const store = await openStore({ path: dbPath, meta });
const conn = store.conn;
async function run(sql) { return await conn.run(sql); }
await run(`
CREATE TABLE IF NOT EXISTS mem_dump (
  phase   VARCHAR,
  cycle   BIGINT,
  pc      INTEGER,
  addr    INTEGER,
  value   INTEGER
)`);
await run(`
CREATE TABLE IF NOT EXISTS reg_dump (
  phase   VARCHAR,
  memspace VARCHAR,
  reg     VARCHAR,
  value   INTEGER
)`);
await run(`
CREATE TABLE IF NOT EXISTS io_snapshot (
  phase   VARCHAR,
  chip    VARCHAR,
  reg     INTEGER,
  value   INTEGER
)`);

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

async function dumpMem(phase, label, ram, base = 0) {
  const rows = [];
  for (let i = 0; i < ram.length; i++) {
    rows.push(`('${phase}_${label}', 0, 0, ${base + i}, ${ram[i]})`);
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slab = rows.slice(i, i + CHUNK).join(",");
    await run(`INSERT INTO mem_dump VALUES ${slab}`);
  }
  return ram.length;
}

async function dumpRegs(phase, memspace, label, regs) {
  for (const [name, val] of Object.entries(regs)) {
    if (val === undefined || val === null) continue;
    await run(`INSERT INTO reg_dump VALUES ('${phase}', '${label}', '${name}', ${val})`);
  }
}

async function dumpIo(phase) {
  // Read CIA1/CIA2/VIA1/VIA2/VIC register snapshot via current state
  const cia1 = session.cia1;
  const cia2 = session.cia2;
  const vic = session.kernel.vic ?? session.vic;
  const via1 = session.drive.via1;
  const via2 = session.drive.via2;
  const rows = [];
  function push(chip, reg, val) {
    if (typeof val === "number") {
      rows.push(`('${phase}', '${chip}', ${reg}, ${val & 0xff})`);
    }
  }
  // CIA1/CIA2 internal register file c_cia[]
  for (const [chip, c] of [["cia1", cia1], ["cia2", cia2]]) {
    if (!c) continue;
    const cc = c.c_cia ?? [];
    for (let r = 0; r < 16; r++) push(chip, r, cc[r] ?? 0);
  }
  // VIA1/VIA2 register state
  for (const [chip, v] of [["via1", via1], ["via2", via2]]) {
    if (!v) continue;
    for (let r = 0; r < 16; r++) {
      const val = typeof v.read === "function" ? v.read(r, true) : v.regs?.[r];
      push(chip, r, val);
    }
  }
  // VIC $D000-$D03F (literal port writes go through CPU bus io[])
  const io = session.c64Bus.io;
  if (io) {
    for (let r = 0; r < 0x40; r++) push("vic", r, io[r]);
  }
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slab = rows.slice(i, i + CHUNK).join(",");
    if (slab) await run(`INSERT INTO io_snapshot VALUES ${slab}`);
  }
  return rows.length;
}

async function snapshot(phase) {
  const cpu = session.c64Cpu;
  const dcpu = session.drive.cpu;
  const n1 = await dumpMem(phase, "c64", session.c64Bus.ram);
  const n2 = await dumpMem(phase, "drive", session.drive.ram);
  await dumpRegs(phase, "c64", "c64", {
    PC: cpu.pc, A: cpu.a, X: cpu.x, Y: cpu.y, SP: cpu.sp,
    P: cpu.flags ?? cpu.p, CYC: cpu.cycles,
  });
  await dumpRegs(phase, "drive", "drive", {
    PC: dcpu?.pc, A: dcpu?.a, X: dcpu?.x, Y: dcpu?.y, SP: dcpu?.sp,
    P: dcpu?.flags ?? dcpu?.p, CYC: dcpu?.cycles,
    TRACK: session.drive.headPosition?.track ?? 0,
    TRACK_HALF: session.drive.headPosition?.trackHalf ?? 0,
  });
  const ioN = await dumpIo(phase);
  console.log(`[${phase}] c64=${n1}B drive=${n2}B io=${ioN}regs cpu.pc=$${cpu.pc.toString(16)} drv.pc=$${(dcpu?.pc ?? 0).toString(16)} b7=$${session.c64Bus.ram[0xB7].toString(16)}`);
}

console.log("Phase 1 — cold boot");
session.resetCold("pal-default");
session.runFor(5_000_000);
await snapshot("after_boot");

console.log("Phase 2 — mount + LOAD");
await mountMedia(session, 8, resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
await snapshot("after_load");

console.log("Phase 3 — RUN until crash window");
session.typeText("RUN\r");
session.runFor(20_000_000); // mid-run
await snapshot("after_run_mid");

console.log("Phase 4 — past crash point");
session.runFor(20_000_000);
await snapshot("after_run_crash");

console.log("Done.");
await closeStore(store);
console.log(`db: ${dbPath}`);
process.exit(0);
