#!/usr/bin/env node
// BUG-047 probe — daemon crash-recorder hardening + stdio EPIPE immunity.
//   A) makeCrashRecorder: timestamp, consecutive-dedupe, size cap/rotation,
//      crash-storm breaker (>N records in window → exit).
//   B) stdio layer: a child with the daemon's 'error' listeners survives its
//      pipe readers dying; a child WITHOUT them dies (negative control = the
//      overnight incident class).
//   C) real daemon: boots on a private port, answers session/list over WS
//      AFTER the parent destroyed its stdout/stderr readers, exits 0 on SIGTERM.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
const D = new URL("../dist", import.meta.url).pathname;
const { makeCrashRecorder } = await import(`${D}/runtime/headless/daemon/run.js`);

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

// --- A: recorder unit behavior --------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-crashlog-"));
  const log = join(dir, "daemon-crash.log");
  let exitCode = null;
  const rec = makeCrashRecorder(dir, { exit: (c) => { exitCode = c; }, stormMax: 100, stormWindowMs: 10_000 });

  rec("uncaughtException", new Error("alpha"));
  let txt = readFileSync(log, "utf8");
  gate("A1 record has ISO timestamp + stack", /\[uncaughtException\] \d{4}-\d{2}-\d{2}T.*Error: alpha/.test(txt));

  for (let i = 0; i < 5; i++) rec("uncaughtException", new Error("alpha")); // same stack? new Error each → different stack lines? message same, stack differs by line numbers — use same instance
  const e = new Error("beta");
  for (let i = 0; i < 6; i++) rec("uncaughtException", e);
  txt = readFileSync(log, "utf8");
  gate("A2 consecutive identical errors dedupe to repeat marker",
    (txt.match(/Error: beta/g) ?? []).length === 1 && /\[repeat\] .*repeated 2x/.test(txt));

  // size cap: prefill > 1KB cap then trigger rotation with a NEW error
  const dir2 = mkdtempSync(join(tmpdir(), "c64re-crashlog-"));
  const log2 = join(dir2, "daemon-crash.log");
  writeFileSync(log2, "x".repeat(2048));
  const rec2 = makeCrashRecorder(dir2, { exit: () => {}, maxBytes: 1024 });
  rec2("uncaughtException", new Error("gamma"));
  gate("A3 size cap rotates to .1 and starts fresh",
    existsSync(`${log2}.1`) && readFileSync(log2, "utf8").includes("Error: gamma") && readFileSync(log2, "utf8").length < 2048);

  // storm breaker: distinct errors (no dedupe shelter), small window
  const dir3 = mkdtempSync(join(tmpdir(), "c64re-crashlog-"));
  let exit3 = null;
  const rec3 = makeCrashRecorder(dir3, { exit: (c) => { exit3 = c; }, stormMax: 20, stormWindowMs: 60_000 });
  for (let i = 0; i < 25; i++) rec3("uncaughtException", new Error(`storm-${i}`));
  const txt3 = readFileSync(join(dir3, "daemon-crash.log"), "utf8");
  gate("A4 crash-storm breaker exits + writes final line", exit3 === 1 && /\[crash-storm\] .*exiting/.test(txt3));
  gate("A5 storm: no records past the breaker", !(txt3.includes("storm-23")) && !(txt3.includes("storm-24")));
  void exitCode;
}

// --- B: stdio EPIPE immunity (child process pair) -------------------------------
async function runChild(withGuards) {
  const guard = withGuards ? `process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});` : "";
  const script = `${guard}
    let n=0;
    const t=setInterval(()=>{ console.error("tick "+(n++)); console.log("tock "+n); },20);
    setTimeout(()=>{ clearInterval(t); require("node:fs").writeFileSync(process.argv[1],"ALIVE"); process.exit(0); },1200);`;
  const marker = join(mkdtempSync(join(tmpdir(), "c64re-epipe-")), "marker");
  const c = spawn(process.execPath, ["-e", script, marker], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 150));
  c.stdout.destroy(); c.stderr.destroy(); // reader dies — the overnight scenario
  const code = await new Promise((r) => c.on("exit", (cd) => r(cd)));
  return { code, alive: existsSync(marker) && readFileSync(marker, "utf8") === "ALIVE" };
}
{
  const guarded = await runChild(true);
  gate("B1 with daemon guards: survives dead pipe readers (exit 0)", guarded.code === 0 && guarded.alive, `exit=${guarded.code}`);
  const bare = await runChild(false);
  gate("B2 negative control without guards: EPIPE kills it", bare.code !== 0 || !bare.alive, `exit=${bare.code}`);
}

// --- C: real daemon boots, serves after reader death, clean SIGTERM -------------
{
  const PORT = 45000 + Math.floor(Math.random() * 2000);
  const proj = mkdtempSync(join(tmpdir(), "c64re-daemonproj-"));
  const d = spawn(process.execPath, [join(D, "runtime/headless/daemon/run.js"), "--project", proj, "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
  let ready = false;
  d.stdout.on("data", (b) => { if (String(b).includes("runtime authority ready")) ready = true; });
  for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
  gate("C1 daemon ready on private port", ready);
  d.stdout.destroy(); d.stderr.destroy(); // kill the readers
  await new Promise((r) => setTimeout(r, 200));
  let listOk = false;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const reply = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 5000);
      ws.on("message", (m) => { try { const o = JSON.parse(String(m)); if (o.id === 1) { clearTimeout(t); res(o); } } catch { /* */ } });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }));
    });
    listOk = !!reply.result;
    ws.close();
  } catch { /* gate fails */ }
  gate("C2 daemon still serves WS after stdio readers died", listOk);
  d.kill("SIGTERM");
  const code = await new Promise((r) => { d.on("exit", (c2) => r(c2)); setTimeout(() => r("timeout"), 5000); });
  gate("C3 clean SIGTERM shutdown (exit 0)", code === 0, `exit=${code}`);
}

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
