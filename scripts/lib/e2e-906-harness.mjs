// Shared by the two Spec 906 gates: the project, the MCP processes, the daemons of a test's own,
// the synthetic programs. Nothing here reaches :4312 — every daemon is spawned on a free port and every
// MCP process is told its endpoint.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prgWithStub } from "./asm6502-mini.mjs";
import { startMcp } from "./mcp-stdio.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const load = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

export function makeChecker(title) {
  const c = { pass: 0, fail: 0, failures: [] };
  c.check = (ok, msg, detail = "") => {
    if (ok) c.pass++; else { c.fail++; c.failures.push(msg); }
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && detail !== "" ? `  (${String(detail).slice(0, 900)})` : ""}`);
  };
  c.head = (t) => console.log(`\n── ${t}`);
  c.done = (label) => {
    console.log(`\n${c.fail === 0 ? "GREEN" : "RED"} ${title}${label ? ` (${label})` : ""}: ${c.pass} pass, ${c.fail} fail.`);
    return c.fail === 0 ? 0 : 1;
  };
  return c;
}

export const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/** Is something listening on the port? */
export const listening = (port) => new Promise((res) => {
  const s = createServer();
  s.once("error", () => res(true));
  s.listen(port, "127.0.0.1", () => s.close(() => res(false)));
});

/** The trx64-daemon this run uses, or undefined: the environment, the sibling build, the installed pin. */
export async function findDaemon() {
  const { resolveDaemonSpawn } = await load("runtime/resolve-daemon-spawn.js");
  const sibling = join(ROOT, "..", "TRX64", "target", "release", process.platform === "win32" ? "trx64-daemon.exe" : "trx64-daemon");
  const resolved = (() => {
    try {
      const p = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
      return p && !/\.m?js$/.test(p.cmd) && existsSync(p.cmd) ? p.cmd : undefined;
    } catch { return undefined; }
  })();
  const env = process.env.C64RE_RUNTIME_BIN;
  return env && !/\.m?js$/.test(env) && existsSync(env) ? env : existsSync(sibling) ? sibling : resolved;
}

/** Every process whose command line contains `needle` (pid + command). */
export { processesMatching } from "./processes.mjs";

export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The temp dirs a sandbox makes for its daemon's scratch. */
export const scratchDirs = () => { try { return readdirSync(tmpdir()).filter((n) => n.startsWith("c64re-reel-")); } catch { return []; } };

// ── the synthetic programs ──────────────────────────────────────────────────────────────────────

/** A loop that counts at $C000 and flashes the border: the PC stays in `loop`, the VIC has something to show. */
export function loopPrg(pad = 0) {
  return prgWithStub([
    ...Array.from({ length: pad }, () => "INX"),
    "SEI", "loop:", "INC $C000", "LDA $C000", "STA $D020", "JMP loop",
  ]);
}

/** A program that hits the same two addresses over and over, for a trace to attribute. */
export function counterPrg(origin) {
  return prgWithStub(["SEI", "loop:", `INC $${origin.toString(16)}`, "JMP loop"]);
}

// ── processes ───────────────────────────────────────────────────────────────────────────────────

export class Harness {
  constructor(prefix) {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
    this.state = join(this.dir, "state");
    this.traces = join(this.dir, "traces");
    this.cleanups = [];
    this.mcps = [];
    mkdirSync(this.state, { recursive: true });
    process.on("exit", () => this.cleanup());
  }
  cleanup() {
    for (const f of this.cleanups.reverse()) { try { f(); } catch { /* gone */ } }
    this.cleanups = [];
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* */ }
  }
  /** Kill every MCP process of the run: their sandboxes then end themselves (owner gone). */
  stopMcps() { for (const m of this.mcps) m.stop(); this.mcps = []; }
  async project(name) {
    const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
    const dir = join(this.dir, name);
    mkdirSync(dir, { recursive: true });
    new ProjectKnowledgeService(dir).initProject({ name });
    return dir;
  }
  /** A trx64-daemon of this run's own on a free port: the stand-in for "the shared session". */
  async daemon(bin, projectDir, { scratch } = {}) {
    const port = await freePort();
    const child = spawn(bin, ["--project", projectDir, "--port", String(port), ...(scratch ? ["--scratch", scratch] : [])], { stdio: "ignore" });
    const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
    this.cleanups.push(stop);
    for (let i = 0; i < 80; i++) {
      try { const c = await this.ws(port); c.close(); break; } catch { await sleep(250); }
    }
    return { port, endpoint: `ws://127.0.0.1:${port}`, child, stop: async () => { stop(); await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r))); } };
  }
  /** A JSON-RPC client of a daemon on `port` (the platform's own WebSocket; no dependency). */
  async ws(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?av=0`);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("connect")), { once: true }); });
    let n = 1; const pend = new Map();
    ws.addEventListener("message", (m) => { try { const j = JSON.parse(String(m.data)); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } } catch { /* binary */ } });
    const rpc = (method, params = {}) => new Promise((res) => { const id = n++; pend.set(id, res); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    const call = async (method, params = {}) => { const r = await rpc(method, params); if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error)); return r.result; };
    return { rpc, call, close: () => ws.close() };
  }
  /** An MCP session of this repo over stdio, in `projectDir`, with the state directory every process of the run shares. */
  async mcp(projectDir, { endpoint, env = {}, onboard = true } = {}) {
    const m = startMcp({
      root: ROOT,
      env: {
        C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_AUTOSTART: "0", C64RE_STATE_DIR: this.state, C64RE_TRACE_DIR: this.traces,
        ...(endpoint ? { C64RE_RUNTIME_ENDPOINT: endpoint } : {}), ...env,
      },
    });
    this.cleanups.push(() => m.stop());
    this.mcps.push(m);
    await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-906", version: "1" } });
    if (onboard) await m.call("agent_onboard", {});
    const tools = (await m.rpc("tools/list", {})).result?.tools ?? [];
    return { call: m.call, rpc: m.rpc, proc: m.proc, stop: m.stop, tools, desc: (n) => tools.find((t) => t.name === n)?.description ?? "" };
  }
}

export const readText = (p) => readFileSync(p, "utf8");
