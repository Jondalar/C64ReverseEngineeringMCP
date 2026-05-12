// LastNinja Remix headless trace with proper LOAD/RUN pacing.
// Per CLAUDE.md: broad DuckDB capture for diff.

import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const repoRoot = resolvePath(import.meta.dirname, "..");

const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);
const { mountMedia } = await import(`${repoRoot}/dist/runtime/headless/media/mount.js`);
const { openStore, closeStore, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { TraceStoreProducer } = await import(`${repoRoot}/dist/runtime/trace-store/producer.js`);
const { buildAnchors, DEFAULT_MOTM_ANCHORS } = await import(`${repoRoot}/dist/runtime/trace-store/anchor-builder.js`);
const { buildRollups } = await import(`${repoRoot}/dist/runtime/trace-store/rollup-builder.js`);

const PAL_HZ = 985_248;
const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/lnr-headless-paced-${date}`);
mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "trace.duckdb");
if (existsSync(dbPath)) { console.error("delete first:", dbPath); process.exit(2); }

const runId = `lnr-headless-paced-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
const meta = {
  runId, source: "headless", capturedAt: new Date().toISOString(),
  writerVersion: process.env.C64RE_GIT_SHA ?? "dev",
  c64ClockHz: PAL_HZ, driveClockHz: 1_000_000,
  c64ClockZero: 0n, driveClockZero: 0n, driveToC64Offset: 0n,
};
const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

const masterClockMapper = (cpu, sourceClock) => {
  const sc = typeof sourceClock === "bigint" ? sourceClock : BigInt(sourceClock);
  if (cpu === "drive8") return (sc * 985248n) / 1000000n;
  return sc;
};
const producer = new TraceStoreProducer({
  source: "headless",
  sink,
  masterClockMapper,
  capacity: 65536,
});

console.log("Boot...");
session.resetCold("pal-default");
session.runFor(5_000_000);

console.log("Mount LastNinja Remix s1...");
await mountMedia(session, 8, resolvePath(repoRoot, "samples/last_ninja_remix_s1[system3_1991].g64"));

console.log("Attach trace producer...");
const reg = session.traceRegistry;
for (const name of ["cpu", "iec", "irq", "cia", "vic", "gcr", "bus_access"]) {
  reg.configure(name, { mode: "ring", capacity: 16 });
}
const dispose = producer.attach((handler) => reg.registerObserver(handler));

console.log('LOAD"*",8,1...');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
console.log(`  c64.pc=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);

console.log("RUN...");
session.typeText("RUN\r");

// 30s emulated post-RUN — should be enough to see protection check failure
session.runFor(30_000_000);
console.log(`  c64.pc=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);

console.log("Flush trace...");
dispose();
await producer.close();

console.log("Build anchors + rollups...");
await buildAnchors(store, DEFAULT_MOTM_ANCHORS);
await buildRollups(store);

await closeStore(store);

console.log(`done. ${outRoot}`);
process.exit(0);
