// Spec 889 — the C64 Ultimate facade: the device side of the C64U bridge (c64u-bridge/server.ts).
//
// Two connections, held while the bridge runs (it is the only process that talks to the device's app):
//   - REST (`http://<host>/v1/…`): media, machine, input, drives, apps; X-Password in memory only;
//   - ONE app WebSocket to trxmon (`RpcLink`): the TRX64 methods the app implements.
// `call(method, params)` is the bridge's door for every client and keeps the daemon's method names and answer
// shapes. What a name means here is `routing.ts`'s table: served by the app (pass-through),
// mapped onto REST (this file), or refused BY NAME with the reason and the way out. After any
// REST action that changes the machine, `debug/state` is re-read (§7) because trxmon is not
// told. Nothing here ever reaches an emulator and nothing falls back to one.

import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, resolve } from "node:path";
import { gateRefusal } from "../emulator-pass.js";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol } from "../setup-recipe.js";
import { RuntimeMethods, type BackendIdentity, type BackendNotification } from "../runtime-methods.js";
import { classifyIdent, type UltimateIdent } from "./discovery.js";
import { NoFrameSource, type FrameSource } from "./frame-source.js";
import { StreamsFrameSource } from "./streams-frame-source.js";
import { C64UStreams, localAddressTowards, type RestCaller } from "../c64u-streams/index.js";
import { UltimateRest, UltimateRestError } from "./rest.js";
import { RpcError, RpcLink, RpcLinkError } from "./rpc-link.js";
import { driveLetter, joystickEvents, sniffMedia, tapBatches, textToTaps } from "./rest-map.js";
import { DEFAULT_TRXMON_PATH, startTrxmon } from "./start-monitor.js";
import { APP_NOTIFICATIONS, API_CALL_VERBS, capabilityGaps, parseCapabilities, refusalText, routeOf } from "./routing.js";

export { DEFAULT_TRXMON_PATH };

/** A call the backend refused by name. Distinct from a device error so a caller can tell the two. */
/** Where the device is told to send its video and audio, as this process listens. */
export interface StreamsConfig {
  /** This host as the device reaches it. Default: `C64RE_C64U_RECEIVER_HOST`, else the local address towards the device. */
  receiverHost?: string;
  /** UDP port for video. Default `C64RE_C64U_VIDEO_PORT`, else 11000; 0 = a free port. */
  videoPort?: number;
  /** UDP port for audio. Default `C64RE_C64U_AUDIO_PORT`, else 11001; 0 = a free port. */
  audioPort?: number;
  bindAddress?: string;
  /** Only datagrams from this address count. Default: the device's address (`C64RE_C64U_STREAM_SOURCE` overrides; `any` = no filter). */
  sourceAddress?: string | "any";
  pausedAfterMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** The ports are fixed by default so a restart of this server keeps receiving what the device was told. */
export const DEFAULT_VIDEO_PORT = 11000;
export const DEFAULT_AUDIO_PORT = 11001;

function envPort(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name}=${JSON.stringify(raw)} is not a UDP port (0..65535)`);
  return n;
}

/** A binary message of the device's streams, for whoever relays them to a browser. */
export type StreamMessage = { kind: "video" | "audio"; data: Uint8Array };

export class BackendRefusal extends Error {
  constructor(message: string) { super(message); this.name = "BackendRefusal"; }
}

export interface C64UOptions {
  host: string;
  /** REST port (default 80). */
  restPort?: number;
  /** Override the app port; otherwise `/v1/info`'s `trx64.rpc`, else 4312 after a start. */
  rpcPort?: number;
  /** REST password; kept in memory for the session, never written. */
  password?: string;
  frameSource?: FrameSource;
  /** Full path of trxmon.u2a on the device. */
  trxmonPath?: string;
  fetchImpl?: typeof fetch;
  /** The project the gate looks in (the bridge's bound project; `project/set` moves it). None = media and PRG doors refuse by name. */
  projectDir?: string;
  /** `false`: this backend never starts the device's video/audio streams (tests of the REST/RPC side). */
  streams?: false | StreamsConfig;
}

export interface ConnectOptions {
  /** Start trxmon over REST when the ident says it is not running (§3a). */
  startMonitor?: boolean;
  /** Leave the machine paused after select instead of sending debug/continue. */
  paused?: boolean;
  /** Do not start the streams in `connect`; the caller starts them with `beginStreams()` (a switch from another device frees the fixed ports first). */
  deferStreams?: boolean;
}

export interface ConnectReport {
  identity: BackendIdentity;
  /** What happened, in order, for the tool to say. */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class C64UBackend extends RuntimeMethods {
  readonly kind = "c64u" as const;
  readonly host: string;
  readonly rest: UltimateRest;
  private link: RpcLink | null = null;
  private rpcPort: number | undefined;
  private ident: UltimateIdent | undefined;
  private pingReply: Record<string, unknown> | undefined;
  private served: Set<string> | undefined;
  private gaps: string[] = [];
  private runState: string | undefined;
  private projectDir: string | undefined;
  private frameSource: FrameSource;
  private readonly trxmonPath: string;
  private readonly noteHandlers = new Set<(n: BackendNotification) => void>();
  private connected = false;
  // §4c — the streams this backend owns while the bridge runs.
  private streams: C64UStreams | null = null;
  private streamsStarting: Promise<string[]> | undefined;
  private streamTicket: Promise<unknown> | undefined;
  private streamTrouble: string | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private lastVideoMessage: Uint8Array | undefined;
  private readonly binaryHandlers = new Set<(m: StreamMessage) => void>();

  constructor(private readonly opts: C64UOptions) {
    super();
    this.host = opts.host;
    this.rest = new UltimateRest(opts.host, opts.restPort ?? 80, opts.password, opts.fetchImpl);
    this.rpcPort = opts.rpcPort;
    this.frameSource = opts.frameSource ?? (opts.streams === false
      ? new NoFrameSource()
      : new StreamsFrameSource(() => this.streams, () => this.streamTrouble));
    this.trxmonPath = opts.trxmonPath ?? DEFAULT_TRXMON_PATH;
    this.projectDir = opts.projectDir;
  }

  setProjectDir(dir: string | undefined): void { this.projectDir = dir || undefined; }
  get project(): string | undefined { return this.projectDir; }
  setPassword(p: string | undefined): void { this.rest.setPassword(p); }
  setFrameSource(s: FrameSource): void { this.frameSource = s; }
  get restPort(): number { return this.rest.port; }
  get isConnected(): boolean { return this.connected && !!this.link?.isOpen; }
  get heldRpcPort(): number | undefined { return this.rpcPort; }

  onNotification(handler: (n: BackendNotification) => void): () => void {
    this.noteHandlers.add(handler);
    return () => { this.noteHandlers.delete(handler); };
  }

  /** Subscribe to the device's picture and sound as the binary messages the UI plays (relay.ts). */
  onBinary(handler: (m: StreamMessage) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => { this.binaryHandlers.delete(handler); };
  }

  /** The newest video message, for a browser that connects while the machine is paused (no video arrives then). */
  lastVideo(): Uint8Array | undefined { return this.lastVideoMessage; }

  /** `stream/paused` as it stands now (the notification's payload). */
  pausedState(): { paused: boolean; ageMs: number } | undefined {
    if (!this.streams) return undefined;
    const st = this.streams.status();
    return { paused: st.paused, ageMs: st.lastFrameAgeMs ?? 0 };
  }

  private emit(n: BackendNotification): void {
    for (const h of this.noteHandlers) { try { h(n); } catch { /* a listener must not break the link */ } }
  }

  // ---- identity ---------------------------------------------------------------------

  async describe(): Promise<BackendIdentity> {
    const t = this.ident?.trx64;
    const p = this.pingReply;
    return {
      kind: "c64u",
      label: `C64 Ultimate ${this.host}`,
      endpoint: `${this.rest.base} + ws://${this.host}:${this.rpcPort ?? "?"}/`,
      version: typeof p?.version === "string" ? p.version : undefined,
      device: {
        host: this.host,
        restPort: this.rest.port,
        rpcPort: this.rpcPort,
        board: t?.board,
        core: t?.core,
        caps: t?.caps,
        product: this.ident?.product,
        firmwareVersion: this.ident?.firmware_version,
        gitCommit: this.ident?.git_commit_hash,
        hostname: this.ident?.hostname,
        runtimeVersion: typeof p?.runtime_version === "string" ? p.runtime_version : undefined,
        trxmonVersion: typeof p?.version === "string" ? p.version : undefined,
        build: p?.build,
        capabilities: this.served ? "listed" : "not listed (an older app: -32601 decides per method)",
        capabilityGaps: this.gaps,
        runState: this.runState,
        streams: this.streams ? { ...this.streams.status(), trouble: this.streamTrouble } : { running: false, trouble: this.streamTrouble },
      },
    };
  }

  // ---- connect / select ----------------------------------------------------------------

  /** `GET /v1/info`, remembered. A device that is not ours is refused here, by what it said. */
  async readInfo(): Promise<UltimateIdent> {
    let info: Record<string, unknown>;
    try { info = await this.rest.info(); }
    catch (e) {
      if (e instanceof UltimateRestError && e.status === 403) {
        throw new Error(`C64 Ultimate ${this.host} wants its REST password (X-Password): pass it once with runtime_backend, it is kept for this session only`);
      }
      throw e;
    }
    this.ident = info as UltimateIdent;
    return this.ident;
  }

  /**
   * Select-time connect (§3, §3a, §7): probe over REST, start trxmon when asked, open the ONE
   * app connection, `ping`, check the epoch and the capability list, and bring the machine
   * out of trxmon's start pause unless the caller asked for it paused.
   */
  async connect(opts: ConnectOptions = {}): Promise<ConnectReport> {
    const notes: string[] = [];
    const ident = await this.readInfo();
    const verdict = classifyIdent(ident);
    if (verdict.outcome === "stock") {
      throw new Error(`C64 Ultimate ${this.host} cannot be selected: ${verdict.reason}. C64RE needs the runtime core and the trxmon app on the device.`);
    }
    let startedHere = false;
    if (verdict.outcome === "core-no-monitor") {
      if (!opts.startMonitor) {
        throw new Error(`trxmon not running on ${this.host} — start it (runtime_backend action=start_monitor, or select with start_monitor=true) or select the emulator`);
      }
      const r = await this.startMonitor();
      notes.push(r.note);
      startedHere = r.started;
    }
    // The app's port: the ident when it names one, an explicit override, else the fixed 4312
    // once we know trxmon was just started (T21: "port 4312 fixed").
    const port = this.rpcPort ?? this.ident?.trx64?.rpc ?? (startedHere ? 4312 : undefined);
    if (!port) throw new Error(`C64 Ultimate ${this.host}: its ident names no app port and none was given — trxmon is not serving`);
    this.rpcPort = port;
    await this.openLink();
    // ONE connection: the ping rides the link this backend keeps, never a second one.
    const ping = await this.link!.call<Record<string, unknown>>("ping", {}, 5000);
    this.pingReply = ping;
    const got = parseRuntimeProtocol(typeof ping.runtime_version === "string" ? ping.runtime_version : undefined);
    if (got !== EXPECTED_RUNTIME_PROTOCOL || ping.backend !== "c64u") {
      this.link!.close();
      this.link = null;
      throw new Error(
        `C64 Ultimate ${this.host}: the app answered runtime_version ${JSON.stringify(ping.runtime_version ?? null)}, backend ${JSON.stringify(ping.backend ?? null)} — ` +
        `C64RE needs trx64-runtime/${EXPECTED_RUNTIME_PROTOCOL} and backend "c64u". Refused by name; there is no epoch negotiation on the app side.`);
    }
    const caps = parseCapabilities(ping.capabilities);
    if (caps) {
      this.served = caps.methods;
      this.gaps = capabilityGaps(caps.methods);
      notes.push(this.gaps.length
        ? `capability gaps (routed by C64RE, not served by this trxmon): ${this.gaps.join(", ")}`
        : "capabilities: every routed method is served");
    } else {
      this.served = undefined;
      this.gaps = [];
      notes.push("ping carries no capabilities (an older app): a method it does not serve is reported from its own -32601");
    }
    this.connected = true;
    // §3a / §7: trxmon starts PAUSED. Continue it unless asked not to — but never over a stop a
    // person or a breakpoint made (a person at the machine wins).
    let st: Record<string, unknown> | undefined;
    try { st = await this.link!.call<Record<string, unknown>>("debug/state", {}, 5000); this.noteState(st); } catch { /* reported below by the next call */ }
    if (st && st.runState === "paused") {
      const stop = isObj(st.stop) ? st.stop : undefined;
      const reason = typeof stop?.reason === "string" ? stop.reason : undefined;
      const ours = startedHere || !stop || reason === "pause";
      if (opts.paused) notes.push("left PAUSED, as asked");
      else if (!ours) notes.push(`left paused: the machine is stopped at ${JSON.stringify(reason)} — a stop someone made at the machine is not undone by a select`);
      else {
        const r = await this.link!.call<Record<string, unknown>>("debug/continue", { source: "llm" }, 10000);
        this.noteState(r);
        notes.push("trxmon starts the machine PAUSED: sent debug/continue");
      }
    }
    if (!opts.deferStreams) notes.push(...await this.beginStreams());
    return { identity: await this.describe(), notes };
  }

  // ---- §4c: the device's picture and sound ------------------------------------------------

  /** The device's REST as the stream controller calls it (this backend owns host, port and password). */
  private streamRest(): RestCaller {
    return async (req) => {
      try {
        const r = await this.rest.request({ method: req.method, path: req.path });
        return { status: r.status, body: JSON.stringify(r.json ?? {}) };
      } catch (e) {
        if (e instanceof UltimateRestError && e.status !== undefined) return { status: e.status, body: e.message };
        throw e;
      }
    };
  }

  /**
   * Open the UDP sockets and ask the device to send here (non-blocking: the REST starts run behind
   * a ticket, a unicast start can take seconds). Idempotent while the streams are up. A failure
   * to bind or to resolve is not a failure to select: the picture is then unavailable, and the
   * notes and `describe()` say why.
   */
  beginStreams(): Promise<string[]> {
    if (this.opts.streams === false || this.closed) return Promise.resolve([]);
    if (this.streams) { const p = this.streams.status().ports; return Promise.resolve([`streams already running (UDP ${p.video}/${p.audio})`]); }
    this.streamsStarting ??= this.openStreams().finally(() => { this.streamsStarting = undefined; });
    return this.streamsStarting;
  }

  private async openStreams(): Promise<string[]> {
    const cfg = this.opts.streams || {};
    try {
      const receiverHost = cfg.receiverHost ?? (process.env.C64RE_C64U_RECEIVER_HOST?.trim() || await localAddressTowards(this.host));
      const videoPort = cfg.videoPort ?? envPort("C64RE_C64U_VIDEO_PORT", DEFAULT_VIDEO_PORT);
      const audioPort = cfg.audioPort ?? envPort("C64RE_C64U_AUDIO_PORT", DEFAULT_AUDIO_PORT);
      const srcSetting = cfg.sourceAddress ?? (process.env.C64RE_C64U_STREAM_SOURCE?.trim() || undefined);
      let sourceAddress: string | undefined;
      if (srcSetting === "any") sourceAddress = undefined;
      else if (srcSetting) sourceAddress = srcSetting;
      else if (isIP(this.host)) sourceAddress = this.host;
      else { try { sourceAddress = (await lookup(this.host, { family: 4 })).address; } catch { sourceAddress = undefined; } }
      const streams = new C64UStreams({
        rest: this.streamRest(),
        receiverHost,
        deviceHost: sourceAddress,
        bindAddress: cfg.bindAddress,
        videoPort, audioPort,
        pausedAfterMs: cfg.pausedAfterMs,
        startTimeoutMs: cfg.startTimeoutMs,
        stopTimeoutMs: cfg.stopTimeoutMs ?? 3000,
        relay: {
          video: (m) => { this.lastVideoMessage = m; this.fanBinary({ kind: "video", data: m }); },
          audio: (m) => this.fanBinary({ kind: "audio", data: m }),
          paused: (p) => this.emit({ method: "stream/paused", params: { paused: p, ageMs: p ? (this.streams?.status().lastFrameAgeMs ?? 0) : 0 } }),
        },
      });
      const ticket = streams.startStreams();
      // The bind is quick and rejects here; the device's answers come later through the ticket.
      await Promise.race([ticket.settled.then(() => undefined), new Promise<void>((r) => setTimeout(r, 50))]);
      if (this.closed) { void streams.stopStreams().catch(() => undefined); return []; }
      this.streams = streams;
      this.streamTrouble = undefined;
      this.streamTicket = ticket.settled.then((st) => {
        const bad = (["video", "audio"] as const).filter((k) => st[k].failure).map((k) => st[k].failure!.message);
        this.streamTrouble = bad.length ? bad.join("; ") : undefined;
        return st;
      }).catch((e) => { this.streamTrouble = e instanceof Error ? e.message : String(e); });
      const p = streams.status().ports;
      return [`picture and sound: listening on UDP ${p.video} (video) / ${p.audio} (audio), the device is asked to send to ${receiverHost} (not waited for — a unicast start can take seconds; its outcome is in the streams status)`];
    } catch (e) {
      this.streams = null;
      this.streamTrouble = e instanceof Error ? e.message : String(e);
      return [`picture and sound unavailable: ${this.streamTrouble}`];
    }
  }

  private fanBinary(m: StreamMessage): void {
    for (const h of this.binaryHandlers) { try { h(m); } catch { /* a listener must not break the receiver */ } }
  }

  /** Stream state for a status line / the UI. */
  streamStatus(): { running: boolean; trouble?: string; status?: ReturnType<C64UStreams["status"]> } {
    return this.streams ? { running: true, trouble: this.streamTrouble, status: this.streams.status() } : { running: false, trouble: this.streamTrouble };
  }

  /** Resolves when the device has answered both stream starts (tests, and a caller that wants the outcome). */
  streamsSettled(): Promise<unknown> { return this.streamTicket ?? Promise.resolve(); }

  private async openLink(): Promise<void> {
    if (this.link?.isOpen) return;
    if (!this.rpcPort) throw new Error(`trxmon not running on ${this.host} — start it (runtime_backend action=start_monitor) or select the emulator`);
    this.link = new RpcLink(this.host, this.rpcPort);
    this.link.onNotification((n) => this.onAppNotification(n));
    await this.link.open();
  }

  /** The held connection, reopened once if it dropped; a device that does not answer says so. */
  private async ensureLink(): Promise<RpcLink> {
    if (!this.link || !this.link.isOpen) {
      this.connected = false;
      // The port may have changed, or trxmon may be gone, with a restart: ask the device first.
      let info: UltimateIdent | undefined;
      try { info = await this.readInfo(); }
      catch (e) {
        // A device that does not answer REST at all is gone, not "trxmon not running".
        if (e instanceof UltimateRestError && e.status === undefined) throw e;
      }
      const t = info?.trx64;
      if (t && t.rpc === undefined) {
        throw new RpcLinkError(`trxmon not running on ${this.host} — start it (runtime_backend action=start_monitor) or select the emulator`, "gone");
      }
      if (typeof t?.rpc === "number") this.rpcPort = this.opts.rpcPort ?? t.rpc;
      await this.openLink();
      this.connected = true;
    }
    return this.link!;
  }

  private onAppNotification(n: { method: string; params?: unknown }): void {
    // A state change we did not cause is the person's action at the machine: take it as truth.
    if (n.method === "debug/running") this.runState = "running";
    else if (APP_NOTIFICATIONS.includes(n.method)) this.runState = "paused";
    this.emit({ method: n.method, params: n.params });
  }

  private noteState(s: unknown): void {
    if (isObj(s) && typeof s.runState === "string") this.runState = s.runState;
  }

  /**
   * Release the one app connection and stop the streams (select back to the emulator, a switch,
   * or shutdown). Returns at once; `closeAndWait` is the same and awaits the device's answers to
   * the stream stops.
   */
  close(): void { void this.closeAndWait(); }

  closeAndWait(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.link?.close();
    this.link = null;
    this.closing ??= (async () => {
      const pending = this.streamsStarting;
      if (pending) await pending.catch(() => undefined);
      const s = this.streams;
      this.streams = null;
      if (s) { try { await s.stopStreams(); } catch { /* the device is gone: the sockets are closed regardless */ } }
      this.binaryHandlers.clear();
    })();
    return this.closing;
  }

  /**
   * §3 probe on the connection this backend keeps: `ping` and report what the app is. Used
   * by the bridge's `bridge/probe` (what `runtime_backend probe` asks for the device it serves) so that no second connection is made.
   */
  async probeHeld(): Promise<Record<string, unknown>> {
    const link = await this.ensureLink();
    const ping = await link.call<Record<string, unknown>>("ping", {}, 5000);
    this.pingReply = ping;
    return ping;
  }

  // ---- §3a: starting the app -----------------------------------------------------------

  /** Start trxmon over REST (§3a) and remember the app port the ident then names. */
  async startMonitor(o: { via?: "run_file" | "app"; path?: string; wait?: boolean } = {}): Promise<{ started: boolean; note: string }> {
    const r = await startTrxmon(this.rest, { via: o.via, path: o.path ?? this.trxmonPath, wait: o.wait, rpcPortOverride: this.opts.rpcPort });
    if (r.rpcPort !== undefined) this.rpcPort = r.rpcPort;
    return { started: r.started, note: r.note };
  }

  // ---- the tools' door ---------------------------------------------------------------------

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    const route = routeOf(method, this.served);
    if (route.kind === "refuse") throw new BackendRefusal(refusalText(method, route));
    if (route.kind === "rpc") return (await this.rpc(method, params, timeoutMs)) as T;
    if (route.kind === "api") return (await this.doApiCall(params, timeoutMs)) as T;
    return (await this.restMethod(method, params, timeoutMs)) as T;
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    // §5 "wrapped carefully": two app verbs do something drastic when a parameter is missing.
    if (method === "debug/break_add" && !(typeof params.pc === "number" || typeof params.pc === "string")) {
      throw new BackendRefusal("debug/break_add: needs `pc` — without it the app adds a breakpoint at $0000. Nothing was sent.");
    }
    if (method === "debug/break_del") {
      const hasId = params.id !== undefined && params.id !== null;
      if (!hasId && params.all !== true) {
        throw new BackendRefusal("debug/break_del: needs `id` — the app deletes ALL breakpoints when it gets none. Pass all:true to mean exactly that. Nothing was sent.");
      }
      if (params.all !== undefined) { const { all: _all, ...rest } = params; params = rest; }
    }
    const link = await this.ensureLink();
    try {
      const r = await link.call(method, params, timeoutMs);
      if (method === "debug/state" || method === "session/state" || method.startsWith("debug/")) this.noteState(r);
      return r;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32601) throw new RpcError(`${e.message} (the device's own answer: this trxmon build does not serve it)`, e.code);
      throw e;
    }
  }

  // ---- api/call: the verbs the app can express -----------------------------------------------

  private async doApiCall(params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const verb = String(params.method ?? "");
    const args = Array.isArray(params.args) ? params.args : [];
    if (!API_CALL_VERBS.includes(verb)) {
      throw new BackendRefusal(
        `api/call ${verb || "(no method)"}: not expressible on a C64 Ultimate — the app has no such verb. ` +
        `runtime_monitor speaks its monitor verbs (bk, n, z, ret, until, d, m …) instead`);
    }
    const sid = params.session_id;
    if (verb === "monitorRegisters") {
      const st = await this.rpc("session/state", { session_id: sid }, timeoutMs) as { cpu?: unknown };
      return st.cpu;
    }
    if (verb === "monitorMemory") {
      const start = Number(args[0]), end = Number(args[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || start < 0 || end > 0xffff) {
        throw new BackendRefusal(`api/call monitorMemory: needs start <= end within $0000-$FFFF, got ${JSON.stringify(args)}`);
      }
      const out: number[] = [];
      for (let a = start; a <= end; a += 32768) {
        const len = Math.min(32768, end - a + 1);
        const r = await this.rpc("session/read_memory", { session_id: sid, addr: a, length: len, lens: "cpu" }, timeoutMs) as { bytes?: number[] };
        out.push(...(r.bytes ?? []));
      }
      return out;
    }
    if (verb === "stepInto") {
      await this.rpc("debug/step", { session_id: sid, source: "llm" }, timeoutMs);
      return undefined;
    }
    return this.rpc("debug/state", { session_id: sid }, timeoutMs); // status
  }

  // ---- REST-mapped methods ---------------------------------------------------------------------

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.projectDir ?? process.cwd(), p);
  }

  private readMedium(path: string): { abs: string; name: string; bytes: Uint8Array } {
    const abs = this.resolvePath(path);
    if (!existsSync(abs)) throw new BackendRefusal(`no such file: ${abs} — nothing was sent to the device`);
    return { abs, name: basename(abs), bytes: new Uint8Array(readFileSync(abs)) };
  }

  /** §4b — bytes reach the device only with a recorded green emulator pass. */
  private gate(name: string, bytes: Uint8Array, _path?: string): void {
    const refusal = gateRefusal({ name, bytes, projectDir: this.projectDir });
    if (refusal) throw new BackendRefusal(refusal);
  }

  private mediaFrom(p: Record<string, unknown>, what: string): { abs?: string; name: string; bytes: Uint8Array } {
    if (typeof p.bytes_b64 === "string") {
      return { name: typeof p.name === "string" && p.name ? p.name : "(uploaded bytes)", bytes: new Uint8Array(Buffer.from(p.bytes_b64, "base64")) };
    }
    const path = typeof p.path === "string" ? p.path : typeof p.prg_path === "string" ? p.prg_path : undefined;
    if (!path) throw new BackendRefusal(`${what}: needs a path (or bytes_b64)`);
    return this.readMedium(path);
  }

  private async restMethod(method: string, p: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    switch (method) {
      case "session/screenshot": return this.doScreenshot();
      case "session/frame_indices": return this.doFrameIndices();
      case "audio/start": return this.doAudioStart();
      case "audio/stop": return this.doAudioStop();
      case "session/drive_status": return this.doDriveStatus(p);
      case "session/type": return this.afterRest(await this.doType(p), "typing");
      case "session/joystick_set": return this.doJoystick(p, false);
      case "session/joystick_clear": return this.doJoystick(p, true);
      case "session/load_prg": return this.afterRest(await this.doLoadPrg(p, false), "load_prg");
      case "runtime/run_prg": return this.afterRest(await this.doRunPrg(p, timeoutMs), "run_prg");
      case "media/open": return this.afterRest(await this.doMediaOpen(p, timeoutMs), "media/open");
      case "media/mount": return this.afterRest(await this.doMediaOpen(p, timeoutMs, "mount"), "media/mount");
      case "media/ingress": return this.afterRest(await this.doMediaIngress(p, timeoutMs), "media/ingress");
      case "media/unmount": return this.afterRest(await this.doUnmount(p), "media/unmount");
      case "session/drive_power": return this.afterRest(await this.doDrivePower(p), "drive power");
      case "session/drive_reset": return this.afterRest(await this.doDriveSimple(p, "reset"), "drive reset");
      case "session/reset": return this.afterRest(await this.doReset(p), "machine reset");
      case "session/power": return this.afterRest(await this.doPower(p), "power");
      default: throw new BackendRefusal(`${method}: listed as REST-mapped but has no mapping — this is a bug in the routing table`);
    }
  }

  /** §7 — a REST action pushes no state change into trxmon: re-read debug/state before answering. */
  private async afterRest(result: unknown, what: string): Promise<unknown> {
    let debugState: unknown = null;
    let note = "ring anchors and marks taken before this may be stale (the ring does not restore SID, drive A, flash or VIC internals)";
    try {
      const link = await this.ensureLink();
      debugState = await link.call("debug/state", {}, 5000);
      this.noteState(debugState);
    } catch (e) {
      note = `debug/state could not be re-read after ${what} (${e instanceof Error ? e.message : String(e)}); ${note}`;
    }
    const base = isObj(result) ? result : { result };
    return { ...base, afterRest: { debugState, note } };
  }

  private async doScreenshot(): Promise<unknown> {
    const frame = await this.frameSource.latest();
    if (!frame) {
      throw new BackendRefusal(
        `session/screenshot: no frame to give — ${this.frameSource.describe()}. The app refuses session/screenshot and REST has none; ` +
        `the picture of a C64 Ultimate is its UDP video stream, and a paused machine sends none.`);
    }
    const ageMs = Math.max(0, Date.now() - frame.receivedAt);
    const streamPaused = frame.extra?.streamPaused === true;
    const paused = this.runState === "paused" || streamPaused;
    return {
      dataUrl: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`,
      width: frame.width,
      height: frame.height,
      ageMs,
      complete: frame.complete,
      ...(frame.extra ?? {}),
      ...(paused ? { note: `the machine is paused: this is the last complete frame received, ${ageMs} ms old` } : {}),
    };
  }

  private async doFrameIndices(): Promise<unknown> {
    if (!this.streams) {
      throw new BackendRefusal(`session/frame_indices: the device's video stream is not running here${this.streamTrouble ? ` (${this.streamTrouble})` : ""} — there is no frame to give`);
    }
    try { return this.streams.frameIndices(); }
    catch (e) { throw new BackendRefusal(`session/frame_indices: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** `audio/start`: the stream is the device's; the reply carries ITS rate so the player resamples from it. */
  private async doAudioStart(): Promise<unknown> {
    if (!this.streams) {
      throw new BackendRefusal(`audio/start: the device's audio stream is not running here${this.streamTrouble ? ` (${this.streamTrouble})` : ""} — it arrives over UDP, started when the bridge connected to the device`);
    }
    return { ok: true, ...this.streams.audioFormat(), source: "c64u-audio-stream" };
  }

  /** `audio/stop` ends the listener's playback; the device's stream stays owned by this backend for as long as the bridge runs. */
  private async doAudioStop(): Promise<unknown> {
    return { ok: true };
  }

  private async doDriveStatus(p: Record<string, unknown>): Promise<unknown> {
    const unit = Number(p.unit ?? 8);
    const letter = driveLetter(unit);
    if (!letter) throw new BackendRefusal(`session/drive_status: unit ${unit} — a C64 Ultimate has drives a (8) and b (9)`);
    const r = await this.rest.request({ method: "GET", path: "/v1/drives" });
    const list = Array.isArray(r.json?.drives) ? (r.json!.drives as Record<string, unknown>[]) : [];
    const entry = list.map((d) => d[letter]).find(isObj);
    if (!entry) throw new BackendRefusal(`session/drive_status: the device reports no drive ${letter}`);
    return {
      unit, drive: letter,
      powered: entry.enabled === true,
      busId: entry.bus_id,
      type: entry.type,
      rom: entry.rom,
      mounted: entry.image_file ? { file: entry.image_file, path: entry.image_path } : null,
      source: "REST /v1/drives",
    };
  }

  private async doType(p: Record<string, unknown>): Promise<unknown> {
    const text = String(p.text ?? "");
    const { taps, unmapped } = textToTaps(text);
    if (unmapped.length) {
      throw new BackendRefusal(`session/type: no C64 key for ${[...new Set(unmapped)].join(", ")} — nothing was typed. Use the characters of the C64 keyboard (letters, digits, space, RETURN and the shifted symbols).`);
    }
    if (taps.length === 0) return { queued: 0, via: "REST machine:input" };
    for (const body of tapBatches(taps)) {
      await this.rest.request({ method: "POST", path: "/v1/machine:input", jsonBody: body });
    }
    return {
      queued: taps.length,
      via: "REST machine:input",
      note: "hold_cycles / gap_cycles are not used: the firmware paces the taps itself, and the keys are tapped before this call returns",
    };
  }

  private async doJoystick(p: Record<string, unknown>, clear: boolean): Promise<unknown> {
    const port = Number(p.port ?? 2);
    if (port !== 1 && port !== 2) throw new BackendRefusal(`joystick: port must be 1 or 2, got ${port}`);
    const state = clear ? {} : (p as { up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean });
    for (const ev of joystickEvents(port, state)) {
      await this.rest.request({ method: "POST", path: "/v1/machine:input", jsonBody: { events: [ev] } });
    }
    return { port, ...(clear ? { cleared: true } : { up: !!state.up, down: !!state.down, left: !!state.left, right: !!state.right, fire: !!state.fire }), via: "REST machine:input" };
  }

  private async doLoadPrg(p: Record<string, unknown>, run: boolean): Promise<{ loadAddress: number; endAddress: number; bytesLoaded: number }> {
    const m = this.mediaFrom(p, run ? "runtime/run_prg" : "session/load_prg");
    return this.loadPrgBytes(m, typeof p.load_address === "number" ? p.load_address : undefined, run);
  }

  private async loadPrgBytes(m: { abs?: string; name: string; bytes: Uint8Array }, loadAddress: number | undefined, run: boolean): Promise<{ loadAddress: number; endAddress: number; bytesLoaded: number }> {
    if (m.bytes.length < 3) throw new BackendRefusal(`${m.name}: a PRG needs a 2-byte load address and at least one byte`);
    this.gate(m.name, m.bytes, m.abs);
    let bytes = m.bytes;
    if (!run && loadAddress !== undefined) {
      bytes = new Uint8Array(m.bytes);
      bytes[0] = loadAddress & 0xff; bytes[1] = (loadAddress >> 8) & 0xff;
    }
    await this.rest.request({ method: "POST", path: run ? "/v1/runners:run_prg" : "/v1/runners:load_prg", body: bytes });
    const at = bytes[0] | (bytes[1] << 8);
    const bytesLoaded = bytes.length - 2;
    return { loadAddress: at, endAddress: at + bytesLoaded - 1, bytesLoaded };
  }

  private async doRunPrg(p: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const m = this.mediaFrom(p, "runtime/run_prg");
    return this.runPrgBytes(m, typeof p.run === "number" ? p.run : undefined, p.session_id, timeoutMs);
  }

  private async runPrgBytes(m: { abs?: string; name: string; bytes: Uint8Array }, entry: number | undefined, sessionId: unknown, timeoutMs: number): Promise<{ loadAddress: number; action: string }> {
    if (entry === undefined) {
      const r = await this.loadPrgBytes(m, undefined, true);
      return { loadAddress: r.loadAddress, action: r.loadAddress === 0x0801 ? "RUN (BASIC, started by the device's run_prg)" : `started by the device at its load address $${r.loadAddress.toString(16).padStart(4, "0")}` };
    }
    const r = await this.loadPrgBytes(m, undefined, false);
    await this.rpc("monitor/exec", { session_id: sessionId, command: `g ${entry.toString(16)}`, source: "llm" }, timeoutMs);
    return { loadAddress: r.loadAddress, action: `g $${entry.toString(16).padStart(4, "0")} (REST load_prg, then the monitor's go)` };
  }

  private async mountDisk(m: { name: string; bytes: Uint8Array }, kind: string, unit: number, writeProtected: boolean): Promise<void> {
    const letter = driveLetter(unit);
    if (!letter) throw new BackendRefusal(`a C64 Ultimate has drives a (unit 8) and b (unit 9); unit ${unit} is not one of them`);
    await this.rest.request({
      method: "POST", path: `/v1/drives/${letter}:mount`,
      query: { type: kind, mode: writeProtected ? "readonly" : "readwrite" }, body: m.bytes,
    });
  }

  private async doMediaOpen(p: Record<string, unknown>, timeoutMs: number, via: "open" | "mount" = "open"): Promise<unknown> {
    const m = this.mediaFrom(p, `media/${via}`);
    const kind = sniffMedia(m.bytes, m.name);
    if (kind === "snapshot") throw new BackendRefusal(`media/${via}: ${m.name} is a .c64re snapshot — a C64 Ultimate has no snapshot undump; run it on the emulator`);
    if (kind === "unknown") throw new BackendRefusal(`media/${via}: cannot tell what ${m.name} is (not a CRT, a disk image or a PRG)`);
    this.gate(m.name, m.bytes, m.abs);
    const label = m.abs ?? m.name;
    if (kind === "crt") {
      await this.rest.request({ method: "POST", path: "/v1/runners:run_crt", body: m.bytes });
      return { kind: "crt", path: label, message: `RUN_CRT ${label} — the Ultimate STARTS a cartridge, there is no mount-only` };
    }
    if (kind === "prg") {
      if (via === "mount") throw new BackendRefusal(`media/mount: ${m.name} is a PRG, not a mountable medium — media/open or runtime_run_prg starts it`);
      const r = await this.runPrgBytes(m, typeof p.run === "number" ? p.run : undefined, p.session_id, timeoutMs);
      return { kind: "prg", path: label, loadAddress: r.loadAddress, message: `LOAD ${label} → $${r.loadAddress.toString(16).padStart(4, "0")} — ${r.action}` };
    }
    const unit = Number(p.unit ?? p.slot ?? 8);
    await this.mountDisk(m, kind, unit, p.write_protected === true);
    return { kind, path: label, message: `MOUNT ${label} (${kind}) on drive ${driveLetter(unit)} — uploaded to the device; writes land in its temporary copy, the host image is not changed` };
  }

  private async doMediaIngress(p: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const kind = String(p.kind ?? "disk");
    if (kind === "eject") {
      const role = String(p.role ?? "drive8");
      if (role === "cartridge" || role === "auto") {
        throw new BackendRefusal(`media/ingress eject role=${role}: the Ultimate's REST API has no route that ejects a cartridge started with run_crt${role === "auto" ? ", and cannot say whether one is in" : ""} — name role=drive8 for the disk`);
      }
      return this.doUnmount({ ...p, role });
    }
    if (kind === "crt") return this.doMediaOpen({ ...p, path: p.path }, timeoutMs);
    if (kind === "disk") {
      const m = this.mediaFrom(p, "media/ingress");
      const dk = sniffMedia(m.bytes, m.name);
      if (!["d64", "g64", "d71", "g71", "d81"].includes(dk)) throw new BackendRefusal(`media/ingress kind=disk: ${m.name} is not a disk image (looks like ${dk})`);
      this.gate(m.name, m.bytes, m.abs);
      const unit = Number(p.unit ?? p.slot ?? 8);
      await this.mountDisk(m, dk, unit, p.write_protected === true);
      return { kind: "disk", path: m.abs ?? m.name, message: `MOUNT ${m.abs ?? m.name} (${dk}) — uploaded to the device; writes land in its temporary copy` };
    }
    if (kind === "prg") {
      const m = this.mediaFrom(p, "media/ingress");
      const entry = typeof p.entry === "number" ? p.entry : undefined;
      if (p.mode === "inject-run") {
        const r = await this.runPrgBytes(m, entry, p.session_id, timeoutMs);
        return { kind: "prg", path: m.abs ?? m.name, loadAddress: r.loadAddress, action: r.action };
      }
      const r = await this.loadPrgBytes(m, undefined, false);
      return { kind: "prg", path: m.abs ?? m.name, ...r, action: "loaded, not started" };
    }
    throw new BackendRefusal(`media/ingress kind=${kind}: not a medium kind (disk, prg, crt, eject)`);
  }

  private async doUnmount(p: Record<string, unknown>): Promise<unknown> {
    const role = String(p.role ?? "drive8");
    if (role === "cartridge" || p.slot === 0) {
      throw new BackendRefusal("media/unmount role=cartridge: the Ultimate's REST API has no route that ejects a cartridge started with run_crt");
    }
    if (role === "auto") throw new BackendRefusal("media/unmount role=auto: this backend cannot see whether a cartridge is in — name role=drive8 for the disk");
    const unit = Number(p.unit ?? p.slot ?? 8);
    const letter = driveLetter(unit);
    if (!letter) throw new BackendRefusal(`media/unmount: unit ${unit} — a C64 Ultimate has drives a (8) and b (9)`);
    await this.rest.request({ method: "PUT", path: `/v1/drives/${letter}:remove` });
    return { ejected: true, role: "drive8", drive: letter, via: "REST drives:remove" };
  }

  private async doDrivePower(p: Record<string, unknown>): Promise<unknown> {
    const letter = driveLetter(Number(p.unit ?? 8));
    if (!letter) throw new BackendRefusal(`session/drive_power: unit ${p.unit} — a C64 Ultimate has drives a (8) and b (9)`);
    if (typeof p.on !== "boolean") throw new BackendRefusal("session/drive_power: needs on:true|false (the Ultimate has no 'read the power' route besides drive_status)");
    await this.rest.request({ method: "PUT", path: `/v1/drives/${letter}:${p.on ? "on" : "off"}` });
    return { drive: letter, powered: p.on, via: "REST drives" };
  }

  private async doDriveSimple(p: Record<string, unknown>, what: "reset"): Promise<unknown> {
    const letter = driveLetter(Number(p.unit ?? 8));
    if (!letter) throw new BackendRefusal(`session/drive_${what}: unit ${p.unit} — a C64 Ultimate has drives a (8) and b (9)`);
    await this.rest.request({ method: "PUT", path: `/v1/drives/${letter}:${what}` });
    return { drive: letter, reset: true, via: "REST drives" };
  }

  private async doReset(p: Record<string, unknown>): Promise<unknown> {
    const soft = p.mode === "soft";
    await this.rest.request({ method: "PUT", path: soft ? "/v1/machine:reset" : "/v1/machine:reboot" });
    // §4c: a system reset clears the device's stream enable; start again what was wanted (not waited for).
    this.streams?.rearm();
    return { mode: soft ? "soft" : "cold", via: soft ? "REST machine:reset (pulls reset; the cartridge stays as it is)" : "REST machine:reboot (resets and re-initialises the cartridge)" };
  }

  private async doPower(p: Record<string, unknown>): Promise<unknown> {
    if (p.op === "off") {
      await this.rest.request({ method: "PUT", path: "/v1/machine:poweroff" });
      return { op: "off", powered: false, via: "REST machine:poweroff", note: "the machine can only be turned back on at the machine" };
    }
    if (p.op === "on") throw new BackendRefusal("session/power op=on: a C64 Ultimate can only be turned on at the machine (the REST poweroff has no counterpart)");
    throw new BackendRefusal("session/power: op must be \"on\" or \"off\"");
  }
}
