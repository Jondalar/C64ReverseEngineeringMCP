// LNR memory dump at crash point. Captures C64 RAM $1000-$2000
// before LOAD, after LOAD, after RUN-to-crash. Writes to DuckDB.

import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

const RANGE_LO = 0x0000;
const RANGE_HI = 0x10000;

async function dump(phase) {
  const ram = session.c64Bus.ram;
  const dram = session.drive.ram;
  const pc = session.c64Cpu.pc;
  const dpc = session.drive.cpu?.pc ?? 0;
  const cyc = session.c64Cpu.cycles;
  const rows = [];
  for (let a = RANGE_LO; a < RANGE_HI; a++) {
    rows.push(`('${phase}', ${cyc}, ${pc}, ${a}, ${ram[a]})`);
  }
  // drive RAM at offset $10000+ for table-only-distinct addresses
  for (let a = 0; a < dram.length; a++) {
    rows.push(`('${phase}_drive', ${cyc}, ${dpc}, ${a}, ${dram[a]})`);
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slab = rows.slice(i, i + CHUNK).join(",");
    await run(`INSERT INTO mem_dump VALUES ${slab}`);
  }
  console.log(`[${phase}] cyc=${cyc} c64.pc=$${pc.toString(16)} drive.pc=$${dpc.toString(16)} ramBytes=${ram.length} driveRamBytes=${dram.length}`);
}

console.log("Boot...");
session.resetCold("pal-default");
session.runFor(5_000_000);
await dump("after_boot");

console.log("Mount LNR s1...");
await mountMedia(session, 8, resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"));

console.log('LOAD"*",8,1...');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
await dump("after_load");

console.log("RUN...");
session.typeText("RUN\r");
// Earlier trace showed JMP $1400 fires at clk ~232391470 absolute,
// ~225M cycles after RUN. Run 35M cycles post-RUN (= past crash).
session.runFor(35_000_000);
await dump("after_run_crash");

console.log("Done.");
await closeStore(store);
console.log(`db: ${dbPath}`);
process.exit(0);
