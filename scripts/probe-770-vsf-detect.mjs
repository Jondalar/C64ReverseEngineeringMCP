// Spec 770.2 — verify runtime_load_vsf auto-detects a real VICE x64sc snapshot
// (VIC-IISC module) vs a c64re-own VSF, dispatching to the right loader.
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { loadSessionVsf, saveSessionVsf } from "../dist/runtime/headless/vsf/session-vsf.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

// --- 1. c64re-own round-trip is detected as source="c64re" ---
{
  const { session } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  session.resetCold("pal-default");
  const out = join(tmpdir(), `probe-770-c64re-${process.pid}.vsf`);
  saveSessionVsf(session, out);
  const res = loadSessionVsf(session, out);
  ok(res.source === "c64re", `c64re-own VSF → source="c64re" (got ${res.source})`);
  ok(res.loadedModules.includes("MAINCPU"), `c64re path loaded MAINCPU`);
}

// --- 2. a real VICE x64sc snapshot is detected + injected byte-exactly ---
//   motm.vsf MAINCPU (verified from raw bytes): a=$a2 x=$01 y=$07 sp=$ef
//   pc=$a892 status=$a4. The injected session must match exactly.
{
  const { session } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  session.resetCold("pal-default");
  const vsf = resolve("samples/motm.vsf");
  const res = loadSessionVsf(session, vsf);
  ok(res.source === "vice-x64sc", `VICE x64sc VSF → source="vice-x64sc" (got ${res.source})`);
  ok(res.loadedModules.includes("VIC-IISC"), `VICE path reports VIC-IISC`);
  ok(res.loadedModules.includes("C64MEM"), `VICE path reports C64MEM`);
  // CPU regs injected byte-exactly (proves MAINCPU offsets correct).
  ok(session.c64Cpu.pc === 0xa892, `VICE CPU PC = $a892 (got $${session.c64Cpu.pc.toString(16)})`);
  ok(session.c64Cpu.a === 0xa2, `VICE CPU A = $a2 (got $${session.c64Cpu.a.toString(16)})`);
  ok(session.c64Cpu.sp === 0xef, `VICE CPU SP = $ef (got $${session.c64Cpu.sp.toString(16)})`);
  let nonZero = 0;
  for (let i = 0x0400; i < 0x0800; i++) if (session.c64Bus.read(i) !== 0) nonZero++;
  ok(nonZero > 0, `VICE RAM injected (screen page non-empty: ${nonZero} bytes)`);
}

// --- 3. all VICE sample snapshots dispatch to the VICE loader (no false c64re) ---
{
  const samples = ["LNRBefore_Start..vsf", "motm.vsf", "lastninja_before_boot.vsf"];
  for (const s of samples) {
    const { session } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
    session.resetCold("pal-default");
    const res = loadSessionVsf(session, resolve("samples", s));
    ok(res.source === "vice-x64sc", `sample ${s} → vice-x64sc`);
  }
}

console.log(`\n770 vsf-detect: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
