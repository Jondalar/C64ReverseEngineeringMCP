// Spec 615 §4 #3 — 6-game screenshot tests in vice mode.
// Per memory feedback_game_screenshot_test_set.md: motm, MM, IM2, LNR,
// Scramble, Pawn.
// Visual PASS criterion: PC progressed past KERNAL READY ($E5CD, $E5CF, etc).

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);

const GAMES = [
  { name: "motm",     disk: "samples/motm.g64",                                    cmd: 'LOAD"*",8,1\r' },
  { name: "mm",       disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64", cmd: 'LOAD"*",8,1\r' },
  { name: "im2",      disk: "samples/impossible_mission_ii[epyx_1987](!).g64",     cmd: 'LOAD"*",8,1\r' },
  { name: "lnr",      disk: "samples/last_ninja_remix_s1[system3_1991].g64",       cmd: 'LOAD"*",8,1\r' },
  { name: "scramble", disk: "samples/scramble_infinity.d64",                       cmd: 'LOAD"*",8,1\r' },
  { name: "pawn",     disk: "samples/the_pawn_s1.g64",                             cmd: 'LOAD"*",8,1\r' },
];

const STUCK_PCS = new Set([0xe5cd, 0xe5cf, 0xe5d4, 0xf6bf, 0xa483]);

type Result = { name: string; finalPc: number; stuck: boolean; cycles: number };
const results: Result[] = [];

for (const g of GAMES) {
  const diskPath = resolvePath(import.meta.dirname, "..", "..", g.disk);
  const { sessionId, session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
    diskPath,
  });
  session.resetCold("pal-default");
  session.runFor(5_000_000, { cycleBudget: 5_000_000 });
  session.typeText(g.cmd);
  session.runFor(60_000_000, { cycleBudget: 60_000_000 });
  if (g.name !== "polarbear") session.typeText("RUN\r");
  session.runFor(60_000_000, { cycleBudget: 60_000_000 });

  const finalPc = session.c64Cpu.pc & 0xffff;
  const stuck = STUCK_PCS.has(finalPc);
  results.push({ name: g.name, finalPc, stuck, cycles: session.c64Cpu.cycles });
  console.log(`[${g.name}] final PC=$${finalPc.toString(16)}  cycles=${session.c64Cpu.cycles}  ${stuck ? "STUCK-AT-READY" : "PROGRESSED"}`);
  stopIntegratedSession(sessionId);
}

console.log("\n========== SUMMARY ==========");
const pass = results.filter(r => !r.stuck);
const fail = results.filter(r => r.stuck);
console.log(`PASS: ${pass.length}/${results.length}  (${pass.map(r => r.name).join(", ")})`);
console.log(`STUCK: ${fail.length}  (${fail.map(r => r.name).join(", ")})`);

// Spec 615 §4 #3: passes if ≥ legacy baseline 5/7. Legacy baseline = motm, mm, im2, scramble, polarbear (5 GREEN), pawn+lnr RED-expected.
// Our list excludes polarbear (covered in #1). Test 6 here. Baseline for these 6 in legacy mode is:
//   motm/mm/im2/scramble = 4 GREEN, pawn/lnr = 2 RED-expected.
// So vice mode passes if motm+mm+im2+scramble ≥ 4 progress, pawn+lnr can stay stuck.
const required = new Set(["motm", "mm", "im2", "scramble"]);
const requiredPass = pass.filter(r => required.has(r.name));
console.log(`Required (motm/mm/im2/scramble) PASS: ${requiredPass.length}/4`);
if (requiredPass.length < 4) {
  console.log("FAIL — vice mode below legacy baseline");
  process.exit(1);
}
console.log("GREEN — vice mode ≥ legacy baseline");
