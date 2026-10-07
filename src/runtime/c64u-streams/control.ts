// Spec 889 §4c — telling the device where to send. Route: 1541ultimate/software/api/route_streams.cc,
//   PUT /v1/streams/{video|audio}:start?ip=<host:port>     (a second start REPLACES the target)
//   PUT /v1/streams/{video|audio}:stop                     (stopping a stopped stream is not an error)
//
// A unicast start ARPs for the receiver's MAC for up to 25 x 100 ms and can block for seconds
// ("Cannot find MAC"), so `start` never makes its caller wait: it returns a ticket at once and the
// REST calls run behind it, each under its own deadline, with the outcome in `status()` and the
// ticket's `settled` promise. A timeout is reported as a timeout, a device's refusal verbatim.
//
// The REST transport is injected (`RestCaller`): the C64U backend owns the connection, its
// password and its host; this module only knows paths. `httpRestCaller` is the plain-HTTP one.
//
// Not detectable: where the streams point when someone else started them. The device has no
// "get target", so the backend cannot say "they were pointed elsewhere" before it takes them;
// it can only replace the target and say that it did.

export type StreamName = "video" | "audio";

export interface RestRequest { readonly method: "PUT"; readonly path: string; readonly timeoutMs: number }
export interface RestReply { readonly status: number; readonly body: string }
export type RestCaller = (req: RestRequest) => Promise<RestReply>;

export type StreamFailureKind = "timeout" | "refused" | "unreachable";
export interface StreamFailure { readonly kind: StreamFailureKind; readonly message: string }
export type StreamPhase = "idle" | "starting" | "running" | "failed";

export interface StreamState {
  readonly phase: StreamPhase;
  /** The `ip=` the device was told, when a start was issued. */
  readonly target: string | null;
  readonly failure: StreamFailure | null;
  /** Number of start requests issued for this stream (re-arms included). */
  readonly starts: number;
}

export interface ControllerOptions {
  readonly rest: RestCaller;
  /** This host's address as the DEVICE reaches it (the unicast destination). */
  readonly receiverHost: string;
  /** Where the receiver listens; read at each start, so a rebind is picked up. */
  readonly ports: () => { readonly video: number; readonly audio: number };
  /** Deadline for one start request (ARP alone is up to 2.5 s). Default 15 s. */
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Called whenever a stream is (re-)started: the continuity of that stream ended. */
  readonly onRestart?: (stream: StreamName) => void;
  readonly onStatus?: (s: Readonly<Record<StreamName, StreamState>>) => void;
}

export interface StartTicket {
  /** Resolves when both start requests have an outcome (never rejects). */
  readonly settled: Promise<Readonly<Record<StreamName, StreamState>>>;
}

export const DEFAULT_START_TIMEOUT_MS = 15_000;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const idle = (): StreamState => ({ phase: "idle", target: null, failure: null, starts: 0 });

export class StreamController {
  private st: Record<StreamName, StreamState> = { video: idle(), audio: idle() };
  private desired = false;
  private generation = 0;
  private inFlight: StartTicket | null = null;

  constructor(private readonly o: ControllerOptions) {}

  status(): Readonly<Record<StreamName, StreamState>> { return { video: this.st.video, audio: this.st.audio }; }

  /** Ask the device to send both streams here. Returns at once; see StartTicket. */
  start(): StartTicket {
    if (this.inFlight) return this.inFlight;
    this.desired = true;
    const gen = ++this.generation;
    const ticket: StartTicket = { settled: this.runStart(gen).finally(() => { if (this.inFlight === ticket) this.inFlight = null; }) };
    this.inFlight = ticket;
    return ticket;
  }

  /** After a system reset (it clears the stream enable; REST reset / run_crt / mount do not): start again what was wanted. */
  rearm(): StartTicket {
    if (!this.desired) return { settled: Promise.resolve(this.status()) };
    return this.start();
  }

  /** Stop both (audio first, so a failed audio stop still leaves the video stop to run). Awaits the device's answers. */
  async stop(): Promise<Readonly<Record<StreamName, StreamState>>> {
    this.desired = false;
    this.generation++; // a start still in flight must not mark the streams running afterwards
    this.inFlight = null;
    for (const name of ["audio", "video"] as const) {
      const failure = await this.call(name, "stop", this.o.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      this.set(name, failure
        ? { phase: "failed", target: this.st[name].target, failure, starts: this.st[name].starts }
        : { phase: "idle", target: null, failure: null, starts: this.st[name].starts });
    }
    return this.status();
  }

  private async runStart(gen: number): Promise<Readonly<Record<StreamName, StreamState>>> {
    const ports = this.o.ports();
    // Sequential: the device handles one REST call at a time, and the first ARP warms the cache for the second.
    for (const name of ["video", "audio"] as const) {
      if (gen !== this.generation) break;
      const target = `${this.o.receiverHost}:${ports[name]}`;
      this.set(name, { phase: "starting", target, failure: null, starts: this.st[name].starts + 1 });
      this.o.onRestart?.(name);
      const failure = await this.call(name, "start", this.o.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, target);
      if (gen !== this.generation) break;
      this.set(name, failure
        ? { phase: "failed", target, failure, starts: this.st[name].starts }
        : { phase: "running", target, failure: null, starts: this.st[name].starts });
    }
    return this.status();
  }

  private async call(name: StreamName, verb: "start" | "stop", timeoutMs: number, target?: string): Promise<StreamFailure | null> {
    const path = `/v1/streams/${name}:${verb}` + (verb === "start" ? `?ip=${encodeURIComponent(target!)}` : "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const reply = await Promise.race([this.o.rest({ method: "PUT", path, timeoutMs }), deadline]);
      if (reply === "timeout") {
        return {
          kind: "timeout",
          message: `${name}:${verb} did not answer within ${(timeoutMs / 1000).toFixed(1)} s` +
            (verb === "start" ? ` — the device ARPs for the receiver ${target} and gives up only after seconds; is that address reachable from the device?` : ""),
        };
      }
      if (reply.status >= 200 && reply.status < 300) return null;
      return { kind: "refused", message: `${name}:${verb} refused by the device (HTTP ${reply.status}): ${reply.body.trim().slice(0, 300)}` };
    } catch (e) {
      const err = e as { name?: string; code?: string; message?: string };
      if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ETIMEDOUT") {
        return { kind: "timeout", message: `${name}:${verb} timed out after ${(timeoutMs / 1000).toFixed(1)} s (${err.message ?? err.name})` };
      }
      return { kind: "unreachable", message: `${name}:${verb} failed: ${err.message ?? String(e)}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private set(name: StreamName, s: StreamState): void {
    this.st = { ...this.st, [name]: s };
    this.o.onStatus?.(this.status());
  }
}

/** Plain-HTTP RestCaller against `http://<host>` (Ultimate REST). `password` goes in X-Password when the device has one. */
export function httpRestCaller(baseUrl: string, opt: { readonly password?: string } = {}): RestCaller {
  return async (req) => {
    const headers: Record<string, string> = {};
    if (opt.password) headers["X-Password"] = opt.password;
    const res = await fetch(baseUrl.replace(/\/$/, "") + req.path, {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  };
}
