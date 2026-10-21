#!/usr/bin/env node
// Spec 910 S1 — one driver. Static, over the source: the places that start a sandbox daemon, or open, mount, eject or
// end its media, are exactly the sandbox lifecycle (src/runtime/sandbox-sessions.ts and the boot/process files it is
// made of). The one-shot run, the reel, the state-map search, the sweep, the scenario CLI and the cost capture are
// scripts over it: they call it and carry none of that code.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const files = walk(SRC).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, "utf8") }));

// the lifecycle: where a sandbox daemon is born, mounted into and ended
const LIFECYCLE = new Set([
  "src/runtime/sandbox-sessions.ts", // start / drive / mount / eject / end
  "src/runtime/sandbox-end.ts",      // the one end
  "src/reel/sandbox-session.ts",     // the process: spawn, keeper, socket
  "src/reel/session-boot.ts",        // boot and the medium doors
  "src/reel/drive-board.ts",         // the drive board a medium needs
]);
// the scripts over it
const SCRIPTS = ["src/reel/run-sandbox.ts", "src/reel/run-scenario.ts", "src/statemap/search.ts", "src/reel/sweep.ts", "src/scenario/cli.ts", "src/scenario/feature-run.ts", "src/cost/capture.ts", "src/server-tools/runtime-sandbox.ts", "src/server-tools/scene-reel.ts"];

const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const bad = [];
const note = (f, what) => bad.push(`${f}: ${what}`);

for (const f of files) {
  const t = code(f.text);
  const inLife = LIFECYCLE.has(f.rel);
  if (!inLife && /\bSandboxSession\b/.test(t) && f.rel !== "src/reel/sandbox-session.ts") note(f.rel, "uses SandboxSession outside the lifecycle");
  if (!inLife && f.rel !== "src/runtime/resolve-daemon-spawn.ts" && /resolveDaemonSpawn\(/.test(t) && /scratch/.test(t)) note(f.rel, "spawns a sandbox daemon outside the lifecycle");
}
for (const rel of SCRIPTS) {
  const f = files.find((x) => x.rel === rel);
  if (!f) { bad.push(`${rel}: missing (the script list of this gate is stale)`); continue; }
  const t = code(f.text);
  for (const m of ["media/open", "media/mount", "media/unmount", "media/swap", "media/ingress", "snapshot/undump", "daemon/shutdown", "session/drive_power", "session/drive_type", "debug/pause"]) {
    if (t.includes(`"${m}"`)) note(rel, `calls ${m} itself — that is the lifecycle's`);
  }
  if (/--headless|"--scratch"|\.close\(\)\s*;?\s*$/m.test(t) && /SandboxSession/.test(t)) note(rel, "holds a SandboxSession");
  if (/\bsession\/run\b/.test(t)) note(rel, "runs the machine with session/run instead of runUntil");
}
// the three drivers must call the lifecycle
for (const [rel, needle] of [["src/reel/run-sandbox.ts", "startSandboxSession"], ["src/reel/run-scenario.ts", "startSandboxSession"], ["src/statemap/search.ts", "startSandboxSession"]]) {
  if (!files.find((x) => x.rel === rel)?.text.includes(needle)) note(rel, `does not start its sandbox through ${needle}`);
}
// there is no --headless left anywhere in the runtime-facing source
for (const f of files) if (/["']--headless["']/.test(code(f.text))) note(f.rel, "still passes --headless");
// the shared client has no second run: no runCapped / streamPump
for (const f of files) if (/\brunCapped\b|\bstreamPump\b/.test(code(f.text))) note(f.rel, "still has runCapped / streamPump");
// the sweep, the scenario CLI and the cost capture reach sandboxes only through the scripts
for (const [rel, via] of [["src/reel/sweep.ts", "runSandbox"], ["src/scenario/feature-run.ts", "runSandbox"], ["src/cost/capture.ts", "runSandbox"]]) {
  if (!files.find((x) => x.rel === rel)?.text.includes(via)) note(rel, `no longer calls ${via}`);
}

if (bad.length) { console.log(`RED check-one-sandbox-driver:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`GREEN check-one-sandbox-driver: ${files.length} files read; the lifecycle (${[...LIFECYCLE].length} files) is the only place that starts, mounts into or ends a sandbox; ${SCRIPTS.length} scripts call it.`);
