#!/usr/bin/env node
// Spec 709.11c — CART eject routing over the REAL WS/UI adapter path (not direct
// ingestMedia). Proves: a CART eject removes the cartridge and leaves the disk
// in drive 8 intact; a drive-8 eject removes the disk; drive 9 is rejected.
//
// Uses the actual V3WsServer + a ws JSON-RPC client on a private high port
// (NOT 4312 — the live UI port; see memory). Order: CRT first (resets), then
// disk (mount does not reset), so the CART-eject test isolates the routing.

import { resolve } from "node:path";
import { WebSocket } from "ws";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { V3WsServer } from "../dist/workspace-ui/v3-ws-server.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

const PORT = 41000 + Math.floor(Math.random() * 2000);
const motm = resolve("samples/motm.g64");
const crt = resolve("samples/AccoladeComics_TRX+1D_EF.crt");
console.log(`Spec 709.11c — CART eject routing over WS adapter (port ${PORT})`);

let idc = 0;
function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const onMsg = (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id !== id) return; // ignore notifications / other ids
      ws.off("message", onMsg);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
const driveHasDisk = (session) => !!session.kernel.drive1541?.getAttachedMedia?.();

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const server = new V3WsServer({ port: PORT, host: "127.0.0.1", projectDir: process.cwd() });
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
try {
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  session.runFor(3_000_000, { cycleBudget: 3_000_000 });

  // CRT first (mount resets the machine), then disk (mount does NOT reset).
  await rpc(ws, "media/mount", { session_id: sessionId, path: crt });
  await rpc(ws, "media/mount", { session_id: sessionId, slot: 8, path: motm });
  const cartBefore = await rpc(ws, "session/cart_status", { session_id: sessionId });
  gate("WS setup: cartridge attached + disk in drive 8",
    cartBefore && cartBefore.type && driveHasDisk(session), `cart=${cartBefore?.type} disk=${driveHasDisk(session)}`);

  // CART eject (UI sends slot 0) — must remove the cartridge, NOT the disk.
  await rpc(ws, "media/unmount", { session_id: sessionId, slot: 0 });
  const cartAfter = await rpc(ws, "session/cart_status", { session_id: sessionId });
  gate("709.11c CART eject removes the cartridge", cartAfter === null, `cart_status=${JSON.stringify(cartAfter)}`);
  gate("709.11c CART eject leaves the disk in drive 8 intact (the bug)", driveHasDisk(session) === true,
    `disk present=${driveHasDisk(session)}`);

  // Drive-8 eject — must remove the disk.
  await rpc(ws, "media/unmount", { session_id: sessionId, slot: 8 });
  gate("709.11c drive-8 eject removes the disk", driveHasDisk(session) === false);

  // Drive 9 mount — must be rejected.
  let drive9Rejected = false;
  try { await rpc(ws, "media/mount", { session_id: sessionId, slot: 9, path: motm }); }
  catch (e) { drive9Rejected = /drive 9/i.test(e.message); }
  gate("709.11c drive 9 mount rejected over the WS route", drive9Rejected);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  await server.close().catch(() => {});
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 709.11c WS routes: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 709.11c WS routes: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
