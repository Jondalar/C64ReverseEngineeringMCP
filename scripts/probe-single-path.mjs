// Spec 723 — single-path runtime guard.
// Asserts the DEFAULT headless runtime is the product path (no traps,
// microcoded, vice drive, literal/per-cycle VIC, useCycleLockstep=false)
// and that useCycleLockstep is not exposed on the public session-start tool.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { startIntegratedSession, stopIntegratedSession } =
  await import(`${ROOT}/dist/runtime/headless/integrated-session-manager.js`);
const { createAgentQueryApi } =
  await import(`${ROOT}/dist/runtime/headless/v2/agent-api.js`);

console.log("Spec 723 — probe-single-path\n");

// ---- Check 1: startIntegratedSession({}) = product path ----
const { session, sessionId } = startIntegratedSession({});
try {
  ok(session.useCycleLockstep === false, "1a default useCycleLockstep === false", `got ${session.useCycleLockstep}`);
  // Spec 723.4a: useMicrocodedCpu flag removed — the product CPU is unconditionally
  // the microcoded Cpu65xxVice. Verify by the c64Cpu class, not a flag.
  const cpuName = session.c64Cpu?.constructor?.name ?? "(none)";
  ok(/Cpu65xxVice/.test(cpuName), "1b c64Cpu is microcoded Cpu65xxVice", cpuName);
  ok(session.mode === "true-drive", "1c default mode === true-drive", `got ${session.mode}`);
  const traps = session.enableKernalFileIoTraps || session.enableKernalSerialTraps || session.enableKernalIoTraps;
  ok(traps === false, "1d no KERNAL fast-traps", `fileio=${session.enableKernalFileIoTraps} serial=${session.enableKernalSerialTraps} io=${session.enableKernalIoTraps}`);
  ok(session.useLiteralPortRenderer === true, "1e literal-port renderer on", `got ${session.useLiteralPortRenderer}`);
  ok(session.useLiteralPortVicPerCycle === true, "1f literal-port VIC per-cycle on", `got ${session.useLiteralPortVicPerCycle}`);
  const driveName = session.kernel?.drive1541?.constructor?.name ?? "(none)";
  ok(/Vice1541/.test(driveName), "1g drive1541 = vice facade", driveName);

  // ---- Check 4: branch promotion emits no fast-trap scenario ----
  try {
    const api = createAgentQueryApi({ session, scenarioId: "probe", diskPath: "probe.g64", mode: "true-drive" });
    const rm = api.beginRewindSession();
    const rootBranchId = rm.handle().rootBranchId;
    const { scenario } = rm.promoteBranch(rootBranchId);
    ok(scenario.mode !== "fast-trap", "4 promoted branch scenario is not fast-trap", `mode=${scenario.mode}`);
  } catch (e) {
    ok(false, "4 branch promotion check threw", String(e?.message ?? e));
  }
} finally {
  try { stopIntegratedSession(sessionId); } catch {}
}

// ---- Check 2: public session-start tool does NOT expose use_cycle_lockstep ----
const headlessSrc = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
const startBlock = headlessSrc.slice(
  headlessSrc.indexOf('"headless_integrated_session_start"'),
  headlessSrc.indexOf("headless_integrated_session_status"),
);
ok(!/use_cycle_lockstep/.test(startBlock),
  "2 headless_integrated_session_start has no use_cycle_lockstep input");

// ---- Check 3: useCycleLockstep:true literal only in debug-lockstep/oracle ----
// No server-tool may hard-set the boolean (debug tools use mode:"debug-lockstep").
const toolFiles = ["headless.ts", "runtime.ts", "vice.ts", "agent-workflow.ts"];
let leaks = [];
for (const f of toolFiles) {
  const p = join(ROOT, "src/server-tools", f);
  try {
    const s = readFileSync(p, "utf8");
    if (/useCycleLockstep:\s*true/.test(s)) leaks.push(f);
  } catch {}
}
ok(leaks.length === 0, "3 no server-tool hard-sets useCycleLockstep:true", leaks.join(",") || "none");

// ---- Source-tree scan (checks 5 + 6) ----
function walk(dir, acc) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|mjs)$/.test(e)) acc.push(full);
  }
  return acc;
}
const isExcluded = (p) => /\/(_archive|archive|docs)\//.test(p) || p.endsWith("probe-single-path.mjs");
const srcFiles = [...walk(join(ROOT, "src"), []), ...walk(join(ROOT, "scripts"), [])].filter((p) => !isExcluded(p));

// Check 5: no KERNAL fast-trap layer imports survive.
const trapImporters = srcFiles.filter((p) => /from\s+["'][^"']*traps\/kernal-/.test(readFileSync(p, "utf8")));
ok(trapImporters.length === 0, "5 no traps/kernal-* imports survive",
  trapImporters.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 6: no mode:"fast-trap" / "real-kernal" consumers outside docs/archive.
const ftConsumers = srcFiles.filter((p) => /mode:\s*["'](fast-trap|real-kernal)["']|["'](fast-trap|real-kernal)["']\s*(,|\]|\))/.test(readFileSync(p, "utf8")));
ok(ftConsumers.length === 0, "6 no fast-trap/real-kernal mode consumers outside docs/archive",
  ftConsumers.map((p) => relative(ROOT, p)).join(",") || "none");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} single-path: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
