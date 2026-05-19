// Spec 616 Task 616.A — long-run 7-game vice-mode harness.
// Replaces the settle-window verdict in
// `tests/spec-615/seven-game-vice-mode.test.ts` (commit 4bad0e0) with
// a long-run + multi-snapshot check that catches re-entry into the
// KERNAL LOAD region AFTER the game has reached its own code at least
// once. The old test only sampled PC at one timestamp ~90s in — a game
// that ran stage-1, returned to KERNAL for stage-2/3, and stalled there
// passed the old criterion because the SINGLE sample happened to land
// in-game.
//
// Pass criterion (per Spec 616 §6 #1):
//
//   1. Game reaches in-game code at least once (PC leaves KERNAL LOAD
//      region $E1xx-$E5xx + $F4xx-$F6xx + BASIC interpreter $A000-$A48F).
//   2. After (1), no further re-entry into KERNAL LOAD region for the
//      remainder of the run (≥ 30M cycles per game).
//
// Re-entry into BASIC ($A000-$A48F) post-game is allowed in this gate
// — some games return to READY between stages but use the BASIC
// interpreter as their own jump-out point. The hard constraint is
// "drive-LOAD is not still in flight". A game that hangs in KERNAL
// LOAD after stage-1 SHOULD fail this criterion (= the bug Spec 616
// chases).
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

interface Game {
  name: string;
  disk: string;
  command: string;
  /** Total run window in c64 cycles after boot+typing settle. 30M = ~30s wall. */
  runCycles: number;
}

const PAL_HZ = 985_248;
const GAMES: Game[] = [
  { name: "motm",      disk: "samples/motm.g64",                                                       command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "MM s1",     disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",     command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "IM2",       disk: "samples/impossible_mission_ii[epyx_1987](!).g64",                       command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "LNR s1",    disk: "samples/last_ninja_remix_s1[system3_1991].g64",                         command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "Scramble",  disk: "samples/scramble_infinity.d64",                                          command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "Pawn s1",   disk: "samples/the_pawn_s1.g64",                                                command: 'LOAD"*",8,1\rRUN\r',  runCycles: 30 * PAL_HZ },
  { name: "Polarbear", disk: "samples/POLARBEAR.d64",                                                  command: 'LOAD"-*",8,1\rRUN\r', runCycles: 30 * PAL_HZ },
];

function inKernalLoad(pc: number): boolean {
  // KERNAL LOAD / IEC region (spec literal $E1xx-$E5xx + $F4xx-$F6xx)
  // PLUS the $EE/EF byte-handshake band that the LOAD path keeps
  // bouncing through (ACPTR $EE13, CIOUT $EEB1, debpia $EEA9 etc.).
  if (pc >= 0xe100 && pc <= 0xe5ff) return true;
  if (pc >= 0xed00 && pc <= 0xefff) return true;
  if (pc >= 0xf400 && pc <= 0xf6ff) return true;
  return false;
}
function inUserCode(pc: number): boolean {
  // PC in user RAM (or $C000-$CFFF upper RAM) = the game's own
  // code is running. Excludes BASIC ROM ($A000-$BFFF), KERNAL ROM
  // ($E000-$FFFF), I/O ($D000-$DFFF). KERNAL IRQ handler in $EA31
  // does NOT count as in-user-code — sampling must catch a moment
  // when PC is in actual user RAM. With 250k-cycle granularity and
  // a typical IRQ rate ~60Hz, any game spending >>250k cycles in
  // its own code will be sampled.
  if (pc < 0xa000) return true;
  if (pc >= 0xc000 && pc <= 0xcfff) return true;
  return false;
}

interface Sample {
  cycle: number;
  pc: number;
}
interface Result {
  name: string;
  pass: boolean;
  firstInGameCycle: number | null;
  firstInGamePc: number | null;
  reentryCycle: number | null;
  reentryPc: number | null;
  reentryCount: number;
  finalPc: number;
}

const results: Result[] = [];

for (const g of GAMES) {
  const diskPath = resolvePath(import.meta.dirname, "..", "..", g.disk);
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });
  await mountMedia(session, 8, diskPath);
  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText(g.command, 80_000, 80_000);

  const startCycle = session.c64Cpu.cycles;
  const target = startCycle + g.runCycles;

  let firstInGameCycle: number | null = null;
  let firstInGamePc: number | null = null;
  let reentryCycle: number | null = null;
  let reentryPc: number | null = null;
  let reentryCount = 0;

  // Step in 250k-cycle chunks (~250ms wall). 30M / 250k = 120 samples.
  const CHUNK = 250_000;
  while (session.c64Cpu.cycles < target) {
    session.runFor(CHUNK);
    const pc = session.c64Cpu.pc;
    const cyc = session.c64Cpu.cycles;
    if (firstInGameCycle === null) {
      // Wait for PC to land in user RAM (game code is actually
      // running, not a transitional BASIC interpreter sample).
      if (inUserCode(pc)) {
        firstInGameCycle = cyc;
        firstInGamePc = pc;
      }
    } else {
      // Already reached game code at least once. Any subsequent
      // sample inside KERNAL LOAD region = re-entry.
      if (inKernalLoad(pc)) {
        reentryCount++;
        if (reentryCycle === null) {
          reentryCycle = cyc;
          reentryPc = pc;
        }
      }
    }
  }

  const finalPc = session.c64Cpu.pc;
  const pass = firstInGameCycle !== null && reentryCount === 0;

  results.push({
    name: g.name,
    pass,
    firstInGameCycle,
    firstInGamePc,
    reentryCycle,
    reentryPc,
    reentryCount,
    finalPc,
  });
  stopIntegratedSession(sessionId);
}

function hex(n: number | null, w = 4): string {
  if (n === null) return "—".padStart(w + 1);
  return "$" + (n >>> 0).toString(16).padStart(w, "0");
}
function num(n: number | null): string {
  return n === null ? "—" : n.toString();
}

console.log("\nSpec 616 §6 #1 — 7-game long-run vice-mode results");
console.log("=".repeat(110));
console.log(
  "verdict | game        | first-in-game @cycle / PC      | re-entry @cycle / PC   count | final PC",
);
console.log("-".repeat(110));
let passed = 0;
for (const r of results) {
  if (r.pass) passed++;
  const tag = r.pass ? "PASS " : "FAIL ";
  console.log(
    `${tag}   | ${r.name.padEnd(11)} | ${num(r.firstInGameCycle).padStart(10)} / ${hex(r.firstInGamePc)}         | ${num(r.reentryCycle).padStart(10)} / ${hex(r.reentryPc)} ${String(r.reentryCount).padStart(5)} | ${hex(r.finalPc)}`,
  );
}
console.log("=".repeat(110));
console.log(`Summary: ${passed}/${results.length} pass long-run criterion`);

if (passed < results.length) {
  // Hard-fail for CI / smoke. Spec 616 acceptance bar.
  process.exit(1);
}
