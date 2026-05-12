#!/usr/bin/env node
// Spec 262 Phase A — VIC per-cycle reg-write log smoke.
//
// Validates the additive infrastructure introduced by 262a/b/c without
// touching the existing per-char-row renderer:
//   - 262a: log-infra populates on $D0xx writes; line wrap flushes;
//           frame wrap (raster_y → 0) clears the frame log buffer.
//   - 262b: CIA2 PA writes mirror into the log with reg=0x80.
//   - 262c: renderToPng({frameAligned:true}) advances the c64 forward
//           until the visible region is fully drawn; {frameAligned:false}
//           preserves V1 (zero forward progress).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

console.log("vic-cycle-log smoke — Spec 262 Phase A");

const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});
const vic = session.vic;

// -------------------------------------------------------------------
// 262a: reg-write log infrastructure
// -------------------------------------------------------------------

check("262a: write to $D020 appends to currentLineLog", () => {
  const before = vic.currentLineLog.writes.length;
  // $D020 (border) — direct VIC.write avoids bus mirror noise.
  vic.write(0x20, 0x07);
  const after = vic.currentLineLog.writes.length;
  if (after !== before + 1) {
    throw new Error(`expected log to grow by 1, got ${after - before}`);
  }
  const last = vic.currentLineLog.writes[after - 1];
  if (last.reg !== 0x20) throw new Error(`reg expected 0x20, got 0x${last.reg.toString(16)}`);
  if (last.value !== 0x07) throw new Error(`value expected 7, got ${last.value}`);
  if (typeof last.cycleInLine !== "number") {
    throw new Error(`cycleInLine missing/wrong type: ${typeof last.cycleInLine}`);
  }
});

check("262a: read does NOT append to log", () => {
  const before = vic.currentLineLog.writes.length;
  vic.read(0x20);
  vic.read(0x12); // raster
  const after = vic.currentLineLog.writes.length;
  if (after !== before) throw new Error(`reads grew log by ${after - before}, expected 0`);
});

check("262a: collision regs $D01E/$D01F writes are NOT logged (read-only at runtime)", () => {
  const before = vic.currentLineLog.writes.length;
  vic.write(0x1e, 0xff);
  vic.write(0x1f, 0xff);
  const after = vic.currentLineLog.writes.length;
  if (after !== before) throw new Error(`collision writes leaked into log: +${after - before}`);
});

check("262a: line wrap flushes currentLineLog into frameLineLogs", () => {
  // Park raster at known state then push a few writes + tick across a
  // line boundary.
  const startFrameLogs = vic.frameLineLogs.length;
  const startLine = vic.raster_y;
  vic.write(0x21, 0x01); // BG0
  // tick enough cycles to cross at least one full line boundary.
  vic.tick(vic.cycles_per_line + 5);
  if (vic.raster_y === startLine) {
    throw new Error(`raster_y did not advance (${startLine} → ${vic.raster_y})`);
  }
  if (vic.frameLineLogs.length <= startFrameLogs) {
    throw new Error(
      `frameLineLogs did not grow on line wrap: was ${startFrameLogs}, now ${vic.frameLineLogs.length}`,
    );
  }
});

check("262a: frame wrap (raster_y → 0) clears frameLineLogs", () => {
  // Force a controlled wrap — tick until just before wrap, prime, wrap.
  // screen_height * cycles_per_line guarantees a wrap.
  const cyclesToWrap = (vic.screen_height - vic.raster_y) * vic.cycles_per_line + 10;
  vic.tick(cyclesToWrap);
  if (vic.raster_y > 200) {
    // Didn't wrap to top — something is off; at minimum frameLineLogs
    // should be bounded by screen_height.
    throw new Error(
      `expected raster_y near 0 after large tick, got ${vic.raster_y}`,
    );
  }
  // After wrap to 0, the buffer was cleared then 1+ lines pushed.
  if (vic.frameLineLogs.length > vic.screen_height) {
    throw new Error(
      `frameLineLogs (${vic.frameLineLogs.length}) exceeds screen_height (${vic.screen_height}) — wrap clear missing`,
    );
  }
});

// -------------------------------------------------------------------
// 262b: CIA2 PA-bank tracking in log
// -------------------------------------------------------------------

check("262b: recordCia2PaChange appends with reg=0x80", () => {
  const before = vic.currentLineLog.writes.length;
  vic.recordCia2PaChange(0x37);
  const after = vic.currentLineLog.writes.length;
  if (after !== before + 1) throw new Error(`expected +1 entry, got +${after - before}`);
  const last = vic.currentLineLog.writes[after - 1];
  if (last.reg !== 0x80) throw new Error(`reg expected 0x80, got 0x${last.reg.toString(16)}`);
  if (last.value !== 0x37) throw new Error(`value expected 0x37, got 0x${last.value.toString(16)}`);
});

check("262b: real CIA2 $DD00 write triggers log entry via kernel hook", () => {
  // Snapshot log size, write 0xDD00, check log grew with reg=0x80.
  const before = vic.currentLineLog.writes.length;
  // CIA2 needs DDR to register an output change. Both DDRA and PRA writes
  // route through the storePa hook.
  session.cia2.write(0x02, 0x3f); // DDRA = 0x3f (low 6 outputs)
  session.cia2.write(0x00, 0x17); // PRA = 0x17 (some VIC bank value)
  const after = vic.currentLineLog.writes.length;
  const cia2Entries = vic.currentLineLog.writes.slice(before).filter((e) => e.reg === 0x80);
  if (cia2Entries.length === 0) {
    throw new Error(
      `no reg=0x80 entries appeared after CIA2 PRA/DDRA writes (delta=${after - before})`,
    );
  }
});

// -------------------------------------------------------------------
// 262c: renderToPng frame-boundary sync
// -------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "smoke-vic-cycle-log-"));

check("262c: renderToPng({frameAligned:true}) advances cycles to visible end", () => {
  const cyclesBefore = session.c64Cpu.cycles;
  const pngPath = join(tmp, "frame-aligned.png");
  const r = session.renderToPng(pngPath, { frameAligned: true });
  const cyclesAfter = session.c64Cpu.cycles;
  if (cyclesAfter <= cyclesBefore) {
    throw new Error(`expected cycles to advance, before=${cyclesBefore} after=${cyclesAfter}`);
  }
  if (r.bytes <= 0) throw new Error(`PNG empty (${r.bytes} bytes)`);
  if (vic.raster_y < vic.first_dma_line + 200) {
    // Permit slight overrun (wrap) but raster must have reached visible end.
    if (vic.raster_y > vic.first_dma_line + 200 || vic.raster_y < 10) {
      // OK — wrapped past target after exit.
    } else {
      throw new Error(
        `raster_y=${vic.raster_y} did not reach target ${vic.first_dma_line + 200}`,
      );
    }
  }
});

check("262c: renderToPng({frameAligned:false}) does NOT advance cycles", () => {
  const cyclesBefore = session.c64Cpu.cycles;
  const pngPath = join(tmp, "frame-not-aligned.png");
  const r = session.renderToPng(pngPath, { frameAligned: false });
  const cyclesAfter = session.c64Cpu.cycles;
  if (cyclesAfter !== cyclesBefore) {
    throw new Error(
      `frameAligned:false should not run cycles; before=${cyclesBefore} after=${cyclesAfter}`,
    );
  }
  if (r.bytes <= 0) throw new Error(`PNG empty (${r.bytes} bytes)`);
});

check("262c: renderToPng() default (no opts) advances (= frameAligned:true default)", () => {
  const cyclesBefore = session.c64Cpu.cycles;
  const pngPath = join(tmp, "frame-default.png");
  session.renderToPng(pngPath);
  const cyclesAfter = session.c64Cpu.cycles;
  if (cyclesAfter <= cyclesBefore) {
    throw new Error(
      `default should equal frameAligned:true and advance cycles; before=${cyclesBefore} after=${cyclesAfter}`,
    );
  }
});

rmSync(tmp, { recursive: true, force: true });

// -------------------------------------------------------------------
console.log("---");
console.log(`summary: ${pass}/${pass + fail} pass, ${fail} fail`);
if (fail > 0) {
  for (const f of failures) console.log(`   × ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);
