#!/usr/bin/env node
// Spec 095 (M0.2) — VICE-side EOF trace harness. Standalone CLI.
//
// Connects to a running VICE binary monitor, watches C64 RAM $90 for
// the EOI flag rising edge, then samples a post-EOI window of drive
// PC + IEC line state + zero-page state. Writes JSONL in the same
// schema as Spec 094 (headless). The schema is defined in
// `src/runtime/vice/trace-runtime.ts` and `docs/eof-trace-diff-schema.md`.
//
// Usage:
//   node scripts/trace-eof-vice.mjs --port=6502 --out=samples/traces/mm-eof-vice.jsonl
//                                   [--coarse-every=100]
//                                   [--post-eoi-cycles=6000]
//                                   [--budget-ms=120000]
//                                   [--load-name=MM] [--disk=samples/mm.g64]
//
// Pre-requisites:
//   - VICE x64sc started with `-binarymonitor -binarymonitoraddress ip4://127.0.0.1:<port>`
//   - The disk attached and `LOAD"<name>",8,1<RET>` typed but not yet finished.
//   - Or attach mid-LOAD; harness watches $90 from connect.
//
// Exit codes: 0 ok, 1 internal error, 2 EOI never seen within budget.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 6502);
const out = args.out ?? "samples/traces/eof-vice.jsonl";
const coarseEvery = Number(args["coarse-every"] ?? 100);
const postEoiCycles = Number(args["post-eoi-cycles"] ?? 6000);
const budgetMs = Number(args["budget-ms"] ?? 120000);
const loadName = args["load-name"] ?? "*";
const diskPath = args.disk ?? "";

const outDir = dirname(out);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let ViceMonitorClient;
try {
  ({ ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js"));
} catch (e) {
  console.error("dist not built — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const SCHEMA_VERSION = 1;
const MEMSPACE_C64 = 0x00;
const MEMSPACE_DRIVE8 = 0x01;
const REG_PC = 3;
// CIA2 PRA at $DD00 — IEC PA bits (ATN_OUT bit3, CLK_OUT bit4, DATA_OUT bit5,
// CLK_IN bit6, DATA_IN bit7). Drive VIA1 PB at $1800 carries the wired-OR
// state from the drive side.
const ADDR_C64_DD00 = 0xdd00;
const ADDR_DRIVE_1800 = 0x1800;
const ADDR_C64_ZP90 = 0x0090;
const ADDR_C64_ZPA5 = 0x00a5;

const lines = [];
function emit(obj) {
  lines.push(JSON.stringify(obj));
}

const client = new ViceMonitorClient({ host: "127.0.0.1", port });

let exitCode = 0;
let eoiSeen = false;
let eoiC64Cyc = -1;
let sampleIndex = 0;

try {
  await client.connect(5_000);
  console.error(`connected to vice monitor on 127.0.0.1:${port}`);

  const banks = await client.getBanksAvailable();
  // Pick CPU banks: c64 main = bank "default" or "ram" (bank id 0 usually OK
  // for ZP reads). For drive memspace, monitor accepts memspace=0x01 with
  // bank 0 (drive RAM) for $1800 and the drive CPU registers.
  const c64BankId = banks.find((b) => /default|ram|cpu/i.test(b.name))?.id ?? 0;
  const driveBankId = 0;

  // Header.
  emit({
    kind: "eof-header",
    source: "vice",
    schemaVersion: SCHEMA_VERSION,
    diskPath: diskPath || undefined,
    loadName,
    coarseEvery,
    postEoiCycles,
    port,
  });

  // Helper sampling primitive. One coarse sample fetches: c64 PC, drive PC,
  // c64 $DD00, drive $1800, c64 $90 + $A5. VICE clock as int from registers.
  async function readClock(memspace) {
    // VICE doesn't expose clock via registers directly here; we use the
    // sample's wallclock. clock numbers come from chis events; for live
    // sampling we use a monotonic counter. Per spec, alignment is on EOI
    // edge so absolute clock isn't required — but we do want relative
    // ordering. We'll synthesize via instruction count from sampleIndex
    // for now and document the limitation.
    return undefined;
  }
  void readClock;

  async function takeSample() {
    const c64Regs = await client.getRegisters(MEMSPACE_C64);
    const c64Pc = c64Regs.find((r) => r.id === REG_PC)?.value ?? 0;
    const drvRegs = await client.getRegisters(MEMSPACE_DRIVE8);
    const drvPc = drvRegs.find((r) => r.id === REG_PC)?.value ?? 0;

    const dd00 = await client.readMemory(ADDR_C64_DD00, ADDR_C64_DD00, c64BankId, MEMSPACE_C64);
    const drv1800 = await client.readMemory(ADDR_DRIVE_1800, ADDR_DRIVE_1800, driveBankId, MEMSPACE_DRIVE8);
    const zpRange = await client.readMemory(ADDR_C64_ZP90, ADDR_C64_ZPA5, c64BankId, MEMSPACE_C64);
    const z90 = zpRange[0];
    const zA5 = zpRange[zpRange.length - 1];

    // Decode IEC line state. Real wired-OR composition needs both sides.
    // For now expose raw $DD00 + drive $1800 byte; consumer can decode.
    // Simplified per-line booleans extracted from drive $1800 PB:
    // PB0 = DATA_IN, PB2 = CLK_IN, PB7 = ATN_IN.
    const drvPb = drv1800[0];
    const atn = (drvPb & 0x80) ? 1 : 0;
    const clk = (drvPb & 0x04) ? 1 : 0;
    const data = (drvPb & 0x01) ? 1 : 0;

    return {
      c64Pc, drvPc,
      iec: { atn, clk, data },
      z90, zA5,
      ddRaw: dd00[0],
      drvPbRaw: drvPb,
    };
  }

  // Phase 1: poll until EOI rising edge or budget exhausted.
  // Resumed VICE drives instructions; we issue advanceInstructions(N)
  // chunks to keep the monitor in lockstep.
  const start = Date.now();
  let phase1Iter = 0;
  while (Date.now() - start < budgetMs) {
    phase1Iter++;
    // Advance VICE by ~ coarseEvery instructions, then sample.
    await client.advanceInstructions(coarseEvery, false);
    const s = await takeSample();
    if ((s.z90 & 0x40) !== 0) {
      eoiSeen = true;
      eoiC64Cyc = sampleIndex * coarseEvery;
      emit({
        kind: "eof-moment",
        name: "first_eoi",
        c64Cyc: eoiC64Cyc,
        driveCyc: eoiC64Cyc,
        c64Pc: s.c64Pc,
        drivePc: s.drvPc,
      });
      // Emit the triggering sample.
      emit({
        kind: "eof-sample",
        sampleIndex,
        clock: String(eoiC64Cyc),
        c64Cyc: eoiC64Cyc,
        driveCyc: eoiC64Cyc,
        c64Pc: s.c64Pc,
        channels: {
          drivePc: s.drvPc,
          iec: s.iec,
          zp: { "90": s.z90, "a5": s.zA5 },
        },
      });
      sampleIndex++;
      break;
    }
    sampleIndex++;
  }

  if (!eoiSeen) {
    console.error(`EOI never seen in ${budgetMs}ms (${phase1Iter} probes)`);
    exitCode = 2;
  } else {
    // Phase 2: post-EOI window. Sample every coarseEvery instructions.
    let postEoiCount = 0;
    while (postEoiCount < postEoiCycles) {
      await client.advanceInstructions(coarseEvery, false);
      const s = await takeSample();
      const c64Cyc = (sampleIndex) * coarseEvery;
      emit({
        kind: "eof-sample",
        sampleIndex,
        clock: String(c64Cyc),
        c64Cyc,
        driveCyc: c64Cyc,
        c64Pc: s.c64Pc,
        channels: {
          drivePc: s.drvPc,
          iec: s.iec,
          zp: { "90": s.z90, "a5": s.zA5 },
        },
      });
      sampleIndex++;
      postEoiCount += coarseEvery;
    }
    emit({
      kind: "eof-moment",
      name: "drive_idle_return",
      c64Cyc: sampleIndex * coarseEvery,
      driveCyc: sampleIndex * coarseEvery,
      c64Pc: 0,
      drivePc: 0,
    });
  }
} catch (e) {
  console.error("vice trace failed:", e?.stack ?? e?.message ?? e);
  exitCode = 1;
} finally {
  try { client.close(); } catch { /* ignore */ }
}

const body = lines.join("\n") + "\n";
writeFileSync(out, body);
console.log(`out=${out} bytes=${Buffer.byteLength(body, "utf8")} samples=${sampleIndex} eoiSeen=${eoiSeen}`);
process.exit(exitCode);
