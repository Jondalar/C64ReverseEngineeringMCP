#!/usr/bin/env node
// scripts/proof-canary-disk.mjs --game scramble|polarbear
//
// Spec 715 — disk fastloader canary (earliest stable PASS, no cosmetic
// screenshot sequence). Boots the current UI-identical integrated session
// (vice1541), autoloads the real game, and stops as SOON as the machine is
// running game code in RAM (fastloader handed control to the game).
//
//   scramble : Scramble Infinity — KERNAL LOAD"*" -> KRILL fastloader -> game
//   polarbear: Polar Bear        — KERNAL autoload -> custom loader -> game
//
// PASS = after LOAD"*",8,1 + RUN, PC sustains a game-code address in RAM
// ($0200..$9fff, outside KERNAL/BASIC ROM and the READY/serial stuck loops),
// proving the fastloader completed and the game is live.
//
// NOT the seven-game screenshot gate (that stays a focused subsystem gate).
// NO emulator change. Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const GAMES = {
  scramble:  { disk: "samples/scramble_infinity.d64", label: "Scramble Infinity (KRILL fastloader)" },
  polarbear: { disk: "samples/POLARBEAR.d64",         label: "Polar Bear (custom loader)" },
};

const argv = process.argv.slice(2);
const gi = argv.indexOf("--game");
const gameKey = gi >= 0 ? argv[gi + 1] : null;
const game = gameKey && GAMES[gameKey];
if (!game) {
  console.error(`usage: proof-canary-disk.mjs --game <${Object.keys(GAMES).join("|")}>`);
  process.exit(2);
}

let startIntegratedSession, stopIntegratedSession, mountMedia;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ mountMedia } = await import("../dist/runtime/headless/media/mount.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, game.disk);
if (!existsSync(diskPath)) {
  console.error(`[canary-disk] disk missing: ${diskPath}`);
  process.exit(1);
}

const PAL_HZ = 985_248;
const STUCK = new Set([
  0xe5cd,0xe5ce,0xe5cf,0xe5d0,0xe5d1,0xe5d2,0xe5d3,0xe5d4, // READY/BASIC loop
  0xf6bf,0xa483,0xf6c5,0xf6da,                              // LOAD/SAVE stalls
  0xeea9,0xeeaf,0xeeb2,0xed5a,0xed5d,                       // serial RX stall
]);
// Game code lives in RAM, outside ROM, outside the stuck loops.
const gameRunning = (pc) => pc >= 0x0200 && pc < 0xa000 && !STUCK.has(pc);

function fail(reason, detail) {
  console.error("");
  console.error(`=== ${game.label} canary RED ===`);
  console.error(`reason: ${reason}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});
try {
  session.resetCold("pal-default");
  session.runFor(5_000_000, { cycleBudget: 5_000_000 }); // boot to READY

  await mountMedia(session, 8, diskPath);

  session.typeText('LOAD"*",8,1\r');
  // Let the (fast)loader pull the program in. Run until BASIC READY returns
  // (load complete) or a load cap.
  const READY = new Set([0xe5cd,0xe5ce,0xe5cf,0xe5d0,0xe5d1,0xe5d2,0xe5d3,0xe5d4]);
  let loadCap = session.c64Cpu.cycles + 70 * PAL_HZ;
  while (session.c64Cpu.cycles < loadCap) {
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    if (READY.has(session.c64Cpu.pc & 0xffff)) break;
  }

  session.typeText("RUN\r");
  // Run until game code is live, sustained over two samples (earliest PASS).
  let runCap = session.c64Cpu.cycles + 40 * PAL_HZ;
  let firstHit = null;
  while (session.c64Cpu.cycles < runCap) {
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    const pc = session.c64Cpu.pc & 0xffff;
    if (gameRunning(pc)) {
      if (firstHit === null) { firstHit = pc; continue; }
      // second sustained sample in game space → PASS
      console.log(`=== Spec 715 — ${game.label} canary (vice1541) ===`);
      console.log(`  PASS  fastloader completed; game code live in RAM`);
      console.log(`  PASS  PC sustained in game space (first=$${firstHit.toString(16)} now=$${pc.toString(16)})`);
      console.log("");
      console.log(`GREEN: ${gameKey} reached running game state. disk=${game.disk}`);
      process.exit(0);
    } else {
      firstHit = null; // not sustained; reset
    }
  }
  fail("game code never went live in RAM within cap",
    `last pc=$${(session.c64Cpu.pc&0xffff).toString(16)} cycles=${session.c64Cpu.cycles}`);
} finally {
  try { stopIntegratedSession(sessionId); } catch {}
}
