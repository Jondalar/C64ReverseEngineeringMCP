#!/usr/bin/env node
// Spec 272 smoke — V3 WebSocket protocol.

import { resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer, encodeBinaryFrame, decodeBinaryFrame, BIN_TYPE_VIC_FRAME } =
  await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const PORT = 14312; // ephemeral for test
const server = new V3WsServer({ port: PORT, host: "127.0.0.1", projectDir: process.cwd() });

const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
const { sessionId } = startIntegratedSession({
  diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true,
});

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

console.log("=== Spec 272 — V3 WebSocket protocol ===\n");

await new Promise(r => setTimeout(r, 100)); // server up

// Test 1: connect + ping
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
test("1. WebSocket connects", true);

// JSON-RPC ping
const pingResult = await rpcCall(ws, "ping", null, 1);
test("2. JSON-RPC ping → pong", typeof pingResult.pong === "number");

// Session state query
const stateResult = await rpcCall(ws, "session/state", { session_id: sessionId }, 2);
test("3. session/state returns cycles", typeof stateResult.c64Cycles === "number");

// Runtime call: monitorRegisters
const regs = await rpcCall(ws, "runtime/call", { session_id: sessionId, op: "monitorRegisters", args: ["c64"] }, 3);
test("4. runtime/call monitorRegisters", typeof regs.pc === "number");

// Unknown method → error
const errResult = await rpcCallExpectError(ws, "no_such_method", null, 4);
test("5. unknown method returns -32601", errResult.code === -32601);

// Binary frame: server broadcasts test VIC frame, client receives + decodes
const binPromise = new Promise((r) => {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) return;
    const decoded = decodeBinaryFrame(new Uint8Array(data));
    r(decoded);
  });
});
const testPayload = new Uint8Array([0x01, 0x02, 0x03]);
server.broadcastBinary(BIN_TYPE_VIC_FRAME, 99, testPayload);
const binDecoded = await binPromise;
test("6. binary frame round-trip", binDecoded.type === BIN_TYPE_VIC_FRAME && binDecoded.seq === 99 && binDecoded.payload.length === 3);

// Notification (server → client without id)
const notifyPromise = new Promise((r) => {
  ws.once("message", (data, isBinary) => {
    if (isBinary) return;
    r(JSON.parse(data.toString()));
  });
});
server.broadcast("session/state", { running: true });
const notify = await notifyPromise;
test("7. broadcast notification reaches client", notify.method === "session/state" && notify.params.running === true);

ws.close();
await server.close();

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 272 V3 WebSocket: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

function rpcCall(ws, method, params, id) {
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

function rpcCallExpectError(ws, method, params, id) {
  return new Promise((resolve) => {
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      ws.off("message", onMsg);
      resolve(msg.error);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  });
}
