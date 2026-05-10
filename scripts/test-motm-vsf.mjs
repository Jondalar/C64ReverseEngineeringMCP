import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { loadSessionVsf } from "../dist/runtime/headless/vsf/session-vsf.js";
import { resolve } from "node:path";
const s = startIntegratedSession({
  diskPath: resolve("samples/motm.g64"),
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "literal-port",
}).session;
loadSessionVsf(s, "/tmp/motm-menu.vsf");
console.log(`loaded: PC=$${s.c64Cpu.pc.toString(16)} cycles=${s.c64Cpu.cycles}`);
// Run 1 frame
try {
  s.runFor(20_000, { cycleBudget: 20_000 });
} catch (e) { console.log("run err:", e.message.split("\n")[0]); }
console.log(`after 1 frame: PC=$${s.c64Cpu.pc.toString(16)}`);
const logs = s.vic.frameLineLogs;
let d011 = 0, total = 0;
for (const line of logs) {
  for (const w of line.writes ?? []) {
    total++;
    if (w.reg === 0x11) d011++;
  }
}
console.log(`frameLineLogs: ${logs.length} lines, ${total} writes, ${d011} d011 writes`);
process.exit(0);
