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
session.renderToPng("/tmp/mm-00-ready.png");
console.log("  /tmp/mm-00-ready.png BASIC ready");

console.log("Mount MM_S1...");
await mountMedia(session, 8, resolve("samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64"));

console.log("LOAD\"*\",8,1 + RUN");
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/mm-01-loaded.png");
console.log("  /tmp/mm-01-loaded.png after LOAD (~60s)");

session.typeText("RUN\r");
// Option (a) PNG-stability cut: MM character-select reached by t120 label
// (PC=$61d game-code); drop the t180 step.
for (const sec of [10, 30, 60, 90, 120]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/mm-t${sec.toString().padStart(3,"0")}s.png`;
  session.renderToPng(path);
  console.log(`  ${path} t=${sec}s PC=$${session.c64Cpu.pc.toString(16)}`);
}
process.exit(0);
