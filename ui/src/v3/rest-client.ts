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
  artifacts?: Array<{ id: string; title: string; kind: string; path?: string }>;
  views?: { projectDashboard?: unknown };
}

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

export const api = {
  config: () => getJson<ProjectConfig>("/api/config"),
  workspace: () => getJson<WorkspaceSnapshot>("/api/workspace"),
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
