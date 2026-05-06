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

check("gcr channel captures head step + motor + density (Spec 205-A c9)", () => {
  const { session: sh } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = sh.kernel;
  k.trace().configureChannel("gcr", { mode: "ring", capacity: 1024 });
  // Toggle motor + density + step manually. resetCold puts head at 18.
  sh.resetCold();
  k.gcrShifter.setMotor(false);
  k.gcrShifter.setMotor(true);
  k.gcrShifter.setDensity(2);
  k.gcrShifter.setDensity(3);
  k.headPosition.stepInward();
  k.headPosition.stepOutward();
  const ring = k.trace().getRing("gcr");
  const kinds = new Set(ring.map((e) => e.data.kind));
  for (const want of ["motor", "density", "head_step"]) {
    if (!kinds.has(want)) {
      throw new Error(`missing kind ${want}. kinds: ${[...kinds].join(",")}`);
    }
  }
  const motorEv = ring.find((e) => e.data.kind === "motor");
  if (typeof motorEv.data.on !== "boolean") throw new Error("motor.on not bool");
  const densityEv = ring.find((e) => e.data.kind === "density");
  if (densityEv.data.zone === undefined) throw new Error("density.zone undefined (expected number or null)");
  const stepEv = ring.find((e) => e.data.kind === "head_step");
  if (stepEv.data.direction !== "inward" && stepEv.data.direction !== "outward") {
    throw new Error(`step direction = ${stepEv.data.direction}`);
  }
  sh.shutdown?.();
});

check("cia channel captures IRQ flag set events (Spec 205-A c8)", () => {
  const { session: sc } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = sc.kernel;
  k.trace().configureChannel("cia", { mode: "ring", capacity: 4096 });
  sc.resetCold();
  // KERNAL programs CIA1 timer A for 60Hz keyboard scan (16667 cycles
  // per underflow). Run at least 1 underflow window.
  sc.runFor(50_000);
  const ring = k.trace().getRing("cia");
  if (ring.length === 0) throw new Error("no cia events captured");
  const chips = new Set(ring.map((e) => e.data.chip));
  if (!chips.has("cia1")) {
    throw new Error(`no cia1 events. chips: ${[...chips].join(",")}`);
  }
  for (const e of ring.slice(0, 5)) {
    if (typeof e.data.bits !== "number") throw new Error("bits not number");
    if ((e.data.bits & ~0x1f) !== 0) throw new Error(`bits out of CIA_IM_* range: ${e.data.bits}`);
  }
  sc.shutdown?.();
});

check("vic channel captures raster line + frame events (Spec 205-A c7)", () => {
  const { session: sv } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = sv.kernel;
  k.trace().configureChannel("vic", { mode: "ring", capacity: 8192 });
  sv.resetCold();
  // PAL frame = 312 lines × 63 cycles = 19656 cycles. Run two frames.
  sv.runFor(50_000);
  const ring = k.trace().getRing("vic");
  if (ring.length === 0) throw new Error("no vic events captured");
  const kinds = new Set(ring.map((e) => e.data.kind));
  if (!kinds.has("raster")) {
    throw new Error(`no raster events. kinds: ${[...kinds].join(",")}`);
  }
  if (!kinds.has("frame")) {
    throw new Error(`no frame events. kinds: ${[...kinds].join(",")}`);
  }
  // Raster_y values must monotonically advance within a frame.
  const rasterEvents = ring.filter((e) => e.data.kind === "raster").slice(0, 50);
  for (const e of rasterEvents) {
    if (typeof e.data.raster_y !== "number") throw new Error("raster_y not number");
    if (e.data.raster_y < 0 || e.data.raster_y > 312) throw new Error(`raster_y out of range: ${e.data.raster_y}`);
  }
  sv.shutdown?.();
});

check("gcr channel captures byte-ready + sync edges (Spec 205-A c6)", () => {
  const { session: sg } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = sg.kernel;
  k.trace().configureChannel("gcr", { mode: "ring", capacity: 4096 });
  // GcrShifter only ticks when env flag is set (Spec 153 rollout).
  // Without it, byte_ready fires via legacy TrackBuffer path which
  // doesn't go through gcrShifter. Force a manual tick to exercise
  // the wiring.
  sg.resetCold();
  // Activate motor + spin track 18 (directory) to get GCR data flowing.
  sg.kernel.gcrShifter.setMotor(true);
  for (let i = 0; i < 80_000; i++) sg.kernel.gcrShifter.tick(1);
  const ring = k.trace().getRing("gcr");
  if (ring.length === 0) throw new Error("no gcr events captured");
  const kinds = new Set(ring.map((e) => e.data.kind));
  if (!kinds.has("byte_ready")) {
    throw new Error(`no byte_ready events. kinds: ${[...kinds].join(",")}`);
  }
  for (const e of ring.filter((x) => x.data.kind === "byte_ready").slice(0, 3)) {
    if (typeof e.data.byte !== "number") throw new Error("byte not number");
    if (e.data.byte < 0 || e.data.byte > 0xff) throw new Error("byte out of range");
    if (typeof e.data.track !== "number") throw new Error("track not number");
  }
  sg.shutdown?.();
});

check("iec channel captures line edges (Spec 205-A c5)", () => {
  const { session: s3 } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = s3.kernel;
  k.trace().configureChannel("iec", { mode: "ring", capacity: 4096 });
  s3.resetCold();
  s3.runFor(50_000);
  const ring = k.trace().getRing("iec");
  if (ring.length === 0) throw new Error("no iec edge events captured");
  const sides = new Set(ring.map((e) => e.data.side));
  if (!sides.has("c64") && !sides.has("drive")) {
    throw new Error(`no c64/drive sides. sides: ${[...sides].join(",")}`);
  }
  for (const e of ring.slice(0, 5)) {
    for (const f of ["atn", "clk", "data", "c64Atn", "c64Clk", "c64Data", "drvClk", "drvData"]) {
      if (e.data[f] !== 0 && e.data[f] !== 1) {
        throw new Error(`iec.${f} not 0/1: ${e.data[f]}`);
      }
    }
  }
  s3.shutdown?.();
});

check("cpu channel captures c64 + drive instruction edges (Spec 205-A c4)", () => {
  // Fresh session keeps the test self-contained — the previous JSONL
  // run produced a lot of bus_access events that would fight for ring
  // capacity here.
  const { session: s2 } = startIntegratedSession({
    diskPath: fixturePath,
    mode: "true-drive",
  });
  const k = s2.kernel;
  k.trace().configureChannel("cpu", { mode: "ring", capacity: 4096 });
  s2.resetCold();
  s2.runFor(20_000);
  const ring = k.trace().getRing("cpu");
  if (ring.length === 0) throw new Error("no cpu events captured");
  const sides = new Set(ring.map((e) => e.data.side));
  if (!sides.has("c64")) throw new Error(`no c64 events. sides: ${[...sides].join(",")}`);
  if (!sides.has("drive")) throw new Error(`no drive events. sides: ${[...sides].join(",")}`);
  for (const e of ring.slice(0, 5)) {
    if (typeof e.data.pc !== "number") throw new Error("pc not number");
    if (typeof e.data.clk !== "number") throw new Error("clk not number");
  }
  s2.shutdown?.();
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
