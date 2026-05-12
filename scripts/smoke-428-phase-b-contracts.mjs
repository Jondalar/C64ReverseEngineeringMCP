// Spec 428 Phase B — verify Cpu65xxVice satisfies both contracts structurally.
// Zero behavior test; just type-shape proof at runtime.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

// C64MainCpuContract members
const c64 = session.c64Cpu;
check("c64.pc number", typeof c64.pc === "number");
check("c64.a number", typeof c64.a === "number");
check("c64.x number", typeof c64.x === "number");
check("c64.y number", typeof c64.y === "number");
check("c64.sp number", typeof c64.sp === "number");
check("c64.flags number", typeof c64.flags === "number");
check("c64.cycles number", typeof c64.cycles === "number");
check("c64.executeCycle()", typeof c64.executeCycle === "function");
check("c64.isAtInstructionBoundary()", typeof c64.isAtInstructionBoundary === "function");
check("c64.reset()", typeof c64.reset === "function");
check("c64.cpuIntStatus present", c64.cpuIntStatus != null);
check("c64.maincpu_ba_low_flags number", typeof c64.maincpu_ba_low_flags === "number");
check("c64.baLowVicii()", typeof c64.baLowVicii === "function");
check("c64.memory present", c64.memory != null);

// DriveCpuContract members
const dcpu = session.drive.cpu;
check("drive.pc number", typeof dcpu.pc === "number");
check("drive.a number", typeof dcpu.a === "number");
check("drive.cycles number", typeof dcpu.cycles === "number");
check("drive.executeCycle()", typeof dcpu.executeCycle === "function");
check("drive.isAtInstructionBoundary()", typeof dcpu.isAtInstructionBoundary === "function");
check("drive.reset()", typeof dcpu.reset === "function");
check("drive.cpuIntStatus present", dcpu.cpuIntStatus != null);
check("drive.memory present", dcpu.memory != null);

const fails = checks.filter(c => !c.ok).length;
console.log(`---\nsummary: ${checks.length - fails}/${checks.length} pass, ${fails} fail`);
process.exit(fails > 0 ? 1 : 0);
