#!/usr/bin/env node
// Spec 296e — VIC real-game corpus capture harness.
//
// Captures VICE + headless frame pairs for a given game phase.
//
// Usage:
//   node scripts/vic-corpus-capture.mjs \
//     --game scramble-infinity \
//     --phase title-screen \
//     --disk samples/scramble_infinity.d64 \
//     --frames 1 \
//     --boot-cycles 12000000 \
//     --capture-cycles 100000
//
// Output (under samples/vic-corpus/<game>/<phase>/):
//   headless.png   — frame from cycle-driven rendering (or current default)
//   vice.png       — VICE x64sc reference (run separately if vice CLI present)
//   diff.png       — per-pixel red highlight where they differ
//   sidecar.json   — c64 PC, raster line/cycle, VIC reg snapshot, repro cmd
//
// VICE PNG capture deferred — this script writes headless + sidecar.
// VICE half follows when vice-trace MCP is on this machine.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      out[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  return out;
}

const args = parseArgs();
if (!args.game || !args.phase || !args.disk) {
  console.error("usage: vic-corpus-capture --game <name> --phase <name> --disk <path> [--boot-cycles N] [--capture-cycles N]");
  process.exit(1);
}

const game = args.game;
const phase = args.phase;
const disk = resolve(args.disk);
const bootCycles = Number(args["boot-cycles"] ?? 12_000_000);
const captureCycles = Number(args["capture-cycles"] ?? 100_000);

if (!existsSync(disk)) {
  console.error(`disk not found: ${disk}`);
  process.exit(1);
}

const outDir = `${REPO}/samples/vic-corpus/${game}/${phase}`;
mkdirSync(outDir, { recursive: true });

console.log(`vic-corpus-capture: game=${game} phase=${phase}`);
console.log(`  disk        : ${disk}`);
console.log(`  boot-cycles : ${bootCycles.toLocaleString()}`);
console.log(`  capture-cycles: ${captureCycles.toLocaleString()}`);
console.log(`  out dir     : ${outDir}`);

// 1. Boot session.
const { sessionId, session: s } = startIntegratedSession({
  diskPath: disk,
  mode: "true-drive",
  vicRenderer: "vice-rasterized",
});
s.resetCold("pal-default");

// 2. Run KERNAL boot.
s.runFor(800_000);

// 3. Type LOAD"*",8,1 RUN — typical autoboot chain.
s.typeText('LOAD"*",8,1\r', 80_000, 80_000);

// 4. Run to capture point.
let total = 0;
const chunk = 2_000_000;
while (total < bootCycles) {
  s.runFor(50_000, { cycleBudget: chunk });
  total += chunk;
}

// 5. Capture headless frame.
const headlessPath = `${outDir}/headless.png`;
const r = s.renderToPng(headlessPath, { renderer: "vice-rasterized" });
console.log(`captured headless ${r.width}x${r.height} → ${headlessPath} (${r.bytes} bytes)`);

// 6. VIC register snapshot for sidecar.
const regs = {};
for (let i = 0; i < 0x2f; i++) regs[`d0${i.toString(16).padStart(2, "0")}`] =
  `0x${s.vic.regs[i].toString(16).padStart(2, "0")}`;

// 7. Sidecar JSON.
const sidecar = {
  game, phase,
  disk: basename(disk),
  capturedAt: new Date().toISOString(),
  bootCycles, captureCycles,
  c64: {
    pc: `0x${s.c64Cpu.pc.toString(16)}`,
    cycles: s.c64Cpu.cycles,
  },
  vic: {
    raster_y: s.vic.raster_y ?? null,
    regs,
  },
  repro: {
    cmd: `node scripts/vic-corpus-capture.mjs --game ${game} --phase ${phase} --disk ${args.disk} --boot-cycles ${bootCycles} --capture-cycles ${captureCycles}`,
  },
  bug_links: {
    spec: "specs/296-vic-real-game-bug-corpus.md",
  },
};
const sidecarPath = `${outDir}/sidecar.json`;
writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
console.log(`sidecar → ${sidecarPath}`);

// 8. Diff against VICE png if present.
const vicePath = `${outDir}/vice.png`;
if (existsSync(vicePath)) {
  console.log(`vice reference present, diff TBD (separate tool)`);
} else {
  console.log(`vice reference NOT present at ${vicePath} — capture separately`);
  console.log(`  recommended: vice/x64sc -autostart ${disk} -warp -limitcycles ${bootCycles}`);
  console.log(`  then save framebuffer as ${vicePath}`);
}

stopIntegratedSession(sessionId);
console.log("done.");
