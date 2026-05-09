#!/usr/bin/env node
// Spec 261/272 — V3 server bootstrap.
// Starts WebSocket server on 4312, auto-mounts motm.g64 + boots to title.
// User runs `npm run ui:v3:dev` separately (vite at 4313).

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer } = await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const args = process.argv.slice(2);
const game = args[0] ?? "motm";
const GAMES = {
  motm:  "samples/motm.g64",
  mm:    "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
  im2:   "samples/impossible_mission_ii[epyx_1987](!).g64",
  lnr:   "samples/last_ninja_remix_s1[system3_1991].g64",
};
const diskPath = resolvePath(repoRoot, GAMES[game] ?? GAMES.motm);

console.log(`[v3] auto-mounting ${game}: ${diskPath}`);
const { sessionId } = startIntegratedSession({
  diskPath, mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "per-pixel",
});
console.log(`[v3] session id: ${sessionId}`);

const PAL_HZ = 985248;
console.log(`[v3] booting + LOAD"*",8,1...`);
const session = (await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`)).getIntegratedSession(sessionId);
session.resetCold("pal-default");
session.runFor(800_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
for (let i = 0; i < 20; i++) session.runFor(50_000);
console.log(`[v3] LOAD typed; advancing 45s...`);
const target = session.c64Cpu.cycles + 45 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(50_000);
console.log(`[v3] cycle=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}`);

console.log(`[v3] starting WebSocket server on ws://127.0.0.1:4312`);
const server = new V3WsServer({ port: 4312, host: "127.0.0.1" });

console.log(`[v3] ready.`);
console.log(`[v3]   1. Run \`npm run ui:v3:dev\` in another terminal`);
console.log(`[v3]   2. Open http://127.0.0.1:4313`);
console.log(`[v3]   3. UI auto-picks session ${sessionId}`);
console.log(`[v3]   4. Click Live tab → Run / Snapshot`);

process.on("SIGINT", async () => {
  console.log(`\n[v3] shutting down...`);
  await server.close();
  process.exit(0);
});
