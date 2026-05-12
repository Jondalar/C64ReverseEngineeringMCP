// VICE memdump w/ autostart + verify game ran.
// LNR is auto-LOAD"*",8,1 + RUN via -autostart.
// Wait long enough for fastloader + boot.

import { spawn } from "node:child_process";
import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const VICE_X64SC = process.env.VICE_X64SC ?? "/opt/homebrew/Cellar/vice/3.10/bin/x64sc";

const { ViceMonitorClient } = await import(`${repoRoot}/dist/runtime/vice/monitor-client.js`);
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

if (!existsSync(VICE_X64SC)) { console.error(`x64sc not found: ${VICE_X64SC}`); process.exit(2); }

const port = 6512;
console.log("Spawn x64sc -autostart ...");
const vice = spawn(VICE_X64SC, [
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-warp", "-silent",
  "-autostart", resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"),
  "-autostart-warp",
], { stdio: ["ignore", "ignore", "pipe"] });
vice.stderr.on("data", (d) => process.stderr.write(`[vice] ${d}`));
vice.on("exit", (code) => console.log(`[vice exit ${code}]`));

await new Promise((r) => setTimeout(r, 4000));

const mon = new ViceMonitorClient({ host: "127.0.0.1", port });
await mon.connect(10_000);
console.log("Connected.");

const RANGE_LO = 0x0000;
const RANGE_HI = 0x2000;

async function dump(phase) {
  const buf = await mon.readMemory(RANGE_LO, RANGE_HI - 1);
  const regs = await mon.getRegisters().catch(() => []);
  const pcReg = regs.find((r) => r.name === "PC")?.value ?? 0;
  // Check game-ran markers
  const basicEnd = buf[0x002D] | (buf[0x002E] << 8);
  const d018 = (await mon.readMemory(0xD018, 0xD018)).readUInt8(0);
  console.log(`[${phase}] pc=$${pcReg.toString(16)} basic_end=$${basicEnd.toString(16)} d018=$${d018.toString(16)}`);
  const rows = [];
  for (let i = 0; i < buf.length; i++) {
    rows.push(`('${phase}', 0, ${pcReg}, ${RANGE_LO + i}, ${buf[i]})`);
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slab = rows.slice(i, i + CHUNK).join(",");
    await run(`INSERT INTO mem_dump VALUES ${slab}`);
  }
}

console.log("Wait 30s for boot...");
await new Promise((r) => setTimeout(r, 30_000));
await dump("vice_boot_30s");

console.log("Wait additional 30s...");
await new Promise((r) => setTimeout(r, 30_000));
await dump("vice_boot_60s");

console.log("Done. Quitting...");
await mon.quitVice().catch(() => {});
try { vice.kill("SIGKILL"); } catch {}
await closeStore(store);
console.log(`db: ${dbPath}`);
process.exit(0);
