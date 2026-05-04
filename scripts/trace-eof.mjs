#!/usr/bin/env node
// Spec 094 (M0.1) — EOF trace CLI wrapper. Thin argv → runEofTrace adapter.
//
// Usage:
//   node scripts/trace-eof.mjs --disk=<g64> [--file=<name>] [--out=<path>]
//                              [--budget=<c64-instructions>] [--coarse-every=<n>]
//                              [--post-eoi-cycles=<n>]
//
// Exit codes: 0 ok, 1 internal error, 2 missing disk.

import { existsSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const disk = args.disk;
if (!disk) {
  console.error("missing --disk=<path>");
  process.exit(1);
}
if (!existsSync(disk)) {
  console.error(`disk not found: ${disk}`);
  process.exit(2);
}

const file = args.file ?? "*";
const out = args.out;
const budget = args.budget ? Number(args.budget) : undefined;
const coarseEvery = args["coarse-every"] ? Number(args["coarse-every"]) : undefined;
const postEoiCycles = args["post-eoi-cycles"] ? Number(args["post-eoi-cycles"]) : undefined;

let runEofTrace;
try {
  ({ runEofTrace } = await import("../dist/runtime/headless/trace/eof-trace.js"));
} catch (e) {
  console.error("dist not built — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

try {
  const result = await runEofTrace({
    diskPath: disk,
    loadName: file,
    outPath: out,
    budget,
    coarseEvery,
    postEoiCycles,
  });
  console.log(`schemaVersion=${result.schemaVersion}`);
  console.log(`out=${result.outPath} bytes=${result.bytes}`);
  const f = result.summary.flags;
  console.log(
    `flags: eoiSeen=${f.eoiSeen} driveCompletedViaAtn=${f.driveCompletedViaAtn} `
    + `c64InRetryLoop=${f.c64InRetryLoop} driveStuck=${f.driveStuck} `
    + `budgetExhausted=${f.budgetExhausted}`,
  );
  console.log(`moments: ${result.summary.moments.map((m) => m.name).join(", ") || "(none)"}`);
  console.log(`c64 PC top:`, result.summary.c64PcHistogramTop.slice(0, 5));
  console.log(`drv PC top:`, result.summary.drvPcHistogramTop.slice(0, 5));
  process.exit(0);
} catch (e) {
  console.error("eof-trace failed:", e?.stack ?? e?.message ?? e);
  process.exit(1);
}
