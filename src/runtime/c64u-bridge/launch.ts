// Spec 889 §11 — starting, finding and stopping the C64U bridge, from a C64RE process.
//
// The shape is the emulator daemon's (`daemon-client.ts` spawnDaemonDetached / ensureDaemon): the
// bridge is started DETACHED so it outlives the process that started it, ONE per device — a second
// start finds the running bridge (registry entry + a `ping` on its port) and attaches — and it ends
// itself on idle (`--idle-exit`, Spec 886's rules). The REST password goes to the child on STDIN,
// never in argv, and is not written anywhere; this module keeps it in memory for respawns.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol } from "../setup-recipe.js";
import { idleExitSeconds } from "../idle-exit.js";
import {
  bridgeLogFile, bridgeRegistryDir, bridgeRegistryFile, pidAlive, readBridgeEntry, removeFile, type BridgeRegistryEntry,
} from "./state.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- REST passwords: memory only -------------------------------------------------------------------

const passwords = new Map<string, string>();
const pwKey = (host: string, restPort: number) => `${host}:${restPort}`;
export function rememberPassword(host: string, restPort: number, password: unknown): void {
  if (typeof password === "string" && password) passwords.set(pwKey(host, restPort), password);
}
export function passwordFor(host: string, restPort: number): string | undefined { return passwords.get(pwKey(host, restPort)); }
export function forgetPasswordsForTests(): void { passwords.clear(); }

// ---- one-shot JSON-RPC to a bridge ---------------------------------------------------------------------

export type BridgePing = {
  runtime_version?: string;
  version?: string;
  backend?: string;
  project?: string | null;
  idleExit?: unknown;
  device?: Record<string, unknown> & { host?: string; restPort?: number };
  label?: string;
  bridge?: { state?: "connecting" | "ready" | "failed"; error?: string; notes?: string[]; pid?: number; endpoint?: string; clients?: number; avClients?: number };
  [k: string]: unknown;
};

/** One request over a short connection (`?av=0`: no picture, no sound, no hold on the idle clock). */
export function bridgeCall<T = unknown>(endpoint: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 4000): Promise<T> {
  return new Promise<T>((resolveP, reject) => {
    const ws = new WebSocket(`${endpoint}${endpoint.includes("?") ? "&" : "?"}av=0`, { handshakeTimeout: Math.min(timeoutMs, 3000) });
    let done = false;
    const finish = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* */ } f(); };
    const timer = setTimeout(() => finish(() => { try { ws.terminate(); } catch { /* */ } reject(new Error(`${endpoint}: no answer to ${method} within ${timeoutMs} ms`)); }), timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    ws.once("error", (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    ws.on("message", (d) => {
      let m: { id?: number; result?: unknown; error?: { message?: string } };
      try { m = JSON.parse(String(d)); } catch { return; }
      if (m.id !== 1) return;
      finish(() => (m.error ? reject(new Error(m.error.message ?? "error")) : resolveP(m.result as T)));
    });
    ws.once("close", () => finish(() => reject(new Error(`${endpoint}: closed before answering ${method}`))));
  });
}

/** `ping` a bridge; undefined when nothing answers or what answers is not a C64U bridge of our epoch. */
export async function pingBridge(endpoint: string, timeoutMs = 2500): Promise<BridgePing | undefined> {
  try {
    const p = await bridgeCall<BridgePing>(endpoint, "ping", {}, timeoutMs);
    if (p?.backend !== "c64u") return undefined;
    if (parseRuntimeProtocol(typeof p.runtime_version === "string" ? p.runtime_version : undefined) !== EXPECTED_RUNTIME_PROTOCOL) return undefined;
    return p;
  } catch { return undefined; }
}

/** Stop a bridge: it stops the streams and releases the device's one connection, THEN answers. */
export async function shutdownBridge(endpoint: string): Promise<boolean> {
  try { await bridgeCall(endpoint, "bridge/shutdown", {}, 15000); return true; }
  catch { return false; }
}

// ---- starting ----------------------------------------------------------------------------------------

export interface BridgeConfig {
  host: string;
  restPort: number;
  rpcPort?: number;
  trxmonPath?: string;
  startMonitor?: boolean;
  paused?: boolean;
  /** Bind the UDP streams later (`bridge/begin_streams`). */
  deferStreams?: boolean;
  /** The project the gate looks in. */
  projectDir?: string;
  password?: string;
  /** Test seam: the TCP port; default a free one. */
  port?: number;
  /** Test seam / override: seconds, default `idleExitSeconds()`. */
  idleExit?: number;
}

export interface BridgeHandle {
  endpoint: string;
  pid: number;
  ping: BridgePing;
  /** What the bridge did to bring the device in, in order (the select's notes). */
  notes: string[];
  /** True when a bridge already served this device and this call only attached. */
  attached: boolean;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

/** The C64RE entry point that runs `c64u-bridge`: `<repo>/dist/cli.js` (next to `dist/runtime/...`). */
function cliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = resolve(here, "..", "..", "cli.js");
  if (existsSync(dist)) return dist;
  const built = resolve(here, "..", "..", "..", "dist", "cli.js");
  if (existsSync(built)) return built;
  throw new Error("the C64U bridge cannot be started: dist/cli.js is not built (npm run build)");
}

/** A running bridge for this device, if the registry names a live one that answers. */
export async function findBridge(host: string, restPort: number): Promise<{ entry: BridgeRegistryEntry; ping: BridgePing } | undefined> {
  const entry = readBridgeEntry(host, restPort);
  if (!entry) return undefined;
  if (!pidAlive(entry.pid)) { removeFile(bridgeRegistryFile(host, restPort)); return undefined; }
  const ping = await pingBridge(entry.endpoint);
  if (!ping) return undefined;
  const d = ping.device;
  if (d && typeof d.host === "string" && d.host !== host) return undefined;
  return { entry, ping };
}

async function awaitReady(endpoint: string, deadlineMs: number, exited: () => string | undefined): Promise<BridgePing> {
  const deadline = Date.now() + deadlineMs;
  let last: BridgePing | undefined;
  for (;;) {
    const gone = exited();
    last = await pingBridge(endpoint, 1500);
    if (last?.bridge?.state === "ready") return last;
    if (last?.bridge?.state === "failed") throw new Error(last.bridge.error ?? "the C64U bridge could not connect to the device");
    if (gone && !last) throw new Error(gone);
    if (Date.now() > deadline) throw new Error(`the C64U bridge did not finish connecting to the device within ${Math.round(deadlineMs / 1000)} s${last?.bridge?.state ? ` (state: ${last.bridge.state})` : ""}`);
    await sleep(120);
  }
}

// A lock per device so two C64RE processes selecting the same device at once start ONE bridge.
async function withLock<T>(host: string, restPort: number, f: () => Promise<T>): Promise<T> {
  mkdirSync(bridgeRegistryDir(), { recursive: true });
  const lock = `${bridgeRegistryFile(host, restPort)}.lock`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      let holder = 0;
      try { holder = Number(readFileSync(lock, "utf8")); } catch { /* released meanwhile */ }
      if (!pidAlive(holder)) { removeFile(lock); continue; }
      if (Date.now() > deadline) throw new Error(`another C64RE process has been starting the C64U bridge for ${host} for 90 s (lock ${lock})`);
      await sleep(150);
    }
  }
  try { return await f(); } finally { removeFile(lock); }
}

/**
 * The bridge for a device: attach to the one that runs, else start one (detached) and wait until
 * it has connected to the device. A failed connect is this call's error, with the device's own
 * words; nothing is left running for it.
 */
export async function ensureBridge(cfg: BridgeConfig): Promise<BridgeHandle> {
  const attach = async (): Promise<BridgeHandle | undefined> => {
    const found = await findBridge(cfg.host, cfg.restPort);
    if (!found) return undefined;
    let ping = found.ping;
    if (ping.bridge?.state === "connecting") ping = await awaitReady(found.entry.endpoint, 60_000, () => undefined);
    else if (ping.bridge?.state === "failed") throw new Error(ping.bridge.error ?? "the C64U bridge could not connect to the device");
    const notes = [`attached to the C64U bridge already running for ${cfg.host} (${found.entry.endpoint}, pid ${found.entry.pid})`, ...(ping.bridge?.notes ?? [])];
    return { endpoint: found.entry.endpoint, pid: found.entry.pid, ping, notes, attached: true };
  };
  const first = await attach();
  if (first) return first;

  return withLock(cfg.host, cfg.restPort, async () => {
    const again = await attach();
    if (again) return again;

    const port = cfg.port ?? (await freePort());
    const cli = cliPath();
    const args = [cli, "c64u-bridge", "--device", `${cfg.host}:${cfg.restPort}`, "--port", String(port)];
    const idle = cfg.idleExit ?? idleExitSeconds();
    if (idle > 0) args.push("--idle-exit", String(idle));
    if (cfg.projectDir) args.push("--project", cfg.projectDir);
    if (cfg.rpcPort) args.push("--rpc-port", String(cfg.rpcPort));
    if (cfg.trxmonPath) args.push("--trxmon-path", cfg.trxmonPath);
    if (cfg.startMonitor) args.push("--start-monitor");
    if (cfg.paused) args.push("--paused");
    if (cfg.deferStreams) args.push("--defer-streams");
    if (cfg.password) args.push("--password-stdin");

    mkdirSync(bridgeRegistryDir(), { recursive: true });
    const logFd = openSync(bridgeLogFile(cfg.host, cfg.restPort), "a");
    let exitNote: string | undefined;
    const env = { ...process.env };
    delete env.C64RE_C64U_PASSWORD; // the password reaches the child on stdin only
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: [cfg.password ? "pipe" : "ignore", "ignore", logFd],
      env,
      cwd: process.cwd(),
    });
    closeSync(logFd);
    child.once("exit", (code, sig) => { exitNote = `the C64U bridge process ended before it was ready (${sig ?? `exit ${code}`}) — see ${bridgeLogFile(cfg.host, cfg.restPort)}`; });
    child.once("error", (e) => { exitNote = `the C64U bridge could not be started: ${e.message}`; });
    if (cfg.password && child.stdin) { child.stdin.on("error", () => { /* the child ended first: reported through exitNote */ }); child.stdin.end(cfg.password + "\n"); }
    child.unref();

    const endpoint = `ws://127.0.0.1:${port}`;
    let ping: BridgePing;
    try { ping = await awaitReady(endpoint, 90_000, () => exitNote); }
    catch (e) {
      // Nothing is left running for a connect that failed (the child also ends itself shortly after).
      await shutdownBridge(endpoint).catch(() => false);
      throw e;
    }
    return {
      endpoint, pid: child.pid ?? ping.bridge?.pid ?? 0, ping,
      notes: [...(ping.bridge?.notes ?? [])], attached: false,
    };
  });
}

/** A fresh bridge for a device whose bridge ended (idle exit): same device, same config, the password from memory. */
export function bridgeConfigFor(host: string, restPort: number, extra: Partial<BridgeConfig> = {}): BridgeConfig {
  return { host, restPort, password: passwordFor(host, restPort), ...extra };
}
