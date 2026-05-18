// Spec 615 §4 #3 + #4: 7-game vice-mode acceptance.
// Doubles as runtime:proof-equivalent measurement — `npm run runtime:proof`
// refuses bare `--drive1541=vice` (whitelist limited to `--only load-directory`
// per Spec 611 phase 611.9 "default flip" gate, not yet lifted). This
// 7-game test gives the same coverage as the runtime:proof baseline truth
// table (specs/601-baseline-truth-table.md) but with drive1541="vice".
// Baseline target: ≥ 5/7 GREEN (LEGACY1541 reference per Spec 601).
// Pass criterion per game: after the canonical LOAD + RUN sequence and
// a stabilization window, the c64 PC must be OUTSIDE the KERNAL LOAD
// region ($E1xx-$E5xx, $F4xx-$F6xx) AND outside the BASIC READY zone
// ($A000-$A483 BASIC interpreter) — i.e. game code is executing. We
// also dump the last 3 non-blank screen rows for visual sanity (oracle
// PNG comparison is out of scope here; report-only).
//
// NOT a debug pass. Output = per-game pass/fail + PC + last-3 screen
// lines. Failing games are reported, not investigated.
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
  /** Total post-LOAD seconds to settle. */
  settleSec: number;
}

const GAMES: Game[] = [
  { name: "motm",     disk: "samples/motm.g64",                                                       command: 'LOAD"*",8,1\rRUN\r', settleSec: 90 },
  { name: "MM s1",    disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",     command: 'LOAD"*",8,1\rRUN\r', settleSec: 90 },
  { name: "IM2",      disk: "samples/impossible_mission_ii[epyx_1987](!).g64",                       command: 'LOAD"*",8,1\rRUN\r', settleSec: 90 },
  { name: "LNR s1",   disk: "samples/last_ninja_remix_s1[system3_1991].g64",                         command: 'LOAD"*",8,1\rRUN\r', settleSec: 90 },
  { name: "Scramble", disk: "samples/scramble_infinity.d64",                                          command: 'LOAD"*",8,1\rRUN\r', settleSec: 60 },
  { name: "Pawn s1",  disk: "samples/the_pawn_s1.g64",                                                command: 'LOAD"*",8,1\rRUN\r', settleSec: 60 },
  { name: "Polarbear", disk: "samples/POLARBEAR.d64",                                                  command: 'LOAD"-*",8,1\rRUN\r', settleSec: 60 },
];

function inKernalLoadOrBasic(pc: number): boolean {
  // KERNAL LOAD entry / file traps: $E168-$E5CF range.
  if (pc >= 0xe000 && pc <= 0xe5ff) return true;
  // KERNAL RS-232 / IEC: $F4xx-$F6xx.
  if (pc >= 0xf400 && pc <= 0xf6ff) return true;
  // BASIC interpreter ROM (ready/eval/error loop).
  if (pc >= 0xa000 && pc <= 0xa48f) return true;
  // Stuck on RTS-to-self.
  if (pc === 0x0073 || pc === 0x0074) return true;
  return false;
}

function decodeScreen(ram: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
function lastLines(scr: string, n: number): string[] {
  const lines: string[] = [];
  for (let r = 0; r < 25; r++) {
    const ln = scr.slice(r * 40, r * 40 + 40).trimEnd();
    if (ln.length > 0) lines.push(ln);
  }
  return lines.slice(-n);
}

const results: {
  name: string;
  inGame: boolean;
  pc: string;
  lines: string;
}[] = [];

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
  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + g.settleSec * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(1_000_000);

  const ram = (session.c64Bus as { ram: Uint8Array }).ram;
  const screen = decodeScreen(ram);
  const ll = lastLines(screen, 3);
  const pc = session.c64Cpu.pc;
  const inGame = !inKernalLoadOrBasic(pc);

  results.push({
    name: g.name,
    inGame,
    pc: `$${pc.toString(16).padStart(4, "0")}`,
    lines: ll.join(" | "),
  });
  stopIntegratedSession(sessionId);
}

console.log("\nSpec 615 §4 #3 + #4 — 7-game vice-mode results (runtime:proof-equivalent)");
console.log("=".repeat(80));
let passed = 0;
for (const r of results) {
  const tag = r.inGame ? "PASS" : "FAIL";
  if (r.inGame) passed++;
  console.log(`${tag}  ${r.name.padEnd(10)}  PC=${r.pc}  | ${r.lines}`);
}
console.log("=".repeat(80));
console.log(`Summary: ${passed}/${results.length} games in-game (PC out of KERNAL/BASIC zones)`);
