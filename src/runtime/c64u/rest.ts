// Spec 889 §2 — the REST half of the C64U backend: Gideon's U64 REST API over fetch.
//
// `X-Password` is the device's own header. The password lives in this object's memory for the
// session only; it is never written anywhere and never logged (the error text names the
// header, not the value).

export class UltimateRestError extends Error {
  constructor(message: string, readonly status?: number, readonly errors: string[] = []) { super(message); this.name = "UltimateRestError"; }
}

export interface RestResult {
  status: number;
  /** Parsed JSON body, when the answer was JSON. */
  json?: Record<string, unknown>;
  /** Raw body, when it was not (readmem, menu_screen). */
  bytes?: Uint8Array;
}

export interface RestRequest {
  method: "GET" | "PUT" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  /** A raw body (an upload). */
  body?: Uint8Array;
  /** A JSON body. */
  jsonBody?: unknown;
}

export class UltimateRest {
  constructor(
    readonly host: string,
    readonly port: number,
    private password: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15000,
  ) {}

  setPassword(p: string | undefined): void { this.password = p; }
  get hasPassword(): boolean { return !!this.password; }
  get base(): string { return `http://${this.host}${this.port === 80 ? "" : `:${this.port}`}`; }

  /** One REST call. Throws UltimateRestError for an unreachable device and for any non-2xx answer. */
  async request(req: RestRequest): Promise<RestResult> {
    const q = Object.entries(req.query ?? {}).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const url = `${this.base}${req.path}${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = {};
    if (this.password) headers["X-Password"] = this.password;
    let body: BodyInit | undefined;
    if (req.jsonBody !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(req.jsonBody); }
    else if (req.body) { headers["Content-Type"] = "application/octet-stream"; body = req.body as unknown as BodyInit; }
    let res: Response;
    try {
      // An upload (a CRT, a disk image) is written to the device's storage before it answers.
      const limit = req.body ? Math.max(this.timeoutMs, 120_000) : this.timeoutMs;
      res = await this.fetchImpl(url, { method: req.method, headers, body, signal: AbortSignal.timeout(limit) });
    } catch (e) {
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      throw new UltimateRestError(`C64 Ultimate ${this.host} unreachable over REST (${req.method} ${req.path}): ${why}`);
    }
    const type = res.headers.get("content-type") ?? "";
    let json: Record<string, unknown> | undefined;
    let bytes: Uint8Array | undefined;
    if (type.includes("json")) {
      try { json = (await res.json()) as Record<string, unknown>; } catch { json = undefined; }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    const errors = Array.isArray(json?.errors) ? (json!.errors as unknown[]).map(String) : [];
    if (res.status >= 400) { // the HTTP status is the verdict; a 2xx with text in `errors` is the device being chatty
      const hint = res.status === 403
        ? " — the device wants its REST password (X-Password); give it to runtime_backend once"
        : res.status === 423 ? " — the subsystem is locked: another app is running on the device, or the machine is busy"
        : "";
      throw new UltimateRestError(
        `C64 Ultimate ${this.host}: ${req.method} ${req.path} → HTTP ${res.status}${errors.length ? `: ${errors.join("; ")}` : ""}${hint}`,
        res.status, errors);
    }
    return { status: res.status, json, bytes };
  }

  /** `GET /v1/info`, the per-host probe. */
  async info(): Promise<Record<string, unknown>> {
    const r = await this.request({ method: "GET", path: "/v1/info" });
    return r.json ?? {};
  }
}
