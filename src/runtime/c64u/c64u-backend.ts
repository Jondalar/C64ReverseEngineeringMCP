// Spec 889 — the C64 Ultimate backend: the second implementation behind the runtime contract.
//
// Two connections, held while this backend is selected:
//   - REST (`http://<host>/v1/…`): media, machine, input, drives, apps; X-Password in memory only;
//   - ONE app WebSocket to trxmon (`RpcLink`): the TRX64 methods the app implements.
// `call(method, params)` is the tools' door and keeps the daemon's method names and answer
// shapes. What a name means here is `routing.ts`'s table: served by the app (pass-through),
// mapped onto REST (this file), or refused BY NAME with the reason and the way out. After any
// REST action that changes the machine, `debug/state` is re-read (§7) because trxmon is not
// told. Nothing here ever reaches an emulator and nothing falls back to one.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { findProjectRoot } from "../../project-root.js";
import { gateRefusal } from "../emulator-pass.js";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol } from "../setup-recipe.js";
import { RuntimeMethods, type BackendIdentity, type BackendNotification } from "../runtime-methods.js";
import { classifyIdent, type UltimateIdent } from "./discovery.js";
import { NoFrameSource, type FrameSource } from "./frame-source.js";
import { UltimateRest, UltimateRestError } from "./rest.js";
import { RpcError, RpcLink, RpcLinkError } from "./rpc-link.js";
import { driveLetter, joystickEvents, sniffMedia, tapBatches, textToTaps } from "./rest-map.js";
import { APP_NOTIFICATIONS, API_CALL_VERBS, capabilityGaps, parseCapabilities, refusalText, routeOf } from "./routing.js";

/** Where trxmon is installed on a device, when nothing else says (T21 §8.1: the manifest's own
 *  example and the REST `run_file` documentation both name `/Flash/apps/trxmon.u2a`). */
export const DEFAULT_TRXMON_PATH = "/Flash/apps/trxmon.u2a";

/** A call the backend refused by name. Distinct from a device error so a caller can tell the two. */
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
  /** The project a gate lookup falls back to when the medium lies in none. */
  projectDir?: string;
  /** Selected by environment: connect on the first call instead of on a select. */
  lazyConnect?: boolean;
}

export interface ConnectOptions {
  /** Start trxmon over REST when the ident says it is not running (§3a). */
  startMonitor?: boolean;
  /** Leave the machine paused after select instead of sending debug/continue. */
  paused?: boolean;
}

export interface ConnectReport {
  identity: BackendIdentity;
  /** What happened, in order, for the tool to say. */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  private everConnected = false;
  private lazyP: Promise<void> | undefined;

  constructor(private readonly opts: C64UOptions) {
    super();
    this.host = opts.host;
    this.rest = new UltimateRest(opts.host, opts.restPort ?? 80, opts.password, opts.fetchImpl);
    this.rpcPort = opts.rpcPort;
    this.frameSource = opts.frameSource ?? new NoFrameSource();
    this.trxmonPath = opts.trxmonPath ?? DEFAULT_TRXMON_PATH;
    this.projectDir = opts.projectDir;
  }

  setProjectDir(dir: string | undefined): void { if (dir) this.projectDir = dir; }
  setPassword(p: string | undefined): void { this.rest.setPassword(p); }
  setFrameSource(s: FrameSource): void { this.frameSource = s; }
  get restPort(): number { return this.rest.port; }
  get isConnected(): boolean { return this.connected && !!this.link?.isOpen; }
  get heldRpcPort(): number | undefined { return this.rpcPort; }

  onNotification(handler: (n: BackendNotification) => void): () => void {
    this.noteHandlers.add(handler);
    return () => { this.noteHandlers.delete(handler); };
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
    return { identity: await this.describe(), notes };
  }

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
    for (const h of this.noteHandlers) { try { h({ method: n.method, params: n.params }); } catch { /* a listener must not break the link */ } }
  }

  private noteState(s: unknown): void {
    if (isObj(s) && typeof s.runState === "string") this.runState = s.runState;
  }

  /** Release the one app connection (select back to the emulator, or shutdown). */
  close(): void {
    this.connected = false;
    this.link?.close();
    this.link = null;
  }

  /**
   * §3 probe on the connection this backend keeps: `ping` and report what the app is. Used
   * by `runtime_backend probe` for the selected device so that no second connection is made.
   */
  async probeHeld(): Promise<Record<string, unknown>> {
    const link = await this.ensureLink();
    const ping = await link.call<Record<string, unknown>>("ping", {}, 5000);
    this.pingReply = ping;
    return ping;
  }

  // ---- §3a: starting the app -----------------------------------------------------------

  /**
   * Start trxmon over REST. `via: "run_file"` (default, works on every build) passes the
   * device path of trxmon.u2a; `via: "app"` uses the registered app and needs app 5b605bb0 or
   * later installed (an older install answers 403 until reinstalled). 423 = already running.
   */
  async startMonitor(o: { via?: "run_file" | "app"; path?: string; wait?: boolean } = {}): Promise<{ started: boolean; note: string }> {
    const via = o.via ?? "run_file";
    const path = o.path ?? this.trxmonPath;
    let started = true;
    let note: string;
    try {
      if (via === "app") {
        await this.rest.request({ method: "PUT", path: "/v1/apps/trxmon:run", query: { action: "serve" } });
        note = "started trxmon (PUT /v1/apps/trxmon:run action=serve)";
      } else {
        await this.rest.request({ method: "PUT", path: "/v1/apps:run_file", query: { app: path, action: "serve" } });
        note = `started trxmon from ${path} (PUT /v1/apps:run_file action=serve)`;
      }
    } catch (e) {
      if (e instanceof UltimateRestError && e.status === 423) {
        started = false;
        note = "trxmon is already running on the device (423: an app is resident) — probing it";
      } else if (e instanceof UltimateRestError && e.status === 403 && via === "app") {
        throw new Error(`${e.message}. The installed trxmon manifest has no REST action (an older install): reinstall the app, or start it with via=run_file and its path (default ${DEFAULT_TRXMON_PATH}).`);
      } else if (e instanceof UltimateRestError && e.status === 404) {
        throw new Error(`${e.message}. trxmon.u2a was not found at ${path} on the device — give its full device path (the path parameter).`);
      } else throw e;
    }
    if (o.wait !== false) {
      // The RPC port appears in the ident only while trxmon runs.
      const deadline = Date.now() + 8000;
      for (;;) {
        try {
          const info = await this.readInfo();
          const rpc = info.trx64?.rpc;
          if (typeof rpc === "number") { this.rpcPort = this.opts.rpcPort ?? rpc; break; }
        } catch { /* keep polling until the deadline */ }
        if (Date.now() > deadline) { note += "; the ident did not name an app port within 8 s"; break; }
        await sleep(200);
      }
    }
    return { started, note };
  }

  // ---- the tools' door ---------------------------------------------------------------------

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    // Selected by environment (C64RE_RUNTIME_BACKEND): no select call ran, so the first call
    // does the select-time connect. A failure is that call's error — never a fallback.
    if (this.opts.lazyConnect && !this.everConnected) {
      this.lazyP ??= this.connect().then(() => { this.everConnected = true; }).finally(() => { this.lazyP = undefined; });
      await this.lazyP;
    }
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

  private projectFor(path: string | undefined): string | undefined {
    if (path && isAbsolute(path)) { const p = findProjectRoot(dirname(path)); if (p) return p; }
    return this.projectDir ?? process.env.C64RE_PROJECT_DIR ?? undefined;
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.projectDir ?? process.env.C64RE_PROJECT_DIR ?? process.cwd(), p);
  }

  private readMedium(path: string): { abs: string; name: string; bytes: Uint8Array } {
    const abs = this.resolvePath(path);
    if (!existsSync(abs)) throw new BackendRefusal(`no such file: ${abs} — nothing was sent to the device`);
    return { abs, name: basename(abs), bytes: new Uint8Array(readFileSync(abs)) };
  }

  /** §4b — bytes reach the device only with a recorded green emulator pass. */
  private gate(name: string, bytes: Uint8Array, path?: string): void {
    const refusal = gateRefusal({ name, bytes, projectDir: this.projectFor(path) });
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
    const paused = this.runState === "paused";
    return {
      dataUrl: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`,
      width: frame.width,
      height: frame.height,
      ageMs,
      complete: frame.complete,
      ...(paused ? { note: `the machine is paused: this is the last complete frame received, ${ageMs} ms old` } : {}),
    };
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
