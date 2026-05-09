#!/usr/bin/env node
// Spec 261/272 — V3 server bootstrap.
// Starts WebSocket server on 4312, opens C64 session at fresh BASIC ready
// with NO media mounted. User picks media via UI Live-tab dropdown.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer } = await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { startIntegratedSession, getIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

// Need a placeholder disk for IntegratedSession init (= drive needs
// disk to instantiate). Use empty synthetic disk so session boots
// to BASIC READY with no game data lurking. User picks real disk
// via media picker.
// Boot with NO disk in drive. 1541 powered + drive empty = real C64
// behavior. User picks disk via media picker when ready. PRG / cart
// workflows can also load directly into RAM without any disk.
console.log(`[v3] starting session (no disk inserted)`);
const { sessionId } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized",
});
console.log(`[v3] session id: ${sessionId}`);

console.log(`[v3] cold reset + boot to BASIC ready...`);
const session = getIntegratedSession(sessionId);
session.resetCold("pal-default");

// Spec 297l: opt-in cycle-pumped renderer via C64RE_CYCLE_PUMPED=1.
// Installs VicIIVice.onCycle hook so framebuffer is filled per-cycle
// (vs vice-rasterized snapshot replay). Pixel-perfect parity with
// VICE x64sc; perf hit accepted (= optimization-pass deferred).
if (process.env.C64RE_CYCLE_PUMPED === "1") {
  const { installCyclePumpedRenderer } = await import(
    `${repoRoot}/dist/runtime/headless/vic/cycle-pumped-renderer.js`
  );
  installCyclePumpedRenderer(session);
  console.log(`[v3] cycle-pumped renderer installed (= 297l opt-in)`);
}

session.runFor(2_000_000); // boot KERNAL until READY prompt
console.log(`[v3] cycle=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}`);

console.log(`[v3] starting WebSocket server on ws://127.0.0.1:4312`);
const server = new V3WsServer({ port: 4312, host: "127.0.0.1" });

console.log(`[v3] ready.`);
console.log(`[v3]   1. Open http://127.0.0.1:4313`);
console.log(`[v3]   2. UI auto-picks session ${sessionId}`);
console.log(`[v3]   3. Live tab: pick disk from dropdown → click Run → see cursor`);
console.log(`[v3]   4. Type "LOAD\\"*\\",8,1<Enter>RUN<Enter>" or click buttons`);

process.on("SIGINT", async () => {
  console.log(`\n[v3] shutting down...`);
  await server.close();
  process.exit(0);
});
