// Spec game-screenshot-gate — The Pawn s1.
// Expected in-game: Bild mit den Bergen (mountains title scene).
//
// Run: npm run build:mcp && node scripts/test-pawn-screenshots.mjs
//   PASS = at t≥60s, PC is in game code region (NOT $E5CD KERNAL),
//   /tmp/pawn-tNNNs.png shows mountains scene.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "literal-port",
});

console.log("Boot empty...");
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
session.renderToPng("/tmp/pawn-00-ready.png");
console.log("  /tmp/pawn-00-ready.png BASIC ready");

console.log("Mount Pawn s1...");
await mountMedia(session, 8, resolve("samples/the_pawn_s1.g64"));

console.log('LOAD"*",8,1 + RUN');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/pawn-01-loaded.png");
console.log("  /tmp/pawn-01-loaded.png after LOAD (~60s)");

session.typeText("RUN\r");
// Option (a) PNG-stability cut: Pawn is RED-expected stuck in KERNAL LOAD
// (?FILE NOT FOUND) — frames identical from t010. Keep through t060 for
// stable-PC confirmation, drop t090/t120/t180.
for (const sec of [10, 30, 60]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/pawn-t${sec.toString().padStart(3, "0")}s.png`;
  session.renderToPng(path);
  console.log(`  ${path} t=${sec}s PC=$${session.c64Cpu.pc.toString(16)}`);
}
process.exit(0);
