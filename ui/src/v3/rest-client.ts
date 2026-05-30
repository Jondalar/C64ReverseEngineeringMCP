// Spec 724B — REST helper for the One-UI shell. The v3 workbench reaches the
// HTTP knowledge/trace API same-origin (vite proxies /api → the workspace-ui
// server; in prod the server serves the UI). This is the READ side of the same
// project the LLM writes through MCP — never a second knowledge store, never a
// raw-SQL or repo-samples path.

export interface ProjectConfig {
  defaultProjectDir: string;
  apiOnly: boolean;
  hasUiDist: boolean;
}

export interface WorkspaceSnapshot {
  project?: { name?: string; rootPath?: string; status?: string };
  counts?: Record<string, number>;
  findings?: Array<{ id: string; title: string; kind: string; status: string; summary?: string; updatedAt?: string }>;
  entities?: Array<{ id: string; name: string; kind: string; summary?: string }>;
  artifacts?: Array<{ id: string; title: string; kind: string; path?: string; relativePath?: string; role?: string; status?: string; internal?: boolean }>;
  flows?: Array<{ id: string; name?: string; title?: string; summary?: string }>;
  openQuestions?: Array<{ id: string; question?: string; title?: string; status?: string; kind?: string }>;
  views?: {
    projectDashboard?: unknown;
    memoryMap?: unknown;
    diskLayout?: unknown;
    cartridgeLayout?: unknown;
    mediumLayout?: unknown;
    annotatedListing?: unknown;
    loadSequence?: unknown;
    flowGraph?: unknown;
  };
}

export interface DocEntry { groupId?: string; relativePath?: string; path?: string; title?: string }
export interface GraphicsItem { id?: string; label?: string; title?: string; kind?: string; start?: number; end?: number; confirmed?: boolean; [k: string]: unknown }

export interface TraceMark { label: string; cycle: number }
export interface TraceArtifact {
  name: string; path: string; sizeBytes: number;
  runId?: string; events?: number; marks?: TraceMark[]; error?: string;
}
export interface TraceInfo {
  path: string;
  meta: Record<string, string>;
  tableCounts: Record<string, number>;
  masterClockRange?: { min: number; max: number };
}
export interface PcCount { pc: number; count: number }
export interface TraceEventRow { [k: string]: unknown }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status} ${path}`);
  return body as T;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status} ${path}`);
  return body as T;
}

export interface ArtifactItem { id: string; title: string; kind: string; path?: string; relativePath?: string; role?: string; status?: string; internal?: boolean }

export const api = {
  config: () => getJson<ProjectConfig>("/api/config"),
  workspace: () => getJson<WorkspaceSnapshot>("/api/workspace"),
  docs: () => getJson<{ projectDir: string; docs: DocEntry[] }>("/api/docs"),
  document: async (relativePath: string): Promise<string> => {
    const res = await fetch(`/api/document?path=${encodeURIComponent(relativePath)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} /api/document`);
    return res.text();
  },
  graphics: () => getJson<{ projectDir: string; items?: GraphicsItem[] }>("/api/graphics"),
  // Scrub: fetch a raw byte slice of an artifact (projectDir from the resolved
  // workspace; the UI passes the project root it got from /api/config).
  artifactRaw: async (projectDir: string, relativePath: string, offset: number, length: number): Promise<Uint8Array> => {
    const p = new URLSearchParams({ projectDir, path: relativePath, offset: String(offset), length: String(length) });
    const res = await fetch(`/api/artifact/raw?${p.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} /api/artifact/raw`);
    return new Uint8Array(await res.arrayBuffer());
  },
  // Reclassify (authoring): persist a graphics segment into <prg>_annotations.json
  // (picked up by the next disasm_prg). Same endpoint the v1 Scrub panel used.
  annotateSegment: (payload: { projectDir: string; prgPath: string; start: string; end: string; kind: string; label?: string; comment?: string }) =>
    postJson<{ annotationsPath: string; totalSegments: number }>("/api/scrub/annotate-segment", payload),
  // Confirm / reject a heuristic segment.
  confirmSegment: (payload: { projectDir: string; artifactId: string; address: number; length: number; kind: string }) =>
    postJson<unknown>("/api/segment/confirm", payload),
  rejectSegment: (payload: { projectDir: string; artifactId: string; address: number; length: number; kind: string; reason: string }) =>
    postJson<unknown>("/api/segment/reject", payload),
  traces: () => getJson<{ projectDir: string; tracesDir: string; count: number; traces: TraceArtifact[] }>("/api/traces"),
  traceInfo: (tracePath: string) => getJson<TraceInfo>(`/api/trace/info?path=${encodeURIComponent(tracePath)}`),
  traceTopPcs: (tracePath: string, cpu: "c64" | "drive8" = "c64", limit = 20) =>
    getJson<{ path: string; cpu: string; pcs: PcCount[] }>(`/api/trace/top-pcs?path=${encodeURIComponent(tracePath)}&cpu=${cpu}&limit=${limit}`),
  traceEvents: (tracePath: string, runId: string, opts: { family?: string; limit?: number; pcStart?: number; pcEnd?: number; cycleStart?: number; cycleEnd?: number; addrStart?: number; addrEnd?: number } = {}) => {
    const p = new URLSearchParams();
    p.set("path", tracePath); p.set("run_id", runId);
    p.set("family", opts.family ?? "cpu_step"); p.set("limit", String(opts.limit ?? 200));
    if (opts.pcStart !== undefined && opts.pcEnd !== undefined) { p.set("pc_start", String(opts.pcStart)); p.set("pc_end", String(opts.pcEnd)); }
    if (opts.cycleStart !== undefined && opts.cycleEnd !== undefined) { p.set("cycle_start", String(opts.cycleStart)); p.set("cycle_end", String(opts.cycleEnd)); }
    if (opts.addrStart !== undefined && opts.addrEnd !== undefined) { p.set("addr_start", String(opts.addrStart)); p.set("addr_end", String(opts.addrEnd)); }
    return getJson<{ path: string; runId: string; family: string; count: number; rows: TraceEventRow[] }>(`/api/trace/events?${p.toString()}`);
  },
};
