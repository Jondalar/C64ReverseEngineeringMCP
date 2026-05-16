// Spec game-screenshot-gate — IM2 (Impossible Mission 2).
// Expected in-game: man in elevator after loader title.
//
// Run: npm run build:mcp && node scripts/test-im2-screenshots.mjs
//   PASS = at t≥60s, PC is in game code region (NOT $E5CD KERNAL),
//   /tmp/im2-tNNNs.png shows elevator-man frame.

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
session.renderToPng("/tmp/im2-00-ready.png");
console.log("  /tmp/im2-00-ready.png BASIC ready");

console.log("Mount IM2...");
await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));

console.log('LOAD"*",8,1 + RUN');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/im2-01-loaded.png");
console.log("  /tmp/im2-01-loaded.png after LOAD (~60s)");

session.typeText("RUN\r");
for (const sec of [10, 30, 60, 90, 120, 180]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/im2-t${sec.toString().padStart(3, "0")}s.png`;
  session.renderToPng(path);
  console.log(`  ${path} t=${sec}s PC=$${session.c64Cpu.pc.toString(16)}`);
}
process.exit(0);
