// LNR VICE cpuhistory trace via -autostart + binmon polling.
// Writes instructions table to DuckDB trace store matching headless
// schema, so we can diff against samples/traces/v2-baseline/lnr-headless-paced-*.

import { spawn } from "node:child_process";
import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const VICE_X64SC = process.env.VICE_X64SC ?? "/opt/homebrew/Cellar/vice/3.10/bin/x64sc";

const { ViceMonitorClient } = await import(`${repoRoot}/dist/runtime/vice/monitor-client.js`);
const { openStore, closeStore } = await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);

const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/lnr-vice-cpuhistory-${date}`);
mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "trace.duckdb");

const PAL_HZ = 985_248;
const meta = {
  runId: `lnr-vice-cpuhist-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`,
  source: "vice", capturedAt: new Date().toISOString(),
  writerVersion: "vice-3.10",
  c64ClockHz: PAL_HZ, driveClockHz: 1_000_000,
  c64ClockZero: 0n, driveClockZero: 0n, driveToC64Offset: 0n,
};
const store = await openStore({ path: dbPath, meta });

if (!existsSync(VICE_X64SC)) { console.error(`x64sc not found`); process.exit(2); }

const port = 6513;
console.log("Spawn x64sc -autostart -warp ...");
const vice = spawn(VICE_X64SC, [
  "-default",
  "-monchislines", "16777215",
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-silent", "-warp", "-autostart-warp",
  "-autostart", resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"),
], { stdio: ["ignore", "ignore", "pipe"] });
vice.stderr.on("data", (d) => process.stderr.write(`[vice] ${d}`));
vice.on("exit", (c) => console.log(`[vice exit ${c}]`));

await new Promise((r) => setTimeout(r, 4000));

const mon = new ViceMonitorClient({ host: "127.0.0.1", port });
await mon.connect(10_000);
console.log("Connected.");
await mon.resume().catch(() => {});

const appender = await store.conn.createAppender("instructions");

let totalC64 = 0, totalDrv = 0;
let lastClkC64 = -1n, lastClkDrv = -1n;
let globalSeq = 0;
const runId = meta.runId;

async function poll(memspace, source, getLastClock, setLastClock) {
  // Pause briefly to read cpuhistory.
  let hist = [];
  try { hist = await mon.getCpuHistory(50_000, memspace); }
  catch (e) { console.log(`hist err ${source}: ${e.message}`); return 0; }
  const lastClk = getLastClock();
  let newRows = 0;
  let maxClk = lastClk;
  // Register id map (per VICE binmon spec)
  const REG_A = 0, REG_X = 1, REG_Y = 2, REG_PC = 3, REG_SP = 4, REG_SR = 5;
  for (const item of hist) {
    const clk = BigInt(item.clock);
    if (clk <= lastClk) continue;
    if (clk > maxClk) maxClk = clk;
    const regs = item.registers ?? [];
    const get = (id) => regs.find((r) => r.id === id)?.value ?? 0;
    const ib = item.instructionBytes ?? [];
    const opcode = ib[0] ?? 0;
    const b1 = ib[1];
    const b2 = ib[2];
    appender.appendVarchar(runId);
    appender.appendUBigInt(BigInt(globalSeq++));
    appender.appendVarchar(source);
    appender.appendUBigInt(clk);
    appender.appendUBigInt(clk);
    appender.appendUSmallInt(get(REG_PC) & 0xffff);
    appender.appendUTinyInt(opcode & 0xff);
    if (b1 == null) appender.appendNull(); else appender.appendUTinyInt(b1 & 0xff);
    if (b2 == null) appender.appendNull(); else appender.appendUTinyInt(b2 & 0xff);
    appender.appendUTinyInt(get(REG_A) & 0xff);
    appender.appendUTinyInt(get(REG_X) & 0xff);
    appender.appendUTinyInt(get(REG_Y) & 0xff);
    appender.appendUTinyInt(get(REG_SP) & 0xff);
    appender.appendUTinyInt(get(REG_SR) & 0xff);
    appender.appendVarchar("vice");
    appender.endRow();
    newRows++;
  }
  if (maxClk > lastClk) setLastClock(maxClk);
  return newRows;
}

const POLL_MS = 80;
const RUN_FOR_MS = 60_000;
const t0 = Date.now();
let polls = 0;
while (Date.now() - t0 < RUN_FOR_MS) {
  polls++;
  const nC = await poll(0x00, "c64", () => lastClkC64, (v) => { lastClkC64 = v; });
  const nD = await poll(0x01, "drive8", () => lastClkDrv, (v) => { lastClkDrv = v; });
  totalC64 += nC; totalDrv += nD;
  await mon.resume().catch(() => {});
  if (polls % 50 === 0) {
    console.log(`  poll ${polls}: c64+${totalC64} drv+${totalDrv} lastClkC64=${lastClkC64}`);
    appender.flushSync();
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

appender.flushSync();
appender.closeSync();
console.log(`done. polls=${polls} c64=${totalC64} drv=${totalDrv}`);

await mon.quitVice().catch(() => {});
try { vice.kill("SIGKILL"); } catch {}
await closeStore(store);
console.log(`db: ${dbPath}`);
process.exit(0);
