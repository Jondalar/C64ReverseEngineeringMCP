#!/usr/bin/env node
// Spec 093 — standalone Maniac Mansion G64 1541 lockstep diagnostic.
//
// Usage:
//   npm run headless:mm:g64-debug -- --disk /path/to/maniac.g64 [--project-dir /path/to/proj] [--cycle-budget N] [--watch-pc 46A7] [--out path.json]

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

const args = parseArgs(process.argv.slice(2));
const disk = args.disk ?? args.d;
if (!disk) {
  console.error("Spec 093 diagnostic — required: --disk <path-to-g64>");
  console.error("Optional: --project-dir <path>  --cycle-budget <N>  --watch-pc <hex>  --out <path>");
  process.exit(2);
}
if (!existsSync(disk)) {
  console.error(`Disk image not found: ${disk}`);
  process.exit(2);
}
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? process.cwd();
const cycleBudget = args["cycle-budget"] ? Number(args["cycle-budget"]) : 50_000_000;
const watchPc = args["watch-pc"] ? parseInt(String(args["watch-pc"]).replace(/^[$0x]+/i, ""), 16) : 0x46a7;
const outPath = args.out
  ? resolve(projectDir, args.out)
  : join(projectDir, "analysis", "headless", "mm-g64-lockstep-debug.json");

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { diagnoseMm } = await import("../dist/runtime/headless/diagnostic-mm.js");

console.error(`Spec 093 diagnostic: ${disk}`);
console.error(`Project: ${projectDir}`);
console.error(`Cycle budget: ${cycleBudget}  Watch PC: $${watchPc.toString(16).toUpperCase()}`);

const { sessionId, session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true, useMicrocodedCpu: true,
  traceIec: true, traceIecCapacity: 4096,
  traceDrive: true, traceDriveCapacity: 2048,
});
session.resetCold();
const t0 = Date.now();
const report = diagnoseMm(session, { cycleBudget, watchPc });
const elapsed = Date.now() - t0;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("");
console.log(`Session: ${sessionId}`);
console.log(`Verdict: ${report.run.verdict}`);
console.log(`Summary: ${report.run.summary}`);
console.log(`Cycles: ${report.run.cyclesExecuted}  Wall: ${elapsed}ms`);
console.log(`C64 final: PC=$${report.finalState.c64.pc.toString(16).toUpperCase().padStart(4, "0")}  Drive PC=$${report.finalState.drive.pc.toString(16).toUpperCase().padStart(4, "0")}  Track=${report.finalState.drive.track}`);
console.log(`IEC line: ATN=${report.finalState.iecLine.atn} CLK=${report.finalState.iecLine.clk} DATA=${report.finalState.iecLine.data}`);
console.log(`Blame: ATN=${report.run.blame.atnHolder} CLK=${report.run.blame.clkHolder} DATA=${report.run.blame.dataHolder}`);
console.log(`IEC edges: ${report.iecTrace.length}  Drive PC samples: ${report.drivePcTrace.length}`);
console.log(`Report: ${outPath}`);

process.exit(report.run.verdict === "title-or-progress" ? 0 : 1);
