#!/usr/bin/env node
// Drive VICE x64sc with snapshot + monitor commands, capture trace.
// Usage: node vice-trace-driver.mjs <vsf-path> <output-dir>

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const vsf = process.argv[2];
const outDir = process.argv[3];
if (!vsf || !outDir) { console.error("usage: vice-trace-driver.mjs <vsf> <out-dir>"); process.exit(1); }
mkdirSync(outDir, { recursive: true });

// Use binary monitor on TCP. Build command stream for trace setup +
// run for ~2 frames + dump regs.
// VICE binary monitor protocol is complex; easier path = remote monitor
// (text). Connect via net to localhost:6510, send commands.

const port = 6510;
const viceProc = spawn("/Applications/vice-arm64-gtk3-3.10/bin/x64sc", [
  "-default", // no settings file
  "-warp", // run as fast as possible
  "-remotemonitor",
  "-remotemonitoraddress", `127.0.0.1:${port}`,
  "-snapshot", vsf,
], { stdio: ["pipe", "pipe", "pipe"] });

let viceStdout = "";
let viceStderr = "";
viceProc.stdout.on("data", d => { viceStdout += d.toString(); });
viceProc.stderr.on("data", d => { viceStderr += d.toString(); });
viceProc.on("error", e => { console.error("VICE spawn err:", e.message); });

// Wait for monitor to bind
await new Promise(r => setTimeout(r, 1500));

// Connect via net + send commands
const net = await import("node:net");
const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
  console.log(`[driver] connected to VICE monitor :${port}`);
});

let monLog = "";
sock.on("data", d => { monLog += d.toString(); });

const send = (cmd) => new Promise(r => {
  sock.write(cmd + "\n");
  setTimeout(r, 200);
});

// Wait for monitor prompt
await new Promise(r => setTimeout(r, 800));

console.log(`[driver] setting up traces...`);
await send("tr store $d011 $d011");
await send("tr store $d016 $d016");
await send("tr store $d018 $d018");
await send("tr store $d019 $d019");
await send("tr store $d01a $d01a");
await send("tr store $d020 $d020");
await send("tr store $d021 $d021");
await send("trace");  // list active traces

// Snapshot dumps before run
await send("r");      // CPU regs
await send("io");     // IO area dump
await send("scr");    // screen dump

// Run for 1 frame
console.log(`[driver] running ~1 frame (20000 cycles)...`);
await send("z 20000"); // step 20000 instructions (= ~5 frames)
// Actually monitor command "g" without args runs forever. Use stopwatch.
// Simpler: just sleep + dump.

await new Promise(r => setTimeout(r, 2000));
await send("r");

// Disconnect + kill
console.log(`[driver] capturing log + closing...`);
await send("x");  // exit monitor (resume)
sock.end();
viceProc.kill("SIGTERM");

writeFileSync(`${outDir}/vice-monitor-log.txt`, monLog);
writeFileSync(`${outDir}/vice-stdout.txt`, viceStdout);
writeFileSync(`${outDir}/vice-stderr.txt`, viceStderr);

console.log(`[driver] done. monitor log -> ${outDir}/vice-monitor-log.txt`);
console.log(`[driver] log size: ${monLog.length} bytes`);
console.log(`first 500 chars:\n${monLog.slice(0, 500)}`);
