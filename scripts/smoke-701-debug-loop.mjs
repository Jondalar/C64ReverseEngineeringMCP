#!/usr/bin/env node
// Spec 701 smoke — autonomous runtime loop (debug/* API) end-to-end against a
// REAL IntegratedSession. Proves the backend owns the clock: the loop self-
// halts on a breakpoint and broadcasts debug/breakpoint_hit WITHOUT any UI
// polling (§9.2/§9.3). Ephemeral port 14313 — does NOT touch the live 4312
// session.

import { resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer } = await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const PORT = 14313;
const server = new V3WsServer({ port: PORT, host: "127.0.0.1" });

const { sessionId, session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
// Boot to READY so KERNAL IRQs (vector $0314→$EA31) are firing.
session.runFor(5_000_000, { cycleBudget: 5_000_000 });

const IRQ_ENTRY = 0xea31; // stock KERNAL IRQ handler — hit ~50x/sec

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

console.log("=== Spec 701 — autonomous runtime loop (debug/*) ===\n");
await new Promise(r => setTimeout(r, 100));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

// Collect broadcasts (no id) + binary VIC frames (Spec 701 §7 frame push).
const broadcasts = [];
const frames = [];
const BIN_TYPE_VIC_FRAME = 0x01;
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    const buf = new Uint8Array(data);
    if (buf[0] === BIN_TYPE_VIC_FRAME && buf.length > 15) {
      const dv = new DataView(buf.buffer, buf.byteOffset + 5, 10); // skip [type:u8][seq:u32]
      frames.push({ w: dv.getUint16(0, true), h: dv.getUint16(2, true), bytes: buf.length });
    }
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.method && msg.id === undefined) broadcasts.push(msg);
});
const waitBroadcast = (method, timeoutMs = 4000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const poll = () => {
    const m = broadcasts.find((b) => b.method === method);
    if (m) return resolve(m);
    if (Date.now() - t0 > timeoutMs) return reject(new Error(`no ${method} broadcast`));
    setTimeout(poll, 5);
  };
  poll();
});

let id = 1;

// 1. break_add → stable checknum
const add = await rpc(ws, "debug/break_add", { session_id: sessionId, pc: IRQ_ENTRY }, id++);
test("1. debug/break_add returns checknum", add.num === 1 && add.breakpoints.length === 1);

// 2. break_list reflects it
const list = await rpc(ws, "debug/break_list", { session_id: sessionId }, id++);
test("2. debug/break_list shows the bp", list.breakpoints[0]?.addr === IRQ_ENTRY);

// 3. debug/run (warp) → backend loop halts itself at the bp + broadcasts
await rpc(ws, "debug/run", { session_id: sessionId, pacing: { mode: "warp" } }, id++);
const hit = await waitBroadcast("debug/breakpoint_hit");
test("3. loop self-halts at bp + broadcasts breakpoint_hit", hit.params.pc === IRQ_ENTRY, `pc=$${hit.params.pc.toString(16)}`);

// 4. state shows paused at the bp (no UI polling drove this)
const st = await rpc(ws, "debug/state", { session_id: sessionId }, id++);
test("4. debug/state = paused at bp", st.runState === "paused" && st.pc === IRQ_ENTRY && st.stop?.reason === "breakpoint");

// 5. step advances exactly one instruction off the bp
const pcBefore = st.pc;
await rpc(ws, "debug/step", { session_id: sessionId }, id++);
const st2 = await rpc(ws, "debug/state", { session_id: sessionId }, id++);
test("5. debug/step advances one instruction", st2.pc !== pcBefore && st2.runState === "paused");

// 6. continue resumes and steps past the bp (does not instantly re-hit)
broadcasts.length = 0;
await rpc(ws, "debug/continue", { session_id: sessionId }, id++);
const st3 = await rpc(ws, "debug/state", { session_id: sessionId }, id++);
test("6. debug/continue resumes (running)", st3.runState === "running" || broadcasts.some(b => b.method === "debug/running"));

// 7. it runs forward and re-hits the IRQ bp on the NEXT IRQ (loop alive)
const hit2 = await waitBroadcast("debug/breakpoint_hit");
test("7. loop re-hits bp on next IRQ (still autonomous)", hit2.params.pc === IRQ_ENTRY);

// 8. pause + clear
await rpc(ws, "debug/pause", { session_id: sessionId }, id++);
const cleared = await rpc(ws, "debug/break_del", { session_id: sessionId, id: null }, id++);
test("8. debug/break_del(all) clears", cleared.breakpoints.length === 0);

// 9. set_pacing accepts pal/warp, rejects garbage
const paced = await rpc(ws, "session/set_pacing", { session_id: sessionId, mode: "pal" }, id++);
let rejected = false;
try { await rpc(ws, "session/set_pacing", { session_id: sessionId, mode: "bogus" }, id++); }
catch { rejected = true; }
test("9. session/set_pacing pal ok, bad mode rejected", paced.pacing.mode === "pal" && rejected);

// 10. live binary frame push (§7): run with no breakpoints, expect frames.
frames.length = 0;
await rpc(ws, "debug/run", { session_id: sessionId, pacing: { mode: "warp" } }, id++);
await new Promise(r => setTimeout(r, 400));
await rpc(ws, "debug/pause", { session_id: sessionId }, id++);
const f0 = frames[0];
test("10. backend pushes binary VIC frames (384x272 RGBA)",
  frames.length > 0 && f0?.w === 384 && f0?.h === 272 && f0?.bytes >= 384 * 272 * 4,
  `${frames.length} frames, first ${f0?.w}x${f0?.h} ${f0?.bytes}B`);

ws.close();
await server.close();

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 701 debug loop: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

function rpc(ws, method, params, id) {
  return new Promise((resolve, reject) => {
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      ws.off("message", onMsg);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  });
}
