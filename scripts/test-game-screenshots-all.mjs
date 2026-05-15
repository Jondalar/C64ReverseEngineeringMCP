// Mandatory game-screenshot gate (user-doctrine 2026-05-16).
// Runs all 6 game scenarios in sequence. Each must reach in-game
// state per [[feedback_game_screenshot_test_set]].
//
// Run: npm run test:game-screenshots
//
// Per-game PASS criterion = "did PC progress past KERNAL READY":
//   final-t PC NOT in {$E5CD, $E5CF, $E5D4, $F6BF, $A483} = PASS.
// (KERNAL READY / BASIC main loop addresses indicate stuck-at-READY.)
//
// Visual assertion (in-game scene) requires human review of the
// generated /tmp/<game>-t*.png images.

import { spawn } from "node:child_process";

const GAMES = [
  { name: "motm",     script: "scripts/test-motm-screenshots.mjs",      hint: "Bild vom Schiff mit 3 Zeilen darunter" },
  { name: "mm",       script: "scripts/test-mm-screenshots.mjs",        hint: "Auswahl der Charaktäre" },
  { name: "im2",      script: "scripts/test-im2-screenshots.mjs",       hint: "Mensch im Aufzug, nach Loader-Title" },
  { name: "lnr",      script: "scripts/test-lnr-screenshots.mjs",       hint: "System 3 Screen oder mehr" },
  { name: "scramble", script: "scripts/test-scramble-screenshots.mjs",  hint: "Highscore im Menü" },
  { name: "pawn",     script: "scripts/test-pawn-screenshots.mjs",      hint: "Bild mit den Bergen" },
];

const KERNAL_STUCK_PCS = new Set(["e5cd", "e5cf", "e5d4", "f6bf", "a483"]);

function runOne(g) {
  return new Promise((resolve) => {
    console.log(`\n=== ${g.name} (${g.hint}) ===`);
    const child = spawn("node", [g.script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (code) => {
      // Last "PC=$xxxx" in stdout = final state.
      const matches = [...stdout.matchAll(/PC=\$([0-9a-f]+)/g)];
      const finalPc = matches.length ? matches[matches.length - 1][1] : null;
      const stuck = finalPc && KERNAL_STUCK_PCS.has(finalPc);
      resolve({ name: g.name, hint: g.hint, exitCode: code, finalPc, stuck });
    });
  });
}

const results = [];
for (const g of GAMES) {
  results.push(await runOne(g));
}

console.log("\n========== SUMMARY ==========");
let pass = 0, fail = 0;
for (const r of results) {
  const verdict = r.exitCode !== 0 ? "ERROR" : r.stuck ? "STUCK" : "PROGRESS";
  if (verdict === "PROGRESS") pass++; else fail++;
  const pc = r.finalPc ? `$${r.finalPc}` : "?";
  console.log(`  ${verdict.padEnd(8)} ${r.name.padEnd(10)} final PC=${pc.padEnd(7)} — ${r.hint}`);
}
console.log(`\n${pass}/${GAMES.length} progressed past KERNAL READY, ${fail} stuck/error.`);
console.log(`Visual assertion (in-game scene) requires manual review of /tmp/<game>-t*.png.`);
process.exit(fail > 0 ? 1 : 0);
