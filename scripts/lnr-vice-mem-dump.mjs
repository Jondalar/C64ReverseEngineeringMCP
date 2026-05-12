// VICE comprehensive memory + I/O dump for LNR.
// Captures full $0000-$FFFF C64 RAM + drive RAM $0000-$07FF
// at multiple phases. Phase parity with headless dump.

import { spawn } from "node:child_process";
import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const VICE_X64SC = process.env.VICE_X64SC ?? "/opt/homebrew/Cellar/vice/3.10/bin/x64sc";

const { ViceMonitorClient, BANK_RAM } = await import(`${repoRoot}/dist/runtime/vice/monitor-client.js`);
const { openStore, closeStore } = await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);

const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/lnr-mem-dump-${date}`);
mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "memdump-vice.duckdb");

const PAL_HZ = 985_248;
const meta = {
  runId: `lnr-vice-memdump-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`,
  source: "vice", capturedAt: new Date().toISOString(),
  writerVersion: "vice-3.10",
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

if (!existsSync(VICE_X64SC)) { console.error(`x64sc not found: ${VICE_X64SC}`); process.exit(2); }

const port = 6512;
console.log("Spawn x64sc -autostart ...");
const vice = spawn(VICE_X64SC, [
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-silent",
  "-warp",
  "-autostart-warp",
  "-autostartprgmode", "1",
  "-autostart", resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"),
], { stdio: ["ignore", "ignore", "pipe"] });
vice.stderr.on("data", (d) => process.stderr.write(`[vice] ${d}`));
vice.on("exit", (code) => console.log(`[vice exit ${code}]`));

await new Promise((r) => setTimeout(r, 4000));

const mon = new ViceMonitorClient({ host: "127.0.0.1", port });
await mon.connect(10_000);
console.log("Connected.");
// VICE binmon may pause on connection — explicit resume so warp can progress.
await mon.resume().catch((e) => console.log(`resume err: ${e.message}`));

// VICE memspaces: 0=main, 1=drive8, 2=drive9, ...
const MAIN = 0, DRIVE8 = 1;

async function dumpMemSpace(phase, memspace, label, lo, hi) {
  const STEP = 0x1000; // 4KB chunks per binmon read
  let total = 0;
  for (let base = lo; base < hi; base += STEP) {
    const end = Math.min(base + STEP, hi) - 1;
    const buf = await mon.readMemory(base, end, 0, memspace);
    const rows = [];
    for (let i = 0; i < buf.length; i++) {
      rows.push(`('${phase}_${label}', 0, 0, ${base + i}, ${buf[i]})`);
    }
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slab = rows.slice(i, i + CHUNK).join(",");
      await run(`INSERT INTO mem_dump VALUES ${slab}`);
    }
    total += buf.length;
  }
  return total;
}

async function dumpRegs(phase, memspace, label) {
  const regs = await mon.getRegisters(memspace).catch(() => []);
  const descs = await mon.getRegistersAvailable(memspace).catch(() => []);
  const byId = new Map(descs.map((d) => [d.id, d.name]));
  for (const r of regs) {
    const name = byId.get(r.id) ?? `id_${r.id}`;
    await run(`INSERT INTO reg_dump VALUES ('${phase}', '${label}', '${name}', ${r.value})`);
  }
}

async function dump(phase) {
  // Reads pause emulator; resume after each batch
  const n1 = await dumpMemSpace(phase, MAIN, "c64", 0x0000, 0x10000);
  const n2 = await dumpMemSpace(phase, DRIVE8, "drive", 0x0000, 0x0800).catch((e) => {
    console.log(`  drive readMemory fail: ${e.message}`);
    return 0;
  });
  await dumpRegs(phase, MAIN, "c64");
  await dumpRegs(phase, DRIVE8, "drive").catch(() => {});
  // Status markers
  const buf = await mon.readMemory(0x002D, 0x002E, 0, MAIN);
  const basicEnd = buf[0] | (buf[1] << 8);
  const d018 = (await mon.readMemory(0xD018, 0xD018, 0, MAIN)).readUInt8(0);
  const b7 = (await mon.readMemory(0x00B7, 0x00B7, 0, MAIN)).readUInt8(0);
  console.log(`[${phase}] c64=${n1}B drive=${n2}B basic_end=$${basicEnd.toString(16)} d018=$${d018.toString(16)} $b7=$${b7.toString(16)}`);
  await mon.resume().catch(() => {});
}

console.log("Phase 1 — 5s wait (KERNAL boot + autostart begin)");
await new Promise((r) => setTimeout(r, 5000));
await dump("vice_5s");

console.log("Phase 2 — +15s (LOAD progressing)");
await new Promise((r) => setTimeout(r, 15000));
await dump("vice_20s");

console.log("Phase 3 — +20s (game booting)");
await new Promise((r) => setTimeout(r, 20000));
await dump("vice_40s");

console.log("Phase 4 — +20s (game running)");
await new Promise((r) => setTimeout(r, 20000));
await dump("vice_60s");

console.log("Done. Quitting...");
await mon.quitVice().catch(() => {});
try { vice.kill("SIGKILL"); } catch {}
await closeStore(store);
console.log(`db: ${dbPath}`);
process.exit(0);
