// Spec 889 §2 / §4 / §11 — which runtime the tools reach.
//
// Tools import `runtimeDaemon` from HERE. It is a thin facade over the ACTIVE backend:
//   - the emulator (the TRX64 daemon client) — the default, always;
//   - a C64 Ultimate — only by an explicit choice: `C64RE_RUNTIME_BACKEND=c64u:<host>` or
//     `runtime_backend action=select`. That is a RUNTIME ENDPOINT: the C64U bridge
//     (`c64re c64u-bridge`, c64u-bridge/), a daemon of its own that holds the one device
//     connection and speaks the daemon wire protocol. A client of it is the same client class as
//     the emulator's; nothing in this process ever talks to the device's app.
// There is no automatic switch in either direction. A selected C64U that stops answering is an
// error naming the device; an environment value that does not parse is an error on every call
// until someone chooses — it never quietly becomes the emulator.
//
// ONE selection per machine, shared by every C64RE process (MCP servers, the workbench): a file
// under the state directory (c64u-bridge/state.ts). A switch made by any of them is followed by
// the others on their next call and announced to them.
//
// Sandboxes, reels and scenario runs are NOT reached through here: they start their own
// private emulator daemons (`src/reel/sandbox-session.ts`) whichever backend is active.

import { emulatorDaemon, runtimeHealth as emulatorHealth } from "./daemon-client.js";
import { RuntimeMethods, type BackendIdentity } from "./runtime-methods.js";
import { UltimateRest, UltimateRestError } from "./c64u/rest.js";
import { RpcLink, RpcLinkError } from "./c64u/rpc-link.js";
import { classifyIdent, discoverUltimates, type DiscoverTarget, type FoundDevice, type UltimateIdent } from "./c64u/discovery.js";
import { startTrxmon } from "./c64u/start-monitor.js";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol } from "./setup-recipe.js";
import { noteFreshRuntime } from "./idle-exit.js";
import { clearHold } from "./hold.js";
import { BridgeClient } from "./c64u-bridge/client.js";
import { bridgeCall, ensureBridge, findBridge, rememberPassword, passwordFor, shutdownBridge, forgetPasswordsForTests, bridgeConfigFor } from "./c64u-bridge/launch.js";
import { pidAlive, readSelection, writeSelection, type SelectionRecord } from "./c64u-bridge/state.js";

export type { BackendIdentity } from "./runtime-methods.js";
export { rememberPassword } from "./c64u-bridge/launch.js";

export type BackendSpec = { kind: "emulator" } | { kind: "c64u"; host: string; restPort?: number };

/** `emulator` (or the legacy spelling of the same), or `c64u:<host>` / `c64u:<host>:<rest port>` (the port is for a device behind a forward). */
export function parseBackendSpec(raw: string): BackendSpec {
  const s = raw.trim();
  if (/^(?:emulator|trx64)$/i.test(s)) return { kind: "emulator" };
  const m = /^c64u:([^\s:/]+)(?::(\d{1,5}))?$/.exec(s);
  if (m) return { kind: "c64u", host: m[1], restPort: m[2] ? Number(m[2]) : undefined };
  throw new Error(
    `C64RE_RUNTIME_BACKEND=${JSON.stringify(raw)} is not a backend: use "emulator" (the default) or "c64u:<host>". ` +
    `Nothing falls back to the emulator — fix the value, or choose with runtime_backend.`);
}

// ---- the selection this process follows -----------------------------------------------------------------

const SELECTION_TTL_MS = 250;
let envChecked = false;
let envSpec: BackendSpec | undefined;
let envError: Error | undefined;
/** Devices this process has selected or used while their bridge was alive: an ended bridge is then restarted, not abandoned. */
const adopted = new Set<string>();
const bridgeClients = new Map<string, BridgeClient>();
let recCache: { at: number; rec: SelectionRecord | undefined } | undefined;
let lastKey: string | undefined;

const devKey = (host: string, restPort: number) => `${host}:${restPort}`;

function readSelectionCached(): SelectionRecord | undefined {
  const now = Date.now();
  if (!recCache || now - recCache.at > SELECTION_TTL_MS) recCache = { at: now, rec: readSelection() };
  return recCache.rec;
}
const dropSelectionCache = () => { recCache = undefined; };

function readEnv(): void {
  if (envChecked) return;
  envChecked = true;
  const e = process.env.C64RE_RUNTIME_BACKEND?.trim();
  if (!e) return;
  try { envSpec = parseBackendSpec(e); } catch (err) { envError = err instanceof Error ? err : new Error(String(err)); }
}

type Resolved = { kind: "emulator" } | { kind: "c64u"; host: string; restPort: number; rec?: SelectionRecord; config?: BridgeClient["target"]["config"] };

/**
 * What this process reaches right now. The shared record wins; a record of a C64U whose bridge is
 * gone counts only for a process that used that device (it restarts the bridge) — for a fresh
 * process it is stale, and the environment or the emulator default applies. The environment is
 * only the initial choice: once anyone has chosen, the record decides.
 */
function resolveSelection(): Resolved {
  readEnv();
  const rec = readSelectionCached();
  if (rec?.kind === "emulator") return { kind: "emulator" };
  if (rec?.kind === "c64u" && rec.device && rec.endpoint) {
    const k = devKey(rec.device.host, rec.device.restPort);
    if (pidAlive(rec.bridgePid)) { adopted.add(k); return { kind: "c64u", host: rec.device.host, restPort: rec.device.restPort, rec, config: rec.config }; }
    if (adopted.has(k)) return { kind: "c64u", host: rec.device.host, restPort: rec.device.restPort, rec, config: rec.config };
  }
  if (envError) throw envError;
  if (envSpec?.kind === "c64u") return { kind: "c64u", host: envSpec.host, restPort: envSpec.restPort ?? 80 };
  return { kind: "emulator" };
}

const selKey = (r: Resolved) => (r.kind === "emulator" ? "emulator" : `c64u:${devKey(r.host, r.restPort)}`);

function clientFor(r: Extract<Resolved, { kind: "c64u" }>): BridgeClient {
  const k = devKey(r.host, r.restPort);
  let c = bridgeClients.get(k);
  if (!c) {
    c = new BridgeClient({ host: r.host, restPort: r.restPort, endpoint: r.rec?.endpoint ?? "", bridgePid: r.rec?.bridgePid, config: r.config }, (rec) => { recCache = { at: Date.now(), rec }; });
    bridgeClients.set(k, c);
  } else if (r.rec) {
    // another process restarted the bridge on a new port: follow it
    c.target.endpoint = r.rec.endpoint ?? c.target.endpoint;
    c.target.bridgePid = r.rec.bridgePid;
  }
  return c;
}

/** What the selection looks like to a status line or the workbench: the kind, the device, the endpoint, a key that changes with a switch. */
export function currentSelection(): { kind: "emulator" | "c64u"; key: string; host?: string; restPort?: number; endpoint?: string; seq?: number; by?: string; error?: string } {
  let r: Resolved;
  try { r = resolveSelection(); }
  catch (e) { return { kind: "emulator", key: "emulator", error: e instanceof Error ? e.message : String(e) }; }
  if (r.kind === "emulator") return { kind: "emulator", key: "emulator", seq: readSelectionCached()?.seq, by: readSelectionCached()?.by };
  return { kind: "c64u", key: selKey(r), host: r.host, restPort: r.restPort, endpoint: r.rec?.endpoint, seq: r.rec?.seq, by: r.rec?.by };
}

/** The backend the tools reach right now. */
export function activeBackend(): RuntimeMethods {
  const r = resolveSelection();
  const key = selKey(r);
  if (lastKey !== undefined && lastKey !== key) {
    noteFreshRuntime(
      `NOTE: the runtime selection changed to ${r.kind === "emulator" ? "the emulator" : `the C64 Ultimate ${r.host}`} ` +
      `(chosen ${readSelectionCached()?.by ? `by ${readSelectionCached()!.by}` : "elsewhere"}; every C64RE process on this machine follows it). ` +
      "What is on screen and in the tool answers from now on is that machine's.");
  }
  lastKey = key;
  return r.kind === "emulator" ? emulatorDaemon : clientFor(r);
}

/** The identity of the active backend, for status lines. Never starts or connects anything. */
export async function activeIdentity(): Promise<BackendIdentity> {
  return activeBackend().describe();
}

/**
 * The tools' door: every property is the active backend's, looked up at call time. A tool
 * that imported this before a `select` reaches the new backend on its next call.
 */
export const runtimeDaemon: RuntimeMethods = new Proxy({} as RuntimeMethods, {
  get(_t, prop) {
    const b = activeBackend() as unknown as Record<string | symbol, unknown>;
    const v = b[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(b) : v;
  },
  has(_t, prop) { return prop in (activeBackend() as object); },
});

export interface SelectOptions {
  /** REST password for a C64U; kept in memory for the session only (handed to the bridge on its stdin). */
  password?: string;
  /** Full device path of trxmon.u2a, for a start. */
  trxmonPath?: string;
  rpcPort?: number;
  projectDir?: string;
  /** Start trxmon first when the device has our core without it (§3a). */
  startMonitor?: boolean;
  /** Leave the machine paused after select. */
  paused?: boolean;
}

/**
 * Choose the backend, for every C64RE process on this machine. The emulator needs nothing; a C64U
 * is a bridge that is attached to or started (probe, optional trxmon start, the ONE app connection,
 * ping, capabilities — all the bridge's) BEFORE the choice is written: a device that cannot be
 * selected leaves the previous choice exactly as it was and says why. Leaving a C64U (back to the
 * emulator, or to another device) stops its bridge: the streams stop and the device's app slot is
 * free when this returns.
 */
export async function selectBackend(spec: BackendSpec, opts: SelectOptions = {}): Promise<{ identity: BackendIdentity; notes: string[] }> {
  envError = undefined;
  envChecked = true;
  dropSelectionCache();
  const prev = readSelection();
  const prevC64u = prev?.kind === "c64u" && prev.device && prev.endpoint && pidAlive(prev.bridgePid) ? prev : undefined;

  if (spec.kind === "emulator") {
    const rec = writeSelection({ kind: "emulator", by: byWho() });
    recCache = { at: Date.now(), rec };
    lastKey = "emulator";
    const notes = ["the emulator is the active runtime"];
    if (prevC64u?.endpoint) {
      const ok = await shutdownBridge(prevC64u.endpoint);
      notes.push(ok ? `the C64U bridge for ${prevC64u.device!.host} was stopped (streams off, the device's app connection released)` : `the C64U bridge for ${prevC64u.device!.host} did not answer a stop — it ends itself when idle`);
    }
    bridgeClients.clear();
    return { identity: await emulatorDaemon.describe(), notes };
  }

  const restPort = spec.restPort ?? 80;
  const k = devKey(spec.host, restPort);
  // Spec 902 D3 — choosing a C64 Ultimate is an explicit start: it ends a `c64re down`.
  clearHold();
  if (opts.password !== undefined) rememberPassword(spec.host, restPort, opts.password);
  // A switch from another device frees the fixed UDP ports BEFORE the new bridge binds them — but
  // only once the new one has connected: a device that cannot be selected leaves the old choice
  // (and its streams) exactly as it was.
  const switching = !!prevC64u && devKey(prevC64u.device!.host, prevC64u.device!.restPort) !== k;
  const handle = await ensureBridge(bridgeConfigFor(spec.host, restPort, {
    rpcPort: opts.rpcPort, trxmonPath: opts.trxmonPath, startMonitor: opts.startMonitor, paused: opts.paused,
    projectDir: opts.projectDir, deferStreams: switching,
  }));
  const notes = [...handle.notes];
  const rec = writeSelection({
    kind: "c64u", by: byWho(), device: { host: spec.host, restPort }, endpoint: handle.endpoint, bridgePid: handle.pid,
    config: { rpcPort: opts.rpcPort, trxmonPath: opts.trxmonPath, paused: opts.paused },
  });
  recCache = { at: Date.now(), rec };
  adopted.add(k);
  lastKey = `c64u:${k}`;
  bridgeClients.delete(k);
  if (switching && prevC64u) {
    bridgeClients.delete(devKey(prevC64u.device!.host, prevC64u.device!.restPort));
    await shutdownBridge(prevC64u.endpoint!);
    const began = await bridgeCall<{ notes: string[] }>(handle.endpoint, "bridge/begin_streams", {}, 15000).catch((e) => ({ notes: [`picture and sound unavailable: ${e instanceof Error ? e.message : String(e)}`] }));
    notes.push(...began.notes);
  }
  const c = clientFor({ kind: "c64u", host: spec.host, restPort, rec, config: { rpcPort: opts.rpcPort, trxmonPath: opts.trxmonPath, paused: opts.paused, startMonitor: opts.startMonitor } });
  return { identity: await c.describe(), notes };
}

function byWho(): string { return `${process.env.C64RE_PROCESS_ROLE ?? "c64re"}:${process.pid}`; }

/** Start trxmon on a device (§3a) without selecting it: REST only, then say what the ident shows. */
export async function startMonitorOn(
  target: { host: string; restPort?: number; password?: string; fetchImpl?: typeof fetch; trxmonPath?: string; via?: "run_file" | "app" },
): Promise<{ started: boolean; note: string; rpcPort?: number }> {
  const restPort = target.restPort ?? 80;
  const pw = target.password ?? passwordFor(target.host, restPort);
  const rest = new UltimateRest(target.host, restPort, pw, target.fetchImpl);
  const r = await startTrxmon(rest, { via: target.via, path: target.trxmonPath });
  return { started: r.started, note: r.note, rpcPort: r.rpcPort };
}

// ---- probe and list (§3) -------------------------------------------------------------------

export interface DeviceRow {
  host: string;
  restPort: number;
  hostname?: string;
  product?: string;
  firmware?: string;
  board?: string;
  /** What the ident said, then what the ping said. */
  outcome: "stock" | "core-no-monitor" | "offered" | "not-offered" | "unreachable";
  /** Why, in the words a list shows. Every device is listed with its reason. */
  reason: string;
  selectable: boolean;
  /** Set for a device with our core and no trxmon: the action that makes it selectable. */
  action?: "start_monitor";
  passwordProtected?: boolean;
  /** The ping the app answered, when it was asked. */
  ping?: Record<string, unknown>;
  /** True when this is the selected device (its held connection answered, no second one). */
  held?: boolean;
}

export interface ProbeTarget {
  host: string;
  restPort?: number;
  rpcPort?: number;
  password?: string;
  fetchImpl?: typeof fetch;
  /** Ident already in hand (from UDP discovery) — skips `/v1/info` for the classification but the REST probe still runs for git hash. */
  ident?: UltimateIdent;
}

/** Read a ping into "offered / not offered, and why". */
function judgePing(ping: Record<string, unknown>): { offered: boolean; reason: string } {
  const got = parseRuntimeProtocol(typeof ping.runtime_version === "string" ? ping.runtime_version : undefined);
  if (got === EXPECTED_RUNTIME_PROTOCOL && ping.backend === "c64u") {
    return { offered: true, reason: `trxmon answered: ${ping.runtime_version}, ${typeof ping.version === "string" ? ping.version : "version unknown"}` };
  }
  return { offered: false, reason: `the app on the port answered runtime_version ${JSON.stringify(ping.runtime_version ?? null)}, backend ${JSON.stringify(ping.backend ?? null)} — C64RE needs trx64-runtime/${EXPECTED_RUNTIME_PROTOCOL} and backend "c64u"` };
}

/**
 * Probe ONE device: `GET /v1/info`, classify, and — only when the ident says trxmon is
 * serving — `ping` the app. For the device that is already selected the ping rides its held
 * connection (the app serves one client; a second would be refused, by us, against ourselves).
 */
export async function probeHost(t: ProbeTarget): Promise<DeviceRow> {
  const restPort = t.restPort ?? 80;
  const base = { host: t.host, restPort } as const;
  let info: UltimateIdent;
  try {
    info = (await new UltimateRest(t.host, restPort, t.password, t.fetchImpl, 4000).info()) as UltimateIdent;
  } catch (e) {
    const status = e instanceof UltimateRestError ? e.status : undefined;
    if (status === 403) {
      return { ...base, outcome: "unreachable", reason: "the device wants its REST password (X-Password) before it says what it is", selectable: false, passwordProtected: true };
    }
    return { ...base, outcome: "unreachable", reason: e instanceof Error ? e.message : String(e), selectable: false };
  }
  const row = {
    ...base,
    hostname: typeof info.hostname === "string" ? info.hostname : undefined,
    product: typeof info.product === "string" ? info.product : undefined,
    firmware: typeof info.firmware_version === "string" ? info.firmware_version : undefined,
    board: info.trx64?.board,
    passwordProtected: info.password_protected === true ? true : undefined,
  };
  const verdict = classifyIdent(info);
  if (verdict.outcome === "stock") return { ...row, outcome: "stock", reason: verdict.reason, selectable: false };
  if (verdict.outcome === "core-no-monitor") {
    return { ...row, outcome: "core-no-monitor", reason: verdict.reason, selectable: false, action: "start_monitor" };
  }
  const port = t.rpcPort ?? verdict.rpc;
  // The bridge for this device holds the app's one connection: ask it (it pings on the held link).
  const held = await findBridge(t.host, restPort);
  try {
    let ping: Record<string, unknown>;
    if (held) ping = await bridgeCall<Record<string, unknown>>(held.entry.endpoint, "bridge/probe", {}, 8000);
    else {
      const link = new RpcLink(t.host, port);
      try { await link.open(3000); ping = await link.call<Record<string, unknown>>("ping", {}, 4000); }
      finally { link.close(); } // a probe of a device we do not hold gives the one slot straight back
    }
    const j = judgePing(ping);
    return { ...row, outcome: j.offered ? "offered" : "not-offered", reason: j.reason, selectable: j.offered, ping, held: held ? true : undefined };
  } catch (e) {
    // A held port is reported verbatim: the reason names the port and the peer holding it.
    const why = e instanceof RpcLinkError || e instanceof Error ? e.message : String(e);
    return { ...row, outcome: "not-offered", reason: why, selectable: false };
  }
}

export interface ListOptions {
  /** Where to send the ident datagram. Empty: no UDP scan (hosts only). */
  discover?: readonly DiscoverTarget[];
  discoverTimeoutMs?: number;
  /** Devices to probe by address, in addition to whoever answers the scan. */
  hosts?: readonly { host: string; restPort?: number; rpcPort?: number }[];
  /** REST port assumed for a device found by scan. */
  restPort?: number;
  password?: string;
  fetchImpl?: typeof fetch;
}

/** Every answering device, probed, each with its reason; the emulator is always the first row's sibling. */
export async function listDevices(o: ListOptions): Promise<DeviceRow[]> {
  const found: FoundDevice[] = o.discover?.length ? await discoverUltimates({ targets: o.discover, timeoutMs: o.discoverTimeoutMs }) : [];
  const seen = new Set<string>();
  const targets: ProbeTarget[] = [];
  for (const h of o.hosts ?? []) {
    const k = `${h.host}:${h.restPort ?? 80}`;
    if (!seen.has(k)) { seen.add(k); targets.push({ ...h, password: o.password, fetchImpl: o.fetchImpl }); }
  }
  for (const f of found) {
    const rp = o.restPort ?? 80;
    const k = `${f.address}:${rp}`;
    if (!seen.has(k)) { seen.add(k); targets.push({ host: f.address, restPort: rp, password: o.password, fetchImpl: o.fetchImpl, ident: f.ident }); }
  }
  return Promise.all(targets.map((t) => probeHost(t)));
}

// ---- health (agent_onboard) ------------------------------------------------------------------

/** The availability probe of whichever backend is active. */
export async function runtimeHealth(): Promise<{ ok: true; build?: string } | { ok: false; reason: string; recipe: string }> {
  let b: RuntimeMethods;
  try { b = activeBackend(); }
  catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e), recipe: "Set C64RE_RUNTIME_BACKEND to emulator or c64u:<host>, or unset it for the emulator." }; }
  if (b.kind === "c64u") {
    try {
      const ping = await b.call<Record<string, unknown>>("bridge/probe", {}, 10000);
      return { ok: true, build: typeof ping.version === "string" ? ping.version : undefined };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason, recipe: "Start trxmon on the device (runtime_backend action=start_monitor) or select the emulator (runtime_backend action=select backend=emulator). C64RE does not switch by itself." };
    }
  }
  return emulatorHealth();
}

/** Test seam: forget what this process followed (not the shared files). */
export function resetBackendForTests(): void {
  bridgeClients.clear();
  adopted.clear();
  recCache = undefined;
  lastKey = undefined;
  envChecked = false;
  envSpec = undefined;
  envError = undefined;
  forgetPasswordsForTests();
}
