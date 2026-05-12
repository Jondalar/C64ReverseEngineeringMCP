import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { resolve } from "node:path";
const { session } = startIntegratedSession({
  diskPath: resolve("samples/motm.g64"),
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "literal-port",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");
session.runFor(40_000_000, { cycleBudget: 40_000_000 });
console.log("PC=$"+session.c64Cpu.pc.toString(16), "cycles="+session.c64Cpu.cycles);
console.log("D011=$"+session.vic.regs[0x11].toString(16));
session.renderToPng("/tmp/motm-test-now.png");
process.exit(0);
