// Spec 889 §2 / §4 — which runtime the tools reach.
//
// Tools import `runtimeDaemon` from HERE. It is a thin facade over the ACTIVE backend:
//   - the emulator (the TRX64 daemon client) — the default, always;
//   - a C64 Ultimate — only by an explicit choice: `C64RE_RUNTIME_BACKEND=c64u:<host>` or
//     `runtime_backend action=select`.
// There is no automatic switch in either direction. A selected C64U that stops answering is an
// error naming the device; an environment value that does not parse is an error on every call
// until someone chooses — it never quietly becomes the emulator.
//
// Sandboxes, reels and scenario runs are NOT reached through here: they start their own
// private emulator daemons (`src/reel/sandbox-session.ts`) whichever backend is active.

import { emulatorDaemon, runtimeHealth as emulatorHealth } from "./daemon-client.js";
import { RuntimeMethods, type BackendIdentity } from "./runtime-methods.js";
import { C64UBackend, type ConnectOptions, type ConnectReport } from "./c64u/c64u-backend.js";
import { UltimateRest, UltimateRestError } from "./c64u/rest.js";
import { RpcLink, RpcLinkError } from "./c64u/rpc-link.js";
import { classifyIdent, discoverUltimates, type DiscoverTarget, type FoundDevice, type UltimateIdent } from "./c64u/discovery.js";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol } from "./setup-recipe.js";
import type { FrameSource } from "./c64u/frame-source.js";

export type { BackendIdentity } from "./runtime-methods.js";

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

let active: RuntimeMethods | undefined;
let envChecked = false;
let envError: Error | undefined;

/** The backend the tools reach right now. */
export function activeBackend(): RuntimeMethods {
  if (!envChecked) {
    envChecked = true;
    const e = process.env.C64RE_RUNTIME_BACKEND?.trim();
    if (e) {
      try {
        const spec = parseBackendSpec(e);
        active = spec.kind === "emulator"
          ? emulatorDaemon
          : new C64UBackend({ host: spec.host, restPort: spec.restPort, lazyConnect: true });
      } catch (err) { envError = err instanceof Error ? err : new Error(String(err)); }
    }
  }
  if (envError) throw envError;
  return active ?? emulatorDaemon;
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

export interface SelectOptions extends ConnectOptions {
  /** REST password for a C64U; kept in memory for the session only. */
  password?: string;
  /** Full device path of trxmon.u2a, for a start. */
  trxmonPath?: string;
  rpcPort?: number;
  frameSource?: FrameSource;
  fetchImpl?: typeof fetch;
  projectDir?: string;
}

/**
 * Choose the backend. The emulator needs nothing; a C64U is connected (probe, optional start,
 * the ONE app connection, ping, capabilities) BEFORE it becomes active: a device that cannot be
 * selected leaves the previous choice exactly as it was and says why.
 */
export async function selectBackend(spec: BackendSpec, opts: SelectOptions = {}): Promise<{ identity: BackendIdentity; notes: string[] }> {
  envError = undefined;
  envChecked = true;
  if (spec.kind === "emulator") {
    const before = active;
    if (before instanceof C64UBackend) before.close(); // release the device's one app connection
    active = emulatorDaemon;
    return { identity: await emulatorDaemon.describe(), notes: ["the emulator is the active runtime"] };
  }
  const prev = active;
  // The same device again: reuse the held connection (trxmon serves ONE client — a second
  // connection from this process would be refused by our own first).
  if (prev instanceof C64UBackend && prev.host === spec.host && prev.restPort === (spec.restPort ?? 80)) {
    if (opts.password !== undefined) prev.setPassword(opts.password);
    if (opts.frameSource) prev.setFrameSource(opts.frameSource);
    if (opts.projectDir) prev.setProjectDir(opts.projectDir);
    const r = await prev.connect(opts);
    active = prev;
    return r;
  }
  const next = new C64UBackend({
    host: spec.host, restPort: spec.restPort, rpcPort: opts.rpcPort, password: opts.password,
    trxmonPath: opts.trxmonPath, frameSource: opts.frameSource, fetchImpl: opts.fetchImpl, projectDir: opts.projectDir,
  });
  let report: ConnectReport;
  try { report = await next.connect(opts); }
  catch (e) { next.close(); throw e; }
  active = next;
  if (prev instanceof C64UBackend) prev.close();
  return report;
}

/** Start trxmon on a device (§3a) without selecting it: REST only, then say what the ident shows. */
export async function startMonitorOn(
  target: { host: string; restPort?: number; password?: string; fetchImpl?: typeof fetch; trxmonPath?: string; via?: "run_file" | "app" },
): Promise<{ started: boolean; note: string; rpcPort?: number }> {
  const held = active instanceof C64UBackend && active.host === target.host && active.restPort === (target.restPort ?? 80) ? active : undefined;
  const b = held ?? new C64UBackend({ host: target.host, restPort: target.restPort, password: target.password, trxmonPath: target.trxmonPath, fetchImpl: target.fetchImpl });
  if (held && target.password !== undefined) held.setPassword(target.password);
  const r = await b.startMonitor({ via: target.via, path: target.trxmonPath });
  return { ...r, rpcPort: b.heldRpcPort };
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
  const held = active instanceof C64UBackend && active.host === t.host && active.restPort === restPort ? active : undefined;
  try {
    let ping: Record<string, unknown>;
    if (held) ping = await held.probeHeld();
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
  if (b instanceof C64UBackend) {
    try {
      const ping = await b.probeHeld();
      return { ok: true, build: typeof ping.version === "string" ? ping.version : undefined };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason, recipe: "Start trxmon on the device (runtime_backend action=start_monitor) or select the emulator (runtime_backend action=select backend=emulator). C64RE does not switch by itself." };
    }
  }
  return emulatorHealth();
}

/** Test seam: forget the selection and the environment verdict. */
export function resetBackendForTests(): void {
  if (active instanceof C64UBackend) active.close();
  active = undefined;
  envChecked = false;
  envError = undefined;
}
