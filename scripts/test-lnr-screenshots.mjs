// Spec game-screenshot-gate — Last Ninja Remix s1 (LNR).
// Expected in-game: System 3 screen or later (title sequence).
//
// Run: npm run build:mcp && node scripts/test-lnr-screenshots.mjs
//   PASS = at t≥60s, PC is in game code region ($4000+ post-unpack),
//   /tmp/lnr-tNNNs.png shows System 3 logo or title scroller.

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
session.renderToPng("/tmp/lnr-00-ready.png");
console.log("  /tmp/lnr-00-ready.png BASIC ready");

console.log("Mount LNR s1...");
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));

console.log('LOAD"*",8,1 + RUN');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/lnr-01-loaded.png");
console.log("  /tmp/lnr-01-loaded.png after LOAD (~60s)");

session.typeText("RUN\r");
for (const sec of [10, 30, 60, 90, 120, 180]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/lnr-t${sec.toString().padStart(3, "0")}s.png`;
  session.renderToPng(path);
  console.log(`  ${path} t=${sec}s PC=$${session.c64Cpu.pc.toString(16)}`);
}
process.exit(0);
