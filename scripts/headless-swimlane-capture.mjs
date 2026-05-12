#!/usr/bin/env node
// Spec 143 complement — Headless swimlane capture.
//
// Emits row-aligned chip-state snapshots in the EXACT SAME JSONL schema as
// vice-iec-capture.mjs --swimlane so the two files can be diffed line-by-line
// to find the first behavioral divergence between VICE and our headless runtime
// during motm boot.
//
// Usage:
//   node scripts/headless-swimlane-capture.mjs [--id motm]
//        [--max-events 200] [--cycle-budget 50000000]
//        [--probe-mode A|B|C] [--out <path>]
//
// Output: traces/swimlane_motm_<ts>/headless.jsonl  (default)
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC-POINT TRIGGERS (mirrors VICE swimlane 8 checkpoints)
//
//   c64-r-DD00  C64 read  CIA2 PA  ($DD00) — IEC bus C64 side
//   c64-w-DD00  C64 write CIA2 PA  ($DD00)
//   c64-r-DC0D  C64 read  CIA1 ICR ($DC0D) — KERNAL serial timer IRQ
//   c64-w-DC0D  C64 write CIA1 ICR ($DC0D)
//   drv-r-1800  Drive read  VIA1 PRB ($1800) — IEC bus drive side
//   drv-w-1800  Drive write VIA1 PRB ($1800)
//   drv-r-1C00  Drive read  VIA2 PRB ($1C00) — head/motor (completeness)
//   drv-w-1C00  Drive write VIA2 PRB ($1C00)
//
// ROW SCHEMA (verbatim — matches VICE side):
// {
//   "ts":    <c64_cycle>,
//   "tdrv":  <drive_cycle>,
//   "src":   "<event-tag>",
//   "addr":  <hit-addr>,
//   "value": <byte-on-bus>,
//   "c64":  { "pc","a","x","y","sp","p" },
//   "vic":  { "raster","ctrl1","irq","imr" },
//   "cia1": { "pra","prb","icr","imr","ta","tb","cra","crb" },
//   "cia2": { "pra","prb","icr","imr","ta","tb","cra","crb" },
//   "iec":  { "atn","clk","data","srq" },
//   "drv":  { "pc","a","x","y","sp","p" },
//   "via1": { "pra","prb","ifr","ier","pcr","acr" },
//   "via2": { "pra","prb","ifr","ier" }
// }
//
// IEC PIN FORMULA (must match VICE side — c64iec.c + c64cia2.c):
//   atn  = 1 if cia2_pa bit3 == 0  (ATN C64-only, bit3 pulled low = asserted)
//   clk  = 1 if cia2_pa bit6 == 0  (CLK_IN: 0 means line is low)
//   data = 1 if cia2_pa bit7 == 0  (DATA_IN: 0 means line is low)
//   srq  = 0  (not wired)
//
//   CIA2 PA is read from cia2.c_cia[0] (the PRA latch). The IEC input pins
//   (CLK_IN bit6, DATA_IN bit7) are composed by CIA2's backend readPa callback
//   from iec.buildC64InputBits(), but for the swimlane snapshot we derive from
//   the SAME values that the VICE side uses: cia2.c_cia[CIA_PRA] = the composed
//   PA byte after backend.readPa() merges latch + bus lines. We call
//   cia2.read(0) which triggers the read path, then immediately read the
//   snapshot from c_cia[0]. To avoid double-triggering, we use cia2.last_read
//   which is the byte the CPU just saw.
//
//   Alternative: derive atn/clk/data directly from IecBus getters which also
//   use the VICE-faithful core. We use cia2.c_cia[0] for the pra field so both
//   pra and the derived iec fields come from the same source of truth.
//
// NON-SIDE-EFFECTING READS:
//   CIA ICR ($DC0D / $DD0D): reading ICR on real hardware and in our CIA port
//   clears the latch (IRQ flags). For snapshot-only observation we read the
//   raw irqflags field directly from Cia6526Vice.irqflags (VICE field verbatim)
//   WITHOUT calling cia.read(CIA_ICR). This matches VICE's own snapshot path.
//   The pra/prb snapshot calls cia.c_cia[CIA_PRA] (register array) — no side
//   effect because c_cia[0] holds the last composed PA value from the backend.
//   imr: VICE IMR is stored in cia.irq_enabled. We read it directly.
//
//   VIA1 IFR / IER / PCR / ACR: Via6522Vice.ifr / .ier / .pcr / .acr are
//   direct field reads — no side effects (they are internal state registers,
//   not go-through-handler reads). Similarly for VIA2.
//
// BOOT SEQUENCE:
//   Mirrors bus-trace-motm.mjs Phase A (LOAD"*",8,1 → RUN). Fires on ALL
//   $DD00 / $DC0D / $1800 / $1C00 accesses from the start of execution
//   (no PC-window filter) so the capture is boot-phase-independent and can
//   be aligned against the VICE capture which also starts from reset.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const id = args.id ?? "motm";
const maxEvents = Number(args["max-events"] ?? 200);
const cycleBudget = Number(args["cycle-budget"] ?? 50_000_000);
const probeMode = args["probe-mode"];
// Phase-aware capture: skip rows until ts >= startCycle. Used to align
// captures with VICE side which begins its window post-autoboot. Set
// to 0 to capture from cold-boot.
const startCycle = Number(args["start-cycle"] ?? 0);
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;

// Load manifest to find the disk image.
const manifestPath = join(repoRoot, "samples/test-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) {
  console.error(`Manifest entry not found: id=${id}`);
  console.error(`Available ids: ${manifest.entries.map((e) => e.id).join(", ")}`);
  process.exit(2);
}
const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) {
  console.error(`Disk image missing (gitignored — local only): ${diskPath}`);
  process.exit(2);
}

const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
let outPath;
if (args.out) {
  outPath = resolve(projectDir, args.out);
} else {
  // Match VICE side: dedicated swimlane sub-directory, file named headless.jsonl.
  const swimDir = join(projectDir, "traces", `swimlane_${id}_${tsTag}`);
  mkdirSync(swimDir, { recursive: true });
  outPath = join(swimDir, "headless.jsonl");
}
mkdirSync(dirname(outPath), { recursive: true });

console.error(`Headless swimlane capture (Spec 143 complement)`);
console.error(`Manifest: ${entry.id} (${entry.family})`);
console.error(`Disk: ${diskPath}`);
console.error(`Output: ${outPath}`);
console.error(`Max events: ${maxEvents}  Cycle budget: ${cycleBudget.toLocaleString()}`);
if (probeMode) console.error(`Probe mode: ${probeMode}`);

// ─────────────────────────────────────────────────────────────────────────────
// Import runtime (built dist).
// ─────────────────────────────────────────────────────────────────────────────
const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

// ─────────────────────────────────────────────────────────────────────────────
// Start session.
// ─────────────────────────────────────────────────────────────────────────────
const { session } = startIntegratedSession({
  diskPath,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
  probeMode: probeMode === "A" || probeMode === "B" || probeMode === "C" ? probeMode : undefined,
});

// References to chip objects (after construction).
const cia1 = session.cia1;
const cia2 = session.cia2;
const vic = session.vic;
const via1 = session.drive.bus.via1;
const via2 = session.drive.bus.via2;
const iecBus = session.iecBus;
const c64Cpu = session.c64Cpu;
const driveCpu = session.drive.cpu;
const scheduler = session.scheduler;

// ─────────────────────────────────────────────────────────────────────────────
// Swimlane capture state.
// ─────────────────────────────────────────────────────────────────────────────
let eventCount = 0;
let stopped = false;

/** Read c64 cycle from scheduler (cycle-lockstep) or cpu fallback. */
function ts() { return scheduler ? scheduler.c64Cycle() : c64Cpu.cycles; }
/** Read drive cycle from scheduler or drive cpu fallback. */
function tdrv() { return scheduler ? scheduler.driveCycle() : driveCpu.cycles; }

// ─────────────────────────────────────────────────────────────────────────────
// IEC pin derivation — matches VICE c64cia2.c formula (swimlane doc lines 52-68).
//
// CIA2 PA bit layout (c64cia2.c lines 157-162):
//   Bit 3  ATN  output  (0 = asserted / line low)
//   Bit 4  CLK  output  (0 = asserted / line low)   [not directly visible in PA read]
//   Bit 5  DATA output  (0 = asserted / line low)   [not directly visible in PA read]
//   Bit 6  CLK  input   (0 = line low)
//   Bit 7  DATA input   (0 = line low)
//
// We use the COMPOSED CIA2 PA byte (what the C64 CPU reads from $DD00): this
// is cia2.c_cia[CIA_PRA] after the last backend.readPa() merge — which is
// exactly what VICE readMemory($DD00) returns in the swimlane capture.
//
// The IecBus getters (atnLine / clkLine / dataLine) would also give the same
// result, but using cia2.c_cia[0] keeps pra and the iec derivation from
// the same single source, matching VICE exactly.
// ─────────────────────────────────────────────────────────────────────────────
function iecFromCia2Pra(pra) {
  const atn  = ((pra >> 3) & 1) ^ 1;   // bit3 low → ATN asserted → 1
  const clk  = ((pra >> 6) & 1) ^ 1;   // bit6 low → CLK line low → 1
  const data = ((pra >> 7) & 1) ^ 1;   // bit7 low → DATA line low → 1
  const srq  = 0;
  return { atn, clk, data, srq };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot helpers — non-side-effecting reads.
// ─────────────────────────────────────────────────────────────────────────────

/** Read CIA state without triggering ICR-clear side effects.
 *
 * pra / prb:  c_cia register array (last composed value — no side effect).
 * icr:        cia.irqflags & 0xff — same as VICE snapshot field; does NOT
 *             clear the latch (unlike cia.read(CIA_ICR) which would).
 * imr:        cia.irq_enabled — VICE's irq_enabled field is the mask register.
 * ta / tb:    ciat.cnt (live counter via ta.readTimer()).
 * cra / crb:  c_cia[14] / c_cia[15] (CRA / CRB).
 */
function snapCia(cia) {
  const pra  = cia.c_cia[0] ?? 0;      // CIA_PRA = 0
  const prb  = cia.c_cia[1] ?? 0;      // CIA_PRB = 1
  // ICR: peek irqflags directly — does NOT clear latch (unlike read()).
  const icr  = cia.irqflags & 0xff;
  // IMR: VICE stores the enabled-mask in irq_enabled.
  const imr  = cia.irq_enabled & 0xff;
  // TA / TB: Ciat.readTimer() returns the current counter (no side effect).
  const ta   = cia.ta.readTimer() & 0xffff;
  const tb   = cia.tb.readTimer() & 0xffff;
  const cra  = cia.c_cia[14] ?? 0;     // CIA_CRA = 14
  const crb  = cia.c_cia[15] ?? 0;     // CIA_CRB = 15
  return { pra, prb, icr, imr, ta, tb, cra, crb };
}

/** Capture VIC state — non-side-effecting.
 *
 * raster:  vic.raster_y (live raster line counter).
 * ctrl1:   vic.regs[0x11] (VICII_R_CTRL1 = 0x11).
 * irq:     vic.irq_status & 0xff (bit set = active).
 * imr:     vic.regs[0x1a] (VICII_R_IRQ_MASK = 0x1a).
 *
 * All fields are direct struct reads — no side effects.
 * (VIC.read($D012) side-effect is raster latch; we skip that path.)
 */
function snapVic() {
  return {
    raster: vic.raster_y & 0x1ff,
    ctrl1:  (vic.regs[0x11] ?? 0) & 0xff,
    irq:    vic.irq_status & 0xff,
    imr:    (vic.regs[0x1a] ?? 0) & 0xff,
  };
}

/** Capture VIA1 state — non-side-effecting.
 *
 * pra / prb:  via.via[VIA_PRA] / via.via[VIA_PRB] (register array).
 * ifr / ier:  via1.ifr / via1.ier (Via1d1541 pass-through → Via6522Vice fields).
 * pcr / acr:  via1.pcr / via1.acr (same).
 *
 * All direct field reads; no side effects.
 */
function snapVia1() {
  return {
    pra: via1.ora & 0xff,         // ORA latch = VIA_PRA
    prb: via1.orb & 0xff,         // ORB latch = VIA_PRB
    ifr: via1.ifr & 0xff,
    ier: via1.ier & 0xff,
    pcr: via1.pcr & 0xff,
    acr: via1.acr & 0xff,
  };
}

/** Capture VIA2 state — non-side-effecting. Same approach as VIA1. */
function snapVia2() {
  return {
    pra: via2.ora & 0xff,
    prb: via2.orb & 0xff,
    ifr: via2.ifr & 0xff,
    ier: via2.ier & 0xff,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emit one swimlane row.
// ─────────────────────────────────────────────────────────────────────────────
function emitRow(src, addr, value) {
  if (stopped) return;

  const rowTs   = ts();
  const rowTdrv = tdrv();
  // Phase-aware: skip rows before startCycle threshold.
  if (rowTs < startCycle) return;

  // C64 CPU state.
  const c64 = {
    pc: c64Cpu.pc & 0xffff,
    a:  c64Cpu.a  & 0xff,
    x:  c64Cpu.x  & 0xff,
    y:  c64Cpu.y  & 0xff,
    sp: c64Cpu.sp & 0xff,
    p:  (c64Cpu.flags ?? c64Cpu.p ?? 0) & 0xff,
  };

  // Drive CPU state.
  const drv = {
    pc: driveCpu.pc & 0xffff,
    a:  driveCpu.a  & 0xff,
    x:  driveCpu.x  & 0xff,
    y:  driveCpu.y  & 0xff,
    sp: driveCpu.sp & 0xff,
    p:  (driveCpu.flags ?? driveCpu.p ?? 0) & 0xff,
  };

  const vicSnap  = snapVic();
  const cia1Snap = snapCia(cia1);
  const cia2Snap = snapCia(cia2);

  // IEC pins derived from CIA2 PRA (VICE-faithful formula).
  const cia2Pra = cia2.c_cia[0] ?? 0;
  const iec = iecFromCia2Pra(cia2Pra);

  const via1Snap = snapVia1();
  const via2Snap = snapVia2();

  const row = {
    ts: rowTs,
    tdrv: rowTdrv,
    src,
    addr,
    value: value & 0xff,
    c64,
    vic: vicSnap,
    cia1: cia1Snap,
    cia2: cia2Snap,
    iec,
    drv,
    via1: via1Snap,
    via2: via2Snap,
  };

  appendFileSync(outPath, JSON.stringify(row) + "\n");
  eventCount++;

  if (eventCount % 10 === 0) {
    console.error(`  [${eventCount}] ts=${rowTs} tdrv=${rowTdrv} src=${src} val=$${(value & 0xff).toString(16).padStart(2, "0")}`);
  }

  if (eventCount >= maxEvents) stopped = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install hooks via IoHandler wrapping.
//
// Strategy: intercept the existing IoHandler registrations by registering
// WRAPPER handlers on the memory bus for the 4 target addresses. The wrappers
// call through to the real handler (CIA or VIA read/write) then emit a row.
//
// We cannot pre-register — the CIA/VIA handlers are already registered by
// installCia1/installCia2 during IntegratedSession construction. We re-register
// at the same addresses; HeadlessMemoryBus.registerIoHandler replaces existing
// entries (Map.set semantics). The replacement handler wraps the original.
//
// Addresses to hook:
//   $DC0D (CIA1 ICR) — C64 side, reg = 0xdc0d & 0xf = 13
//   $DD00 (CIA2 PA)  — C64 side, reg = 0xdd00 & 0xf = 0
//   $1800 (VIA1 PRB) — drive bus, handled in DriveBus.read/write
//   $1C00 (VIA2 PRB) — drive bus, handled in DriveBus.read/write
//
// Note: $DD00/$DC0D are already emitting via iecBus.busAccessProducer on the
// VICE-compare path. For swimlane we need a fresh hook that captures ALL
// accesses (not filtered by PC window) and emits the swimlane row format.
// ─────────────────────────────────────────────────────────────────────────────

// --- C64 $DC0D (CIA1 ICR) ---
const C64_CIA1_BASE = 0xdc00;
const CIA_ICR_REG = 13;
const DC0D_ADDR = C64_CIA1_BASE + CIA_ICR_REG;  // 0xDC0D

// Wrap CIA1 ICR read/write.
session.c64Bus.registerIoHandler(DC0D_ADDR, {
  read: () => {
    const val = cia1.read(CIA_ICR_REG);
    emitRow("c64-r-DC0D", DC0D_ADDR, val);
    return val;
  },
  write: (_a, v) => {
    cia1.write(CIA_ICR_REG, v);
    emitRow("c64-w-DC0D", DC0D_ADDR, v);
  },
});

// --- C64 $DD00 (CIA2 PA) ---
const C64_CIA2_BASE = 0xdd00;
const CIA2_PA_REG = 0;
const DD00_ADDR = C64_CIA2_BASE + CIA2_PA_REG;  // 0xDD00

// Wrap CIA2 PA read/write.
session.c64Bus.registerIoHandler(DD00_ADDR, {
  read: () => {
    const val = cia2.read(CIA2_PA_REG);
    emitRow("c64-r-DD00", DD00_ADDR, val);
    return val;
  },
  write: (_a, v) => {
    cia2.write(CIA2_PA_REG, v);
    emitRow("c64-w-DD00", DD00_ADDR, v);
  },
});

// --- Drive $1800 (VIA1 PRB) and $1C00 (VIA2 PRB) ---
// The drive bus (DriveBus) handles reads/writes to $1800 and $1C00 via
// via1.read(reg) / via1.write(reg, val). We intercept by wrapping the
// DriveBus.read / DriveBus.write methods.
//
// DriveBus address map:
//   $1800-$180F → via1 (reg = addr & 0xF, PRB = reg 0)
//   $1C00-$1C0F → via2 (reg = addr & 0xF, PRB = reg 0)

const driveBus = session.drive.bus;
const origDriveRead = driveBus.read.bind(driveBus);
const origDriveWrite = driveBus.write.bind(driveBus);

driveBus.read = (addr) => {
  const val = origDriveRead(addr);
  const a16 = addr & 0xffff;
  if (!stopped) {
    if (a16 === 0x1800) emitRow("drv-r-1800", 0x1800, val);
    else if (a16 === 0x1c00) emitRow("drv-r-1C00", 0x1c00, val);
  }
  return val;
};

driveBus.write = (addr, val) => {
  origDriveWrite(addr, val);
  const a16 = addr & 0xffff;
  if (!stopped) {
    if (a16 === 0x1800) emitRow("drv-w-1800", 0x1800, val);
    else if (a16 === 0x1c00) emitRow("drv-w-1C00", 0x1c00, val);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Boot + run.
// ─────────────────────────────────────────────────────────────────────────────

session.resetCold();

// Phase A: autoboot — mirror bus-trace-motm.mjs.
if (scheduler) scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');
if (scheduler) scheduler.runCycles(2_000_000);
session.typeText("RUN\n");

console.error(`Phase A complete (autoboot typed): c64 cyc=${ts()}`);

// Phase B: run until maxEvents or cycle budget.
const t0 = Date.now();
const chunkSize = 50_000;
let stepped = 0;

while (!stopped && stepped < cycleBudget) {
  const chunk = Math.min(chunkSize, cycleBudget - stepped);
  if (scheduler) {
    scheduler.runCycles(chunk);
  } else {
    for (let i = 0; i < chunk; i++) c64Cpu.step();
  }
  stepped += chunk;
}

const elapsed = Date.now() - t0;

console.error(``);
console.error(`Run complete in ${elapsed} ms`);
console.error(`Cycles stepped: ${stepped.toLocaleString()}  Events captured: ${eventCount}`);
console.error(`Output: ${outPath}`);

if (eventCount === 0) {
  console.error(`WARNING: No events captured. Check that the disk image boots and triggers sync addresses.`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary — src distribution.
// ─────────────────────────────────────────────────────────────────────────────
const lines = (await import("node:fs")).readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));
const dist = {};
for (const r of rows) dist[r.src] = (dist[r.src] ?? 0) + 1;
console.error(`Src distribution:`);
for (const [src, count] of Object.entries(dist).sort()) {
  console.error(`  ${src.padEnd(14)} ${count}`);
}
if (rows.length > 0) {
  const first = rows[0];
  const last  = rows[rows.length - 1];
  console.error(`ts range: ${first.ts} → ${last.ts}  tdrv: ${first.tdrv} → ${last.tdrv}`);
}

// Schema spot-check: verify required top-level keys.
const required = ["ts","tdrv","src","addr","value","c64","vic","cia1","cia2","iec","drv","via1","via2"];
const sample = rows[0] ?? {};
const missing = required.filter((k) => !(k in sample));
if (missing.length > 0) {
  console.error(`SCHEMA ERROR: missing keys: ${missing.join(", ")}`);
  process.exit(1);
} else {
  console.error(`Schema OK: all required keys present in first row.`);
}
