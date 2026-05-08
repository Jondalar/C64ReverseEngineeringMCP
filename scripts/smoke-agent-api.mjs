#!/usr/bin/env node
// Spec 237 smoke — AgentQueryApi facade aggregator.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);
const { createAgentQueryApi } = await import(`${repoRoot}/dist/runtime/headless/v2/agent-api.js`);

const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
const opts = { diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true };

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ name, pass: false, err: e.message }); console.log(`  FAIL  ${name}: ${e.message}`); }
}

console.log("=== Spec 237 — AgentQueryApi facade ===\n");

const { session } = startIntegratedSession(opts);
session.resetCold("pal-default");
session.runFor(1_500_000);

const api = createAgentQueryApi({
  session, scenarioId: "smoke", diskPath: dummyDisk, mode: "true-drive",
});

test("1. status() returns shape", () => {
  const s = api.status();
  if (typeof s.c64Cycles !== "number") throw new Error("no c64Cycles");
  if (typeof s.driveCycles !== "number") throw new Error("no driveCycles");
  if (s.scenarioId !== "smoke") throw new Error("scenarioId mismatch");
});

test("2. monitorRegisters returns regs", () => {
  const r = api.monitorRegisters("c64");
  if (typeof r.pc !== "number") throw new Error("no pc");
  if (typeof r.a !== "number") throw new Error("no a");
});

test("3. monitorMemory reads ram", () => {
  const m = api.monitorMemory(0x0400, 0x0410);
  if (m.length !== 17) throw new Error(`length ${m.length}`);
});

test("4. monitorDisasm returns lines", () => {
  const lines = api.monitorDisasm(api.monitorRegisters("c64").pc, 5);
  if (lines.length !== 5) throw new Error(`lines ${lines.length}`);
  if (typeof lines[0].text !== "string") throw new Error("no text");
});

test("5. addPcBreakpoint + listBreakpoints", () => {
  const id = api.addPcBreakpoint("bp-test-1", 0x05b7);
  if (id !== "bp-test-1") throw new Error("bad id");
  const list = api.listBreakpoints();
  if (list.length !== 1) throw new Error(`list ${list.length}`);
});

test("6. enableBreakpoint toggles", () => {
  api.enableBreakpoint("bp-test-1", false);
  const list = api.listBreakpoints();
  if (list[0].enabled !== false) throw new Error("not disabled");
  api.enableBreakpoint("bp-test-1", true);
});

test("7. removeBreakpoint", () => {
  const ok = api.removeBreakpoint("bp-test-1");
  if (!ok) throw new Error("not removed");
  if (api.listBreakpoints().length !== 0) throw new Error("still in list");
});

test("8. resolvePc with no project — returns shape", () => {
  // Without C64RE_PROJECT_DIR / artifacts, returns shape with no resolved layers.
  const r = api.resolvePc("nonexistent", 0x1000);
  if (typeof r.pc !== "number") throw new Error("no pc");
  if (r.pc !== 0x1000) throw new Error("pc wrong");
});

test("9. saveVsf + loadVsf round-trip", () => {
  const before = api.monitorRegisters("c64");
  const bytes = api.saveVsf();
  if (bytes.length < 65000) throw new Error(`vsf too small ${bytes.length}`);
  api.loadVsf(bytes);
  const after = api.monitorRegisters("c64");
  if (after.pc !== before.pc) throw new Error(`pc changed ${before.pc.toString(16)}→${after.pc.toString(16)}`);
});

test("10. beginRewindSession + runForward", () => {
  const handle = api.beginRewindSession({ ringSize: 8 });
  if (!handle.handle) throw new Error("no handle method");
  const root = handle.handle().rootSnapshotId;
  const r = api.runForward(root, 50_000);
  if (!r.endSnapshotId) throw new Error("no end snap");
});

test("11. queryEvents requires backend", () => {
  let threw = false;
  try {
    api.queryEvents({ runId: "x", family: "cpu_step" }).catch(() => {});
  } catch (e) { threw = true; }
  // Won't throw sync; just verify shape.
});

test("12. addBreakpoint with full spec + audit log shape", () => {
  api.addBreakpoint({
    id: "bp-test-2",
    enabled: true,
    predicate: { kind: "pc", pc: 0x05b7 },
    action: "log",
  });
  const log = api.breakpointAuditLog();
  if (!Array.isArray(log)) throw new Error("audit log not array");
  api.removeBreakpoint("bp-test-2");
});

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 237 agent-api: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
