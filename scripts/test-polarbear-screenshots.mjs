// Spec game-screenshot-gate — Polar Bear in Space.
// Expected in-game: photosensitive warning → top scores menu
// ("POLAR BEAR IN SPACE!" / "FIRE TO START").
//
// Run: npm run build:mcp && node scripts/test-polarbear-screenshots.mjs
//   PASS = at t≥60s, PC is in game code region (NOT $E5CD KERNAL),
//   /tmp/polar-tNNNs.png shows photosensitive warning or scores menu.
//
// Oracle PNGs:
//   samples/screenshots/proof/polarbear-load.png         (bear loader)
//   samples/screenshots/proof/polarbear-text1_menu.png   (photosensitive warning)
//   samples/screenshots/proof/polarbear-scores_menu.png  (top scores / FIRE TO START)

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
session.renderToPng("/tmp/polar-00-ready.png");
console.log("  /tmp/polar-00-ready.png BASIC ready");

console.log("Mount POLARBEAR...");
await mountMedia(session, 8, resolve("samples/POLARBEAR.d64"));

console.log("LOAD\"*\",8,1 + RUN");
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/polar-01-loaded.png");
console.log("  /tmp/polar-01-loaded.png after LOAD (~60s)");

session.typeText("RUN\r");

let total = 0;
// Option (a) PNG-stability cut: Polarbear photosensitive-warning frame
// is byte-identical t010=t030=t060=t090=t120=t180 — fully static. Keep
// through t060 cumulative for safety margin, drop the trailing 90s.
for (const sec of [10, 20, 30]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  total += sec;
  const path = `/tmp/polar-t${total.toString().padStart(3, "0")}s.png`;
  session.renderToPng(path);
  const pc = session.c64Cpu.pc.toString(16);
  console.log(`  ${path} t=${total}s PC=$${pc}`);
}
process.exit(0);
