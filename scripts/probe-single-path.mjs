// Spec 723 — single-path runtime guard.
// Asserts the DEFAULT headless runtime is the product path (no traps,
// microcoded, vice drive, literal/per-cycle VIC, useCycleLockstep=false)
// and that useCycleLockstep is not exposed on the public session-start tool.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
  // Spec 723.7b: the cycle-lockstep scheduler is gone — there is no
  // useCycleLockstep flag and no `scheduler` field on the session.
  ok(!("useCycleLockstep" in session) && session.scheduler === undefined,
    "1a no cycle-lockstep flag/scheduler on session",
    `useCycleLockstep_in=${"useCycleLockstep" in session} scheduler=${session.scheduler}`);
  // Spec 723.4a: useMicrocodedCpu flag removed — the product CPU is unconditionally
  // the microcoded Cpu65xxVice. Verify by the c64Cpu class, not a flag.
  const cpuName = session.c64Cpu?.constructor?.name ?? "(none)";
  ok(/Cpu65xxVice/.test(cpuName), "1b c64Cpu is microcoded Cpu65xxVice", cpuName);
  ok(session.mode === "true-drive", "1c default mode === true-drive", `got ${session.mode}`);
  const traps = session.enableKernalFileIoTraps || session.enableKernalSerialTraps || session.enableKernalIoTraps;
  ok(traps === false, "1d no KERNAL fast-traps", `fileio=${session.enableKernalFileIoTraps} serial=${session.enableKernalSerialTraps} io=${session.enableKernalIoTraps}`);
  // Spec 723.5c: the literal port is the unconditional product VIC path —
  // the useLiteralPort{Renderer,VicPerCycle,...} toggles are gone. Verify by
  // the always-allocated literal framebuffer accumulator (65*8 × 312) rather
  // than a flag.
  const fbW = 65 * 8, fbH = 312;
  ok(session.literalPortFb instanceof Uint8Array && session.literalPortFb.length === fbW * fbH,
    "1e literal-port framebuffer allocated (unconditional)",
    `${session.literalPortFb?.constructor?.name}:${session.literalPortFb?.length}`);
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

// Check 7: the legacy C64 Cpu6510 class is gone — no import + no `new Cpu6510`.
// (The separate 1541 drive CPU `drive_6510core.ts` is a different identifier and
// is explicitly allowed.)
const cpu6510Refs = srcFiles.filter((p) => {
  const s = readFileSync(p, "utf8");
  return /import[^\n]*\bCpu6510\b/.test(s) || /\bnew\s+Cpu6510\b/.test(s);
});
ok(cpu6510Refs.length === 0, "7 no legacy Cpu6510 import / instantiation",
  cpu6510Refs.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 8: the standalone legacy HeadlessSessionManager is gone — no factory /
// no start. No public tool may launch the standalone legacy session.
const mgrRefs = srcFiles.filter((p) => /getHeadlessSessionManager|getPreferredHeadlessSessionManager|new HeadlessSessionManager/.test(readFileSync(p, "utf8")));
ok(mgrRefs.length === 0, "8 no standalone HeadlessSessionManager factory/start",
  mgrRefs.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 9: useMicrocodedCpu is not a field/opt/input in the SOURCE/API surface
// (microcoded is unconditional). Scoped to src/ — the single-path invariant is
// about the runtime API, not test scripts that still pass the now-ignored key
// (a cosmetic sweep, tracked separately). Matches `useMicrocodedCpu:`/`?` syntax,
// not prose comments.
const microFlag = srcFiles.filter((p) => /\/src\//.test(p) && /useMicrocodedCpu\s*[:?]/.test(readFileSync(p, "utf8")));
ok(microFlag.length === 0, "9 no useMicrocodedCpu field/opt/input in src",
  microFlag.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 10: the separate 1541 drive CPU is intact (must NOT be deleted with the
// C64 legacy CPU).
const driveCpuExists = ["src/runtime/headless/vice1541/drive_6510core.ts", "src/runtime/headless/vice1541/drivecpu.ts"]
  .every((f) => existsSync(join(ROOT, f)));
ok(driveCpuExists, "10 vice1541 drive CPU (drive_6510core.ts + drivecpu.ts) intact");

// Check 11 (Spec 723.5a): the VIC literal-port / per-cycle-bus-stealing toggles
// are internal — no public MCP/UI tool may expose them as an input.
const toolDirs = [join(ROOT, "src/server-tools"), join(ROOT, "src/workspace-ui")];
const litPublic = toolDirs.flatMap((d) => walk(d, []))
  .filter((p) => /useLiteralPort|usePerCycleBusStealing/.test(readFileSync(p, "utf8")));
ok(litPublic.length === 0, "11 no public useLiteralPort*/usePerCycleBusStealing tool input",
  litPublic.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 12 (Spec 723.5c): the product VIC toggles are gone from the runtime
// API — literal renderer / per-cycle interleave / literal IO reads / literal
// IRQ / literal renderToPng are unconditional. No field/opt named
// useLiteralPort{Renderer,VicPerCycle,VicReads,VicIrq,VicFb} survives in src.
// (useLiteralPortVicStall is retained as a debug-lockstep-only opt → 723.7.)
const REMOVED_TOGGLES = /useLiteralPort(Renderer|VicPerCycle|VicReads|VicIrq|VicFb)\s*[:?=]/;
const removedToggleHits = srcFiles.filter((p) => /\/src\//.test(p) && REMOVED_TOGGLES.test(readFileSync(p, "utf8")));
ok(removedToggleHits.length === 0, "12 no removed product VIC toggle field/opt in src",
  removedToggleHits.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 13 (Spec 723.6a): the drive1541 implementation-selection layer is gone.
// No resolveDrive1541Implementation / assertDrive1541ImplementationAvailable
// survives in src (VICE1541 is the only drive; createDrive1541 is param-less).
const driveSelHits = srcFiles.filter((p) => /\/src\//.test(p)
  && /resolveDrive1541Implementation|assertDrive1541ImplementationAvailable/.test(readFileSync(p, "utf8")));
ok(driveSelHits.length === 0, "13 no drive1541 resolve/assert selection layer in src",
  driveSelHits.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 14 (Spec 723.6a): the Drive1541Implementation type has no "legacy" arm.
const drive1541TypePath = join(ROOT, "src/runtime/headless/drive1541/drive1541.ts");
const drive1541TypeSrc = readFileSync(drive1541TypePath, "utf8");
const legacyArm = /type Drive1541Implementation\s*=[^;]*"legacy"/.test(drive1541TypeSrc);
ok(!legacyArm, "14 Drive1541Implementation type has no legacy arm");

// Check 15 (Spec 723.6a/6b): no drive1541 *implementation-selection* option
// survives in src — i.e. no `drive1541?: Drive1541Implementation` opt/dep.
// (The kept `drive1541?: Drive1541` facade-instance field and the constant
// `drive1541Implementation = "vice"` status field are deliberately not
// matched.) Plus the public session-start tool exposes no drive1541 input.
const drive1541SelOptHits = srcFiles.filter((p) => /\/src\//.test(p)
  && /\bdrive1541\s*\?\s*:\s*Drive1541Implementation\b/.test(readFileSync(p, "utf8")));
ok(drive1541SelOptHits.length === 0, "15 no drive1541 selection option (drive1541?: Drive1541Implementation) in src",
  drive1541SelOptHits.map((p) => relative(ROOT, p)).join(",") || "none");
ok(!/drive1541/.test(startBlock), "15b session-start tool exposes no drive1541 input");

// Check 16 (Spec 723.7a/7b): the debug-mode prune. No debug-lockstep /
// debug-push-only / debug-hybrid mode + no cycle-lockstep scheduler / strategy
// / wrappers / bus-owner-table / per-cycle-bus-stealing symbol survives in src
// CODE (comments that reference the removed thing are fine — they are stripped
// before testing).
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
  .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (keep "://" in URLs)
const PRUNED = /\bdebug-lockstep\b|\bdebug-push-only\b|\bdebug-hybrid\b|CycleLockstepScheduler|LockstepStrategy|cycle-lockstep-scheduler|cycle-wrappers|cycle-steppable|bus-owner-table|getBusStallForCycle|usePerCycleBusStealing|useCycleLockstep|CycleSteppable/;
const prunedHits = srcFiles.filter((p) => /\/src\//.test(p) && PRUNED.test(stripComments(readFileSync(p, "utf8"))));
ok(prunedHits.length === 0, "16 no pruned debug-lockstep / cycle-lockstep scheduler symbol in src code",
  prunedHits.map((p) => relative(ROOT, p)).join(",") || "none");

// Check 17 (Spec 723.7b): the scheduler dir + lockstep-strategy + the VIC
// bus-stealing files are deleted.
const deletedPaths = [
  "src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts",
  "src/runtime/headless/scheduler/cycle-wrappers.ts",
  "src/runtime/headless/scheduler/cycle-steppable.ts",
  "src/runtime/headless/kernel/lockstep-strategy.ts",
  "src/runtime/headless/vic/bus-owner-table.ts",
  "src/runtime/headless/vic/ba-aec.ts",
];
const stillPresent = deletedPaths.filter((f) => existsSync(join(ROOT, f)));
ok(stillPresent.length === 0, "17 lockstep scheduler + bus-owner files deleted",
  stillPresent.join(",") || "none");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} single-path: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
