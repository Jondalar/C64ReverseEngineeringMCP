#!/usr/bin/env node
// Spec 205-A c2 — kernel trace JSONL artifact smoke.
//
// Verifies:
//   1. bus_access channel in jsonl mode appends real BusAccessEvent
//      records during a brief run.
//   2. Each line parses + carries the documented BusAccessEvent shape
//      (cycle_c64, side, op, addr, value, pc, iec, seq).
//   3. closeAll flushes the fd cleanly.

import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

const tmpDir = join(tmpdir(), `c64re-trace-smoke-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
const jsonlPath = join(tmpDir, "bus_access.jsonl");

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

console.log("kernel-trace smoke — Spec 205-A c2 acceptance");

// Spec 205-A c1: enableBusAccessTrace creates the producer; kernel
// trace controller registers it. JSONL mode set BEFORE the run so
// every emit hits the file.
const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
  enableBusAccessTrace: true,
});
const kernel = session.kernel;
kernel.trace().configureChannel("bus_access", { mode: "jsonl", path: jsonlPath });

check("bus_access channel reports enabled after configure", () => {
  if (!kernel.trace().isEnabled("bus_access")) throw new Error("not enabled");
});

session.resetCold();
session.runFor(50_000);

kernel.trace().closeAll();

let lines = [];
check("JSONL artifact written + non-empty", () => {
  if (!existsSync(jsonlPath)) throw new Error(`file missing: ${jsonlPath}`);
  const raw = readFileSync(jsonlPath, "utf8");
  lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("no JSONL lines written");
});

check("each line parses + carries TraceEvent envelope", () => {
  const sample = Math.min(lines.length, 50);
  for (let i = 0; i < sample; i++) {
    const ev = JSON.parse(lines[i]);
    if (typeof ev.ts !== "number") throw new Error(`line ${i}: ts not number`);
    if (ev.channel !== "bus_access") throw new Error(`line ${i}: channel = ${ev.channel}`);
    if (!ev.data || typeof ev.data !== "object") throw new Error(`line ${i}: data missing`);
  }
});

check("BusAccessEvent shape (cycle_c64 / side / op / addr / iec / seq)", () => {
  const ev = JSON.parse(lines[0]).data;
  for (const field of ["cycle_c64", "cycle_drive", "side", "op", "addr", "value", "pc", "iec", "seq"]) {
    if (ev[field] === undefined) throw new Error(`missing field: ${field}`);
  }
  if (ev.side !== "c64" && ev.side !== "drive") throw new Error(`bad side: ${ev.side}`);
  if (ev.op !== "read" && ev.op !== "write") throw new Error(`bad op: ${ev.op}`);
  if (typeof ev.iec !== "object") throw new Error("iec snapshot missing");
  for (const f of ["atn", "clk", "data", "c64_atn", "c64_clk", "c64_data", "drv_clk", "drv_data"]) {
    if (ev.iec[f] !== 0 && ev.iec[f] !== 1) throw new Error(`iec.${f} not 0/1: ${ev.iec[f]}`);
  }
});

check("seq numbers are monotonic", () => {
  let prev = -1;
  for (const l of lines) {
    const seq = JSON.parse(l).data.seq;
    if (seq <= prev) throw new Error(`seq not monotonic: ${prev} -> ${seq}`);
    prev = seq;
  }
});

check("getBusAccessProducer returns the registered producer", () => {
  const prod = kernel.trace().getBusAccessProducer();
  if (!prod) throw new Error("producer missing on kernel trace controller");
  if (typeof prod.getSeqCount !== "function") throw new Error("producer surface broken");
  if (prod.getSeqCount() !== lines.length) {
    throw new Error(`producer seq count = ${prod.getSeqCount()}, lines = ${lines.length}`);
  }
});

check("irq channel captures emitIrqEvent edges (Spec 205-A c3)", () => {
  // Re-configure irq channel as ring; emit probe edge + serviced;
  // walk the ring.
  kernel.trace().configureChannel("irq", { mode: "ring", capacity: 32 });
  const probe = kernel.emitIrqEvent({
    line: "irq",
    asserted: true,
    source: "cia1",
    target: "c64-cpu",
    edgeClock: 5555,
    visibleClock: 5555,
  });
  kernel.markIrqServiced("c64-cpu", "irq", 5562);
  const ring = kernel.trace().getRing("irq");
  if (ring.length < 2) throw new Error(`expected >= 2 events, got ${ring.length}`);
  const edge = ring.find((e) => e.data.seq === probe.seq && !e.data.kind);
  if (!edge) throw new Error("edge event missing in irq channel");
  if (edge.data.source !== "cia1") throw new Error(`source = ${edge.data.source}`);
  const serviced = ring.find((e) => e.data.kind === "serviced" && e.data.seq === probe.seq);
  if (!serviced) throw new Error("serviced event missing in irq channel");
  if (serviced.data.servicedClock !== 5562) {
    throw new Error(`servicedClock = ${serviced.data.servicedClock}`);
  }
  kernel.trace().configureChannel("irq", { mode: "off" });
});

session.shutdown?.();
rmSync(tmpDir, { recursive: true, force: true });

console.log("---");
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
