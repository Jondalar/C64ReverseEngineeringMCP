#!/usr/bin/env node
// BUG-046 probe — chis <start> <end> (arbitrary historical window via the
// checkpoint ring) + swimlane <s> <e> auto-fallback to ring replay when no
// stored trace covers the window. Real WS path (monitor/exec → traceRead),
// private port (NOT 4312).
import { WebSocket } from "ws";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { WsServer } = await import(`${D}/workspace-ui/ws-server.js`);

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };
const PORT = 43000 + Math.floor(Math.random() * 2000);

let idc = 0;
function rpc(ws, method, params) {
  return new Promise((res, rej) => {
    const id = ++idc;
    const onMsg = (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id !== id) return;
      ws.off("message", onMsg);
      m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const server = new WsServer({ port: PORT, host: "127.0.0.1", projectDir: process.cwd() });
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
const mon = async (command) => rpc(ws, "monitor/exec", { session_id: sessionId, command });

try {
  // Fill the ring: paced free-run ~2.5s wall (~125 frames → ~5 checkpoints).
  const c0 = session.c64Cpu.cycles;
  await rpc(ws, "debug/run", { session_id: sessionId });
  await new Promise((r) => setTimeout(r, 2500));
  await rpc(ws, "debug/pause", { session_id: sessionId });
  const c1 = session.c64Cpu.cycles;
  gate("setup: machine ran ~2.4M cycles", c1 - c0 > 1_500_000, `${c1 - c0} cyc`);

  // chis <s> <e> — historical window between two checkpoints.
  const s1 = c1 - 800_000, e1 = s1 + 851;
  const r1 = await mon(`chis ${s1} ${e1}`);
  const o1 = r1.output ?? r1.error ?? "";
  gate("chis <s> <e>: replays the window from the ring",
    new RegExp(`chis: replayed \\d+ cyc from checkpoint @cyc \\d+ \\(window ${s1}\\.\\.${e1}\\)`).test(o1),
    o1.split("\n")[0]);
  gate("chis <s> <e>: swimlane has events (not empty)", !o1.includes("(no events in window)"),
    o1.split("\n").slice(1, 3).join(" | "));

  // chis classic one-arg form still works.
  const r2 = await mon("chis 3000");
  const o2 = r2.output ?? r2.error ?? "";
  gate("chis [cycles]: classic form intact", /chis: replayed \d+ cyc from checkpoint/.test(o2), o2.split("\n")[0]);

  // swimlane <s> <e> fallback: the newest store is the chis store from above
  // (covers ~s1..now-window) — pick an OLDER window it does not cover.
  const s2 = c1 - 1_200_000, e2 = s2 + 700;
  const r3 = await mon(`swimlane ${s2} ${e2}`);
  const o3 = r3.output ?? r3.error ?? "";
  gate("swimlane <s> <e> falls back to ring replay when stores have no events",
    /checkpoint-ring replay:/.test(o3) && /chis: replayed \d+ cyc/.test(o3),
    o3.split("\n").slice(0, 2).join(" | "));
  gate("swimlane fallback window rendered", new RegExp(`window ${s2}\\.\\.${e2}`).test(o3) && !o3.includes("(no events in window)"));

  // window before the oldest checkpoint → clear eviction error.
  const r4 = await mon(`chis ${c0 + 10} ${c0 + 20}`);
  const o4 = r4.error ?? r4.output ?? "";
  gate("window before oldest checkpoint → eviction error", /oldest ring checkpoint/.test(o4), o4.slice(0, 100));

  // machine state untouched (non-destructive): cycles back at now.
  gate("non-destructive: clock restored to now", session.c64Cpu.cycles === c1, `${session.c64Cpu.cycles} vs ${c1}`);
} finally {
  try { ws.close(); } catch { /* */ }
  try { server.close?.(); } catch { /* */ }
  stopIntegratedSession(sessionId);
}
console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
