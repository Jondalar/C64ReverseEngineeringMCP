#!/usr/bin/env node
// Smoke for the one-tool monitor remote-control (runtime_monitor / WS monitor/exec).
// Exercises the in-proc runMonitorCommand path with the same minimal ctx the MCP
// tool builds (session + ctrl + cursor maps), proving any monitor command string
// round-trips to text output. The daemon path is the same call with a richer ctx.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { ensureRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { runMonitorCommand } from "../dist/runtime/headless/debug/monitor-shell.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("smoke runtime_monitor — one-tool monitor remote-control");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  session.resetCold("pal-default");
  session.runFor(2_000_000, { cycleBudget: 2_000_000 });
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map(), projectDir: process.env["C64RE_PROJECT_DIR"] };
  const run = async (c) => runMonitorCommand(ctx, c);

  const r = await run("r");
  gate("r returns a register dump", !r.error && /ADDR|AC|PC|\.;?[0-9A-Fa-f]{4}/.test(r.output ?? ""), (r.output ?? r.error ?? "").split("\n")[0]);

  const m = await run("m 0400 0407");
  gate("m returns a hex dump line", !m.error && /0400/.test(m.output ?? ""), (m.output ?? m.error ?? "").trim().split("\n")[0]);

  const oadd = await run("obs t when exec ab01 do trace c64-cpu memory");
  gate("obs add (do trace) echoes the observer", !oadd.error && /exec \$AB01 do trace/.test(oadd.output ?? ""), oadd.output ?? oadd.error);

  const olist = await run("obs");
  gate("obs list shows it", !olist.error && /\bt\b/.test(olist.output ?? "") && /AB01/.test(olist.output ?? ""), (olist.output ?? "").split("\n").slice(0, 2).join(" | "));

  const odel = await run("obs t del");
  gate("obs del removes it", !odel.error && /deleted/.test(odel.output ?? ""), odel.output ?? odel.error);

  const help = await run("help");
  gate("help returns the verb list", !help.error && (help.output ?? "").length > 50, (help.output ?? "").split("\n")[0]);

  const bad = await run("definitely-not-a-verb");
  gate("unknown command returns an error/text (no throw)", typeof (bad.error ?? bad.output) === "string", bad.error ?? bad.output ?? "(empty)");
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN runtime_monitor: ${passes} checks pass.`); process.exit(0); }
console.log(`RED runtime_monitor: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
