import { createServer } from "node:http";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { resolveProjectDir } from "./resolve-project-dir.js";
import { persistInspectEvidence } from "./inspect-evidence-persist.js";
import { persistAssetJoin } from "./asset-join-persist.js";
import type { JoinKnowledge } from "../runtime/headless/inspect/asset-join-knowledge.js";
import type { FrozenInspectEvidence } from "../runtime/headless/inspect/vic-inspect-types.js";
import { auditProject, auditProjectCached } from "../project-knowledge/audit.js";
import { repairProject } from "../project-knowledge/repair.js";
import { runPayloadReverseWorkflow, runPrgReverseWorkflow } from "../lib/prg-workflow.js";
import { findUnimportedAnalysisArtifacts, scanRegistrationDelta } from "../lib/registration-delta.js";
import { buildGraphicsView } from "./graphics-view.js";
import { createDiskParser, extractFileFromChain, SECTORS_PER_TRACK, type DiskFileEntry } from "../disk/index.js";
import { ByteBoozerDepacker, RleDepacker, depackExomizerRaw, depackExomizerSfx } from "../compression-tools.js";
import { lykiaDecompress } from "../byteboozer-lykia-decoder.js";
import { writeFile as writeFileAsync, mkdtemp as mkdtempAsync, rm as rmAsync } from "node:fs/promises";
import { tmpdir } from "node:os";

interface UiMark {
  id: string;
  createdAt: string;
  projectDir: string;
  url: string;
  activeTab?: string;
  selectedEntityId?: string | null;
  selectedCartChunkKey?: string | null;
  selectedDiskFileKey?: string | null;
  selector?: string;
  componentPath?: string[];
  textContent?: string;
  note: string;
  status: "open" | "fixed";
}

function marksStorePath(projectDir: string): string {
  return join(projectDir, "session", "ui-marks.json");
}

function loadMarks(projectDir: string): UiMark[] {
  const path = marksStorePath(projectDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { marks?: UiMark[] };
    return parsed.marks ?? [];
  } catch {
    return [];
  }
}

function saveMarks(projectDir: string, marks: UiMark[]): void {
  const path = marksStorePath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), marks }, null, 2));
}

interface ServerOptions {
  port: number;
  projectDir: string;
  apiOnly: boolean;
}

interface ServerReply {
  status: number;
  body: string | Buffer;
  headers: Record<string, string>;
}

function parseArgs(argv: string[]): ServerOptions {
  // Spec 724.3: project dir via the ONE shared resolver — `--project` > env >
  // hard error. No cwd fallback (the workspace must be explicit about which
  // project it serves; usable outside the C64RE repo).
  const options: ServerOptions = {
    port: 4310,
    projectDir: resolveProjectDir(argv, process.env),
    apiOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port" && argv[index + 1]) {
      options.port = Number.parseInt(argv[index + 1]!, 10);
      index += 1;
      continue;
    }
    if (arg === "--project") {
      // consumed by resolveProjectDir; skip its value here.
      index += 1;
      continue;
    }
    if (arg === "--api-only") {
      options.apiOnly = true;
    }
  }

  return options;
}

function jsonResponse(status: number, payload: unknown): ServerReply {
  return {
    status,
    body: `${JSON.stringify(payload, null, 2)}\n`,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  };
}

function textResponse(status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): ServerReply {
  return {
    status,
    body,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  };
}

function send(res: import("node:http").ServerResponse, response: ServerReply): void {
  res.writeHead(response.status ?? 200, response.headers);
  res.end(response.body);
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function safeStaticPath(root: string, requestPath: string): string | undefined {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = resolve(root, `.${normalized}`);
  if (!fullPath.startsWith(root)) {
    return undefined;
  }
  return fullPath;
}

function safeProjectPath(root: string, requestPath: string): string | undefined {
  const normalized = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = resolve(root, normalized);
  if (!fullPath.startsWith(root)) {
    return undefined;
  }
  return fullPath;
}

interface MarkdownDocEntry {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  title?: string;
}

const DOC_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vscode",
  ".idea",
  "dist",
  "build",
  "ui",
  "tools",
  "pipeline",
  "session",
  "views",
]);

const DOC_SCAN_SKIP_RELATIVE = new Set([
  "analysis/runs",
  "analysis/extracted",
]);

const DOC_SCAN_MAX_DEPTH = 5;
const DOC_SCAN_MAX_FILES = 256;

function readMarkdownTitle(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines.slice(0, 40)) {
      const match = line.match(/^#\s+(.+?)\s*$/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function enumerateMarkdownDocs(root: string): MarkdownDocEntry[] {
  const results: MarkdownDocEntry[] = [];

  function walk(directory: string, depth: number): void {
    if (depth > DOC_SCAN_MAX_DEPTH) return;
    if (results.length >= DOC_SCAN_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= DOC_SCAN_MAX_FILES) return;
      const fullPath = join(directory, entry.name);
      const relPath = relative(root, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (DOC_SCAN_SKIP_DIRS.has(entry.name)) continue;
        if (DOC_SCAN_SKIP_RELATIVE.has(relPath)) continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".md") continue;
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      results.push({
        path: fullPath,
        relativePath: relPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        title: readMarkdownTitle(fullPath),
      });
    }
  }

  walk(root, 0);
  results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return results;
}

const options = parseArgs(process.argv.slice(2));
// Spec 757 — ONE UI. The product shell is `ui/dist` (built by `npm run ui:build`),
// served at `/` and `/index.html`. There is no second bundle and no `/v3.html`
// (the standalone v3 entry is retired).
//
// Resolve the UI dist from the SERVER MODULE location (dist/workspace-ui →
// repo root), not process.cwd(), so the UI is found regardless of the launch
// cwd (724A path-portability — the same cwd coupling fixed for media). Fall back
// to a cwd-relative `ui/` for the vite dev layout.
const repoRootFromModule = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function resolveUiDist(name: string): string {
  const fromModule = resolve(repoRootFromModule, "ui", name);
  if (existsSync(fromModule)) return fromModule;
  return resolve(process.cwd(), "ui", name);
}
const uiDistDir = resolveUiDist("dist");
const hasUiDist = existsSync(uiDistDir);

// BUG-010: the Live tab needs the Headless Runtime WS backend (default :4312).
// The HTTP server can't start it (separate process — `npm run workspace` brings
// up both), but it CAN tell the UI whether it is reachable, so the Live tab shows
// an actionable error instead of spinning on "connecting" forever.
const RUNTIME_WS_HOST = "127.0.0.1";
const RUNTIME_WS_PORT = Number(process.env.C64RE_WS_PORT ?? 4312);
function probeRuntimeWs(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: RUNTIME_WS_HOST, port: RUNTIME_WS_PORT });
    const done = (up: boolean) => { try { sock.destroy(); } catch { /* ignore */ } resolve(up); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); done(true); });
    sock.once("error", () => { clearTimeout(timer); done(false); });
  });
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/api/config") {
    send(res, jsonResponse(200, {
      defaultProjectDir: options.projectDir,
      apiOnly: options.apiOnly,
      hasUiDist,
      runtimeWsUrl: `ws://${RUNTIME_WS_HOST}:${RUNTIME_WS_PORT}`,
    }));
    return;
  }

  // BUG-010: report whether the runtime WS backend (Live tab) is up, so the UI
  // can show an actionable error ("runtime backend not running — start it with
  // npm run workspace") instead of an endless "connecting".
  if (requestUrl.pathname === "/api/runtime-status") {
    void probeRuntimeWs().then((up) => {
      send(res, jsonResponse(200, {
        wsUrl: `ws://${RUNTIME_WS_HOST}:${RUNTIME_WS_PORT}`,
        reachable: up,
        projectDir: options.projectDir,
        hint: up ? undefined : `Runtime backend not reachable on :${RUNTIME_WS_PORT}. Start the full workspace (HTTP + runtime) with: npm run workspace -- --project "${options.projectDir}"`,
      }));
    });
    return;
  }

  if (requestUrl.pathname === "/api/workspace") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;

    try {
      const service = new ProjectKnowledgeService(projectDir);
      const snapshot = service.buildWorkspaceUiSnapshot();
      send(res, jsonResponse(200, snapshot));
    } catch (error) {
      send(res, jsonResponse(500, {
        error: error instanceof Error ? error.message : String(error),
        projectDir,
      }));
    }
    return;
  }

  // Spec 724B — read-only trace artifact + reader endpoints for the One-UI shell.
  // These mirror the MCP convenience readers (queries.ts) for the browser: list
  // the project's trace.duckdb stores + their marks, and run the same
  // info / top-pcs / events readers. The UI never runs raw SQL by default and
  // never reaches the WS runtime for these — they are durable project evidence.
  // Project path comes from the 724A resolver (?projectDir= explicit, else the
  // server's resolved --project), never a silent cwd/samples fallback.
  if (requestUrl.pathname === "/api/traces") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    (async () => {
      try {
        const tracesDir = join(projectDir, "traces");
        const out: Array<{ name: string; path: string; sizeBytes: number; runId?: string; marks?: Array<{ label: string; cycle: number }>; events?: number; error?: string }> = [];
        if (existsSync(tracesDir)) {
          const q = await import("../runtime/trace-store/queries.js");
          for (const entry of readdirSync(tracesDir).sort()) {
            if (!entry.endsWith(".duckdb")) continue;
            const full = join(tracesDir, entry);
            const rec: typeof out[number] = { name: entry, path: full, sizeBytes: statSync(full).size };
            try {
              const info = await q.getInfo(full);
              rec.runId = info.meta.run_id;
              rec.events = Number(info.tableCounts["events:total"] ?? 0);
              const anchors = await q.listAnchors(full);
              rec.marks = anchors.map((a) => ({ label: a.name, cycle: Number(a.firstClock ?? 0) }));
            } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
            out.push(rec);
          }
        }
        send(res, jsonResponse(200, { projectDir, tracesDir, count: out.length, traces: out }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
      }
    })();
    return;
  }

  if (requestUrl.pathname === "/api/trace/info" || requestUrl.pathname === "/api/trace/top-pcs" || requestUrl.pathname === "/api/trace/events") {
    const tracePath = requestUrl.searchParams.get("path");
    (async () => {
      try {
        if (!tracePath) throw new Error("path (to a trace.duckdb) is required");
        // Resolve a project-relative path under the active project; absolute as-is.
        const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
          ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
          : options.projectDir;
        const abs = tracePath.startsWith("/") ? tracePath : resolve(projectDir, tracePath);
        if (!existsSync(abs)) throw new Error(`trace not found: ${abs}`);
        const q = await import("../runtime/trace-store/queries.js");
        if (requestUrl.pathname === "/api/trace/info") {
          const info = await q.getInfo(abs);
          send(res, jsonResponse(200, {
            path: abs, meta: info.meta,
            tableCounts: Object.fromEntries(Object.entries(info.tableCounts).map(([k, v]) => [k, Number(v)])),
            masterClockRange: info.masterClockRange
              ? { min: Number(info.masterClockRange.min), max: Number(info.masterClockRange.max) } : undefined,
          }));
        } else if (requestUrl.pathname === "/api/trace/top-pcs") {
          const cpu = requestUrl.searchParams.get("cpu") === "drive8" ? "drive8" : "c64";
          const limit = Math.max(1, Math.min(200, Number(requestUrl.searchParams.get("limit") ?? 20)));
          const pcs = await q.topPcs(abs, cpu, limit);
          send(res, jsonResponse(200, { path: abs, cpu, pcs }));
        } else {
          // events: map family→channel via the same backend the MCP tool uses.
          const runId = requestUrl.searchParams.get("run_id");
          const family = requestUrl.searchParams.get("family") ?? "cpu_step";
          if (!runId) throw new Error("run_id is required for /api/trace/events");
          const limit = Math.max(1, Math.min(5000, Number(requestUrl.searchParams.get("limit") ?? 200)));
          const { queryEvents } = await import("../runtime/headless/v2/query-events.js");
          const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
          const duckdb = await import("@duckdb/node-api");
          // Spec 746.x — READ_ONLY (was an exclusive default open): the workspace-ui
          // HTTP server is a SEPARATE process from the Runtime Daemon, so it cannot
          // reach the in-process index await; an exclusive open could collide with
          // the daemon's index worker. READ_ONLY takes no exclusive lock, and the
          // indexer's temp-file + atomic rename means this only ever opens a
          // complete, published store. (Reads a static artifact, never the live runtime.)
          const inst = await (duckdb as any).DuckDBInstance.create(abs, { access_mode: "READ_ONLY" });
          try {
            const conn = await inst.connect();
            const backend = new DuckDbQueryBackend(conn);
            const qy: any = { runId, family, limit };
            const cs = requestUrl.searchParams.get("cycle_start"), ce = requestUrl.searchParams.get("cycle_end");
            if (cs && ce) qy.cycleRange = [Number(cs), Number(ce)];
            const ps = requestUrl.searchParams.get("pc_start"), pe = requestUrl.searchParams.get("pc_end");
            if (ps && pe) qy.pcRange = [Number(ps), Number(pe)];
            const as = requestUrl.searchParams.get("addr_start"), ae = requestUrl.searchParams.get("addr_end");
            if (as && ae) qy.addrRange = [Number(as), Number(ae)];
            const rows = await queryEvents(backend, qy);
            send(res, jsonResponse(200, { path: abs, runId, family, count: rows.length, rows: rows.slice(0, limit) }));
          } finally { (inst as any).closeSync?.(); }
        }
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return;
  }

  // Spec 021 knowledge tabs: read-only stores for the new UI tabs.
  // Each endpoint reads the matching JSON store via the service layer
  // and returns `{ items, projectDir, count }`. The UI does its own
  // filtering and virtualisation.
  if (requestUrl.pathname === "/api/findings" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.listFindings();
      send(res, jsonResponse(200, { projectDir, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/entities" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.listEntities();
      send(res, jsonResponse(200, { projectDir, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/flows" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.listFlows();
      send(res, jsonResponse(200, { projectDir, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/relations" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.listRelations();
      send(res, jsonResponse(200, { projectDir, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  // Spec 025 lineage: read the V0..Vn chain for an artifact id.
  if (requestUrl.pathname === "/api/artifact/lineage" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const artifactId = requestUrl.searchParams.get("artifactId")?.trim();
    if (!artifactId) {
      send(res, jsonResponse(400, { error: "missing artifactId query param" }));
      return;
    }
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const chain = service.getLineage(artifactId);
      send(res, jsonResponse(200, { projectDir, artifactId, count: chain.length, items: chain }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  // Spec 025 R23 containers: list sub-entries for a parent artifact.
  if (requestUrl.pathname === "/api/containers" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const parentArtifactId = requestUrl.searchParams.get("parentArtifactId")?.trim() || undefined;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.listContainerEntries(parentArtifactId);
      send(res, jsonResponse(200, { projectDir, parentArtifactId, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  // Spec 022: per-artifact workflow status matrix.
  if (requestUrl.pathname === "/api/per-artifact-status" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const items = service.getPerArtifactStatus();
      send(res, jsonResponse(200, { projectDir, count: items.length, items }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  // Spec 051 Sprint 44: annotation draft endpoints.
  if (requestUrl.pathname === "/api/annotations/draft" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const draftPath = requestUrl.searchParams.get("path")?.trim();
    if (!draftPath) {
      send(res, jsonResponse(400, { error: "missing path query param" }));
      return;
    }
    try {
      const fullPath = resolve(projectDir, draftPath);
      if (!existsSync(fullPath)) {
        send(res, jsonResponse(404, { error: "draft not found", path: fullPath }));
        return;
      }
      const text = readFileSync(fullPath, "utf8");
      send(res, jsonResponse(200, { projectDir, path: draftPath, content: JSON.parse(text) }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/annotations/save" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; finalPath: string; payload: unknown };
        const projectDir = payload.projectDir ?? options.projectDir;
        const fullPath = resolve(projectDir, payload.finalPath);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          send(res, jsonResponse(404, { error: `target directory missing: ${dir}` }));
          return;
        }
        writeFileSync(fullPath, `${JSON.stringify(payload.payload, null, 2)}\n`, "utf8");
        send(res, jsonResponse(200, { projectDir, finalPath: fullPath, ok: true }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 053 / Bug 21: segment confirm / reject endpoints.
  if (requestUrl.pathname === "/api/segment/confirm" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; artifactId: string; address: number; length: number; kind: string; evidenceArtifactId?: string };
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const result = service.markSegmentConfirmed({
          artifactId: payload.artifactId,
          address: payload.address,
          length: payload.length,
          kind: payload.kind,
          evidenceArtifactId: payload.evidenceArtifactId,
        });
        if (!result) { send(res, jsonResponse(404, { error: "artifact not found" })); return; }
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/segment/reject" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; artifactId: string; address: number; length: number; kind: string; reason: string };
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const result = service.markSegmentRejected({
          artifactId: payload.artifactId,
          address: payload.address,
          length: payload.length,
          kind: payload.kind,
          reason: payload.reason,
        });
        if (!result) { send(res, jsonResponse(404, { error: "artifact not found" })); return; }
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 730 §7.2 — Inspector "Source / Versions" actions. The UI POSTs a
  // subject + artifact to pin the current best version (manual) or to demote a
  // version (stale/missing). Both persist in the ONE project knowledge store and
  // a later project_inventory_sync respects the manual current.
  if (requestUrl.pathname === "/api/artifact-version/set-current" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; subjectId: string; artifactId: string };
        if (!payload.subjectId || !payload.artifactId) { send(res, jsonResponse(400, { error: "subjectId and artifactId required" })); return; }
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const group = service.setCurrentArtifactVersion(payload.subjectId, payload.artifactId);
        send(res, jsonResponse(200, { group }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/artifact-version/mark-stale" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; subjectId: string; artifactId: string; status?: "stale" | "missing" };
        if (!payload.subjectId || !payload.artifactId) { send(res, jsonResponse(400, { error: "subjectId and artifactId required" })); return; }
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const group = service.markArtifactVersionStatus(payload.subjectId, payload.artifactId, payload.status ?? "stale");
        send(res, jsonResponse(200, { group }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 773 Loop 4 — the one controlled write for Onboarding goal capture. Persists
  // through the EXISTING project-profile contract (saveProjectProfile → save_project_profile),
  // no parallel store. Only whitelisted goal fields are accepted.
  if (requestUrl.pathname === "/api/project/profile" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          goalType?: string;
          mission?: string;
          strategy?: string;
          complexity?: string;
          workflow?: string;
          goals?: string[];
        };
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        // Whitelist the goal-capture fields; ignore anything else in the body.
        const patch: Record<string, unknown> = {};
        if (payload.goalType !== undefined) patch.goalType = payload.goalType;
        if (payload.mission !== undefined) patch.mission = payload.mission;
        if (payload.strategy !== undefined) patch.strategy = payload.strategy;
        if (payload.complexity !== undefined) patch.complexity = payload.complexity;
        if (payload.workflow !== undefined) patch.workflow = payload.workflow;
        if (payload.goals !== undefined) patch.goals = payload.goals;
        const profile = service.saveProjectProfile(patch as never);
        send(res, jsonResponse(200, { profile }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 710.3/710.5 — persist a frozen-VIC inspect evidence record into the
  // ONE project knowledge store (saveArtifact). The UI gets the FrozenInspectEvidence
  // from WS vic/inspect/promote and POSTs it here; the WS server never owns
  // ProjectKnowledgeService (Spec 710.3 architecture).
  if (requestUrl.pathname === "/api/vic-inspect-evidence" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; evidence: FrozenInspectEvidence; name?: string; notes?: string };
        if (!payload.evidence) { send(res, jsonResponse(400, { error: "evidence record required" })); return; }
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const artifact = persistInspectEvidence(service, projectDir, {
          evidence: payload.evidence, name: payload.name, notes: payload.notes,
        });
        send(res, jsonResponse(200, { artifact }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 721.J3 — persist a Visual-Origin Join knowledge result (chain nodes →
  // entities, edges → link_entities, summary → finding) into the ONE store. The
  // UI gets JoinKnowledge from WS vic/inspect/origin and POSTs it here; the WS
  // server never owns ProjectKnowledgeService (Spec 710.3 architecture).
  if (requestUrl.pathname === "/api/asset-join" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; knowledge: JoinKnowledge; artifactId?: string };
        if (!payload.knowledge?.relations) { send(res, jsonResponse(400, { error: "knowledge result required" })); return; }
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const result = persistAssetJoin(service, payload.knowledge, { artifactId: payload.artifactId });
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Bug 23 (Stage 2): clear a previously-set confirm/reject mark.
  if (requestUrl.pathname === "/api/segment/clear" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { projectDir?: string; artifactId: string; address: number; length: number; kind: string };
        const projectDir = payload.projectDir ?? options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const result = service.clearSegmentMark({
          artifactId: payload.artifactId,
          address: payload.address,
          length: payload.length,
          kind: payload.kind,
        });
        if (!result) { send(res, jsonResponse(404, { error: "artifact not found" })); return; }
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/audit" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const fresh = requestUrl.searchParams.get("fresh") === "1";
    try {
      if (fresh) {
        const audit = auditProject(projectDir, { includeFileScan: true });
        send(res, jsonResponse(200, { audit, cacheStatus: "fresh", cachedAt: new Date().toISOString() }));
      } else {
        const cached = auditProjectCached(projectDir, { includeFileScan: true });
        send(res, jsonResponse(200, cached));
      }
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/open-question/batch" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          ids: string[];
          patch: {
            status?: "open" | "researching" | "answered" | "invalidated" | "deferred";
            priority?: "low" | "medium" | "high" | "critical";
            answerSummary?: string;
            answeredByFindingId?: string;
          };
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!Array.isArray(payload.ids) || payload.ids.length === 0) {
          send(res, jsonResponse(400, { error: "ids must be a non-empty array." }));
          return;
        }
        const service = new ProjectKnowledgeService(projectDir);
        const errors: Array<{ id: string; error: string }> = [];
        const updated: string[] = [];
        for (const id of payload.ids) {
          const existing = service.listOpenQuestions().find((question) => question.id === id);
          if (!existing) {
            errors.push({ id, error: "not found" });
            continue;
          }
          try {
            service.saveOpenQuestion({
              id,
              kind: existing.kind,
              title: existing.title,
              description: existing.description,
              status: payload.patch.status ?? existing.status,
              priority: payload.patch.priority ?? existing.priority,
              confidence: existing.confidence,
              entityIds: existing.entityIds,
              artifactIds: existing.artifactIds,
              findingIds: existing.findingIds,
              answeredByFindingId: payload.patch.answeredByFindingId ?? existing.answeredByFindingId,
              answerSummary: payload.patch.answerSummary ?? existing.answerSummary,
            });
            updated.push(id);
          } catch (error) {
            errors.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        send(res, jsonResponse(200, { updated, errors }));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 061 / UX3: Bulk re-evaluate open questions via task queue.
  // Two-phase: (1) deterministic sweep (archive_phase1_noise +
  // sweepQuestionResolutions) scoped to selection's artifacts;
  // (2) creates one automation-kind task that the LLM agent picks up
  // via c64re_whats_next polling. Returns the task id + post-sweep
  // remaining-question count.
  if (requestUrl.pathname === "/api/tasks/bulk-revaluate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          questionIds: string[];
          priority?: "low" | "medium" | "high" | "critical";
          scopeArtifactIds?: string[];
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!Array.isArray(payload.questionIds) || payload.questionIds.length === 0) {
          send(res, jsonResponse(400, { error: "questionIds must be a non-empty array" }));
          return;
        }
        const service = new ProjectKnowledgeService(projectDir);
        const allQuestions = service.listOpenQuestions();
        const targetQuestions = allQuestions.filter((q) => payload.questionIds.includes(q.id));
        if (targetQuestions.length === 0) {
          send(res, jsonResponse(404, { error: "no matching open questions for given ids" }));
          return;
        }
        // Phase 1 (deterministic sweep): scope = union of selection's
        // linked artifacts, OR explicit scopeArtifactIds when given.
        const scopeArtifacts = (payload.scopeArtifactIds && payload.scopeArtifactIds.length > 0)
          ? payload.scopeArtifactIds
          : Array.from(new Set(targetQuestions.flatMap((q) => q.artifactIds)));
        const sweepCounts: Array<{ artifactId: string; archived: number; answered: number }> = [];
        let totalArchived = 0;
        let totalAnswered = 0;
        for (const aid of scopeArtifacts) {
          try {
            const r = service.runClosedLoopSweep({ artifactId: aid });
            sweepCounts.push({ artifactId: aid, archived: r.archivedScoped, answered: r.questionsAnsweredScoped });
            totalArchived += r.archivedScoped;
            totalAnswered += r.questionsAnsweredScoped;
          } catch {
            // soft fail per artifact
          }
        }
        // Phase 2: build the LLM task with the per-spec template.
        const remainingIds = service.listOpenQuestions()
          .filter((q) => payload.questionIds.includes(q.id) && (q.status === "open" || q.status === "researching"))
          .map((q) => q.id);
        const description = [
          `Bulk re-evaluation of ${payload.questionIds.length} open questions.`,
          ``,
          `Phase 1 (already executed by the deterministic sweep):`,
          `  - archive_phase1_noise(artifact_id=<scoped>) — ${totalArchived} findings archived`,
          `  - auto_resolve_questions(artifact_id=<scoped>) — ${totalAnswered} questions auto-answered`,
          `  Sweep ran across ${scopeArtifacts.length} artifact scope(s).`,
          `  After phase 1, ${remainingIds.length} questions remain open. Continue with phase 2.`,
          ``,
          `Phase 2 (your work):`,
          `  For each of these question IDs:`,
          `    [${remainingIds.join(", ")}]`,
          ``,
          `  1. list_open_questions(filter to id) and read its title +`,
          `     description + linked findings + linked artifacts.`,
          `  2. Read the relevant ASM section (read_artifact on the linked`,
          `     listing) + the linked annotations file (when present).`,
          `  3. Decide ONE outcome:`,
          `       - "answered" — covered by a finding / annotation; close it`,
          `         via save_open_question(status="answered",`,
          `                                answeredByFindingId=<finding-id>,`,
          `                                answerSummary="<one sentence>")`,
          `       - "invalidated" — was bullshit / hallucination;`,
          `         save_open_question(status="invalidated",`,
          `                            answerSummary="<why>")`,
          `       - "researching" — needs deeper analysis; save_open_question`,
          `         (status="researching") and append a brief next-step note`,
          `         to its description.`,
          `       - "still-open" — leave unchanged.`,
          ``,
          `  4. After all processed, call agent_record_step with the bilanz:`,
          `       "Bulk re-eval done: X answered, Y invalidated,`,
          `        Z researching, W still-open."`,
          `       Include the original task id in the step description so`,
          `       the UI can mark the task complete.`,
          ``,
          `Constraints:`,
          `  - Use only the four outcomes above. Do not change priority,`,
          `    tags, or other fields.`,
          `  - If a question's linked finding is itself ambiguous, prefer`,
          `    "researching" over guessing "answered".`,
          `  - If a question has no addressRange + no linked finding +`,
          `    no clear context, "invalidated" is appropriate.`,
        ].join("\n");
        const task = service.saveTask({
          kind: "bulk-revaluate",
          title: `Re-evaluate ${payload.questionIds.length} open questions`,
          description,
          status: "open",
          priority: payload.priority ?? "medium",
          questionIds: payload.questionIds,
          artifactIds: scopeArtifacts,
          producedByTool: "ui-bulk-revaluate",
          agentKind: "automation",
        });
        send(res, jsonResponse(200, {
          taskId: task.id,
          questionCount: payload.questionIds.length,
          phase1: { archived: totalArchived, answered: totalAnswered, sweepCounts },
          remainingForPhase2: remainingIds.length,
        }));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Spec 061 / UX3: Active bulk-revaluate tasks. Used by the UI to
  // poll for in-flight automation work + render the per-question
  // pending badge.
  if (requestUrl.pathname === "/api/tasks/active-bulk" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const allTasks = service.listTasks();
      const active = allTasks.filter((t) =>
        t.kind === "bulk-revaluate"
        && (t.status === "open" || t.status === "in_progress")
      );
      send(res, jsonResponse(200, {
        tasks: active.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          questionIds: t.questionIds,
          artifactIds: t.artifactIds,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/run-payload-workflow" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          payloadId: string;
          mode?: "quick" | "full";
          outputDir?: string;
          rebuildViews?: boolean;
          entryPoints?: string[];
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.payloadId?.trim()) {
          send(res, jsonResponse(400, { error: "Missing payloadId." }));
          return;
        }
        const result = await runPayloadReverseWorkflow({
          projectRoot: projectDir,
          payloadId: payload.payloadId,
          mode: payload.mode,
          outputDir: payload.outputDir,
          rebuildViews: payload.rebuildViews,
          entryPoints: payload.entryPoints,
        });
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/run-prg-workflow" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          prgPath: string;
          mode?: "quick" | "full";
          outputDir?: string;
          rebuildViews?: boolean;
          entryPoints?: string[];
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.prgPath?.trim()) {
          send(res, jsonResponse(400, { error: "Missing prgPath." }));
          return;
        }
        const result = await runPrgReverseWorkflow({
          projectRoot: projectDir,
          prgPath: payload.prgPath,
          mode: payload.mode,
          outputDir: payload.outputDir,
          rebuildViews: payload.rebuildViews,
          entryPoints: payload.entryPoints,
        });
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/repair" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          mode?: "dry-run" | "safe";
          operations?: Array<"merge-fragments" | "register-artifacts" | "import-analysis" | "import-manifest" | "build-views">;
          limit?: number;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        const result = repairProject(projectDir, {
          mode: payload.mode ?? "dry-run",
          operations: payload.operations,
          limit: payload.limit,
        });
        send(res, jsonResponse(200, result));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/scrub/annotate-segment" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          prgPath: string;
          start: string;
          end: string;
          kind: string;
          label?: string;
          comment?: string;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        const prgAbs = safeProjectPath(projectDir, payload.prgPath);
        if (!prgAbs || !existsSync(prgAbs)) {
          send(res, jsonResponse(404, { error: "PRG not found.", prgPath: payload.prgPath }));
          return;
        }
        const stem = prgAbs.replace(/\.[^.]+$/, "").replace(/^.*\//, "");
        const annotationsPath = join(dirname(prgAbs), `${stem}_annotations.json`);
        const existing: { version?: number; binary?: string; segments?: Array<{ start: string; end: string; kind: string; label?: string; comment?: string }>; labels?: unknown[]; routines?: unknown[] } = existsSync(annotationsPath)
          ? JSON.parse(readFileSync(annotationsPath, "utf8"))
          : { version: 1, binary: stem, segments: [], labels: [], routines: [] };
        existing.version = existing.version ?? 1;
        existing.binary = existing.binary ?? stem;
        existing.segments = existing.segments ?? [];
        existing.labels = existing.labels ?? [];
        existing.routines = existing.routines ?? [];
        const startHex = payload.start.toUpperCase().replace(/^\$/, "");
        const endHex = payload.end.toUpperCase().replace(/^\$/, "");
        const idx = existing.segments.findIndex((seg) => seg.start.toUpperCase() === startHex && seg.end.toUpperCase() === endHex);
        const entry = { start: startHex, end: endHex, kind: payload.kind, label: payload.label, comment: payload.comment };
        if (idx >= 0) existing.segments[idx] = entry;
        else existing.segments.push(entry);
        existing.segments.sort((left, right) => parseInt(left.start, 16) - parseInt(right.start, 16));
        writeFileSync(annotationsPath, JSON.stringify(existing, null, 2));
        send(res, jsonResponse(200, { annotationsPath, segment: entry, totalSegments: existing.segments.length }));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  // Bug 23 (Stage 2): /api/graphics-marks is now a thin compat shim.
  // The shadow store at session/graphics-marks.json is gone — the analysis
  // JSONs are the single source of truth. GET derives the marks map from
  // buildGraphicsView items so any client that still reads /api/graphics-marks
  // sees the live, agent-and-UI-merged state. POST routes to the same service
  // methods used by /api/segment/{confirm,reject,clear}.
  if (requestUrl.pathname === "/api/graphics-marks" && req.method === "GET") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const view = buildGraphicsView(projectDir, service);
      const marks: Record<string, { status: "rejected" | "confirmed"; note?: string }> = {};
      for (const item of view.items) {
        if (item.confirmed === true) {
          marks[item.id] = { status: "confirmed" };
        } else if (item.rejected === true) {
          marks[item.id] = { status: "rejected", note: item.rejectedReason };
        }
      }
      send(res, jsonResponse(200, { projectDir, marks }));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/graphics-marks" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          itemId: string;
          status: "rejected" | "confirmed" | "clear";
          note?: string;
          // Required for the service-routing path: the UI already has the
          // GraphicsItem locally and can pass these through.
          artifactId?: string;
          address?: number;
          length?: number;
          kind?: string;
          reason?: string;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.itemId) {
          send(res, jsonResponse(400, { error: "Missing itemId." }));
          return;
        }
        if (!payload.artifactId || typeof payload.address !== "number" || typeof payload.length !== "number" || !payload.kind) {
          send(res, jsonResponse(400, { error: "Missing artifactId/address/length/kind. /api/graphics-marks now routes to service methods (Bug 23 stage 2) and needs the full segment payload." }));
          return;
        }
        const service = new ProjectKnowledgeService(projectDir);
        if (payload.status === "confirmed") {
          service.markSegmentConfirmed({
            artifactId: payload.artifactId,
            address: payload.address,
            length: payload.length,
            kind: payload.kind,
          });
        } else if (payload.status === "rejected") {
          service.markSegmentRejected({
            artifactId: payload.artifactId,
            address: payload.address,
            length: payload.length,
            kind: payload.kind,
            reason: payload.reason ?? "User marked wrong via Graphics tab.",
          });
        } else {
          service.clearSegmentMark({
            artifactId: payload.artifactId,
            address: payload.address,
            length: payload.length,
            kind: payload.kind,
          });
        }
        // Re-derive the full marks map so the response shape matches GET.
        const view = buildGraphicsView(projectDir, service);
        const map: Record<string, { status: "rejected" | "confirmed"; note?: string }> = {};
        for (const item of view.items) {
          if (item.confirmed === true) {
            map[item.id] = { status: "confirmed" };
          } else if (item.rejected === true) {
            map[item.id] = { status: "rejected", note: item.rejectedReason };
          }
        }
        send(res, jsonResponse(200, { projectDir, marks: map }));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/graphics") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      send(res, jsonResponse(404, { error: "Project directory not found.", projectDir }));
      return;
    }
    try {
      const service = new ProjectKnowledgeService(projectDir);
      const view = buildGraphicsView(projectDir, service);
      send(res, jsonResponse(200, { projectDir, ...view }));
    } catch (error) {
      send(res, jsonResponse(500, {
        error: error instanceof Error ? error.message : String(error),
        projectDir,
      }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/docs") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      send(res, jsonResponse(404, { error: "Project directory not found.", projectDir }));
      return;
    }
    try {
      const docs = enumerateMarkdownDocs(projectDir);
      send(res, jsonResponse(200, { projectDir, docs }));
    } catch (error) {
      send(res, jsonResponse(500, {
        error: error instanceof Error ? error.message : String(error),
        projectDir,
      }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/task" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          title?: string;
          description?: string;
          kind?: string;
          priority?: "low" | "medium" | "high" | "critical";
          confidence?: number;
          entityIds?: string[];
          artifactIds?: string[];
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.title?.trim()) {
          send(res, jsonResponse(400, { error: "Missing task title." }));
          return;
        }
        const service = new ProjectKnowledgeService(projectDir);
        const task = service.saveTask({
          title: payload.title.trim(),
          description: payload.description?.trim() || undefined,
          kind: payload.kind?.trim() || "llm-followup",
          priority: payload.priority ?? "medium",
          confidence: payload.confidence ?? 0.75,
          entityIds: payload.entityIds ?? [],
          artifactIds: payload.artifactIds ?? [],
        });
        send(res, jsonResponse(200, { task }));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/open-question" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          id?: string;
          title?: string;
          description?: string;
          kind?: string;
          status?: "open" | "researching" | "answered" | "invalidated" | "deferred";
          priority?: "low" | "medium" | "high" | "critical";
          confidence?: number;
          entityIds?: string[];
          artifactIds?: string[];
          findingIds?: string[];
          answeredByFindingId?: string;
          answerSummary?: string;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        const service = new ProjectKnowledgeService(projectDir);
        const existing = payload.id
          ? service.listOpenQuestions().find((question) => question.id === payload.id)
          : undefined;
        if (!existing && !payload.title?.trim()) {
          send(res, jsonResponse(400, { error: "Missing question title." }));
          return;
        }
        const question = service.saveOpenQuestion({
          id: payload.id,
          title: payload.title?.trim() || existing?.title || "(untitled)",
          description: payload.description?.trim() ?? existing?.description,
          kind: payload.kind?.trim() || existing?.kind || "llm-question",
          status: payload.status ?? existing?.status,
          priority: payload.priority ?? existing?.priority ?? "medium",
          confidence: payload.confidence ?? existing?.confidence ?? 0.65,
          entityIds: payload.entityIds ?? existing?.entityIds ?? [],
          artifactIds: payload.artifactIds ?? existing?.artifactIds ?? [],
          findingIds: payload.findingIds ?? existing?.findingIds ?? [],
          answeredByFindingId: payload.answeredByFindingId ?? existing?.answeredByFindingId,
          answerSummary: payload.answerSummary ?? existing?.answerSummary,
        });
        send(res, jsonResponse(200, { question }));
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/document") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    if (!path) {
      send(res, jsonResponse(400, { error: "Missing path query parameter." }));
      return;
    }
    const filePath = safeProjectPath(projectDir, path);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      send(res, jsonResponse(404, { error: "Document not found.", path, projectDir }));
      return;
    }
    try {
      send(res, textResponse(200, readFileSync(filePath, "utf8"), "text/markdown; charset=utf-8"));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path, projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/artifact/raw") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    if (!path) {
      send(res, jsonResponse(400, { error: "Missing path query parameter." }));
      return;
    }
    const filePath = safeProjectPath(projectDir, path);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      send(res, jsonResponse(404, { error: "Artifact not found.", path, projectDir }));
      return;
    }
    try {
      const stat = statSync(filePath);
      const offsetParam = requestUrl.searchParams.get("offset");
      const lengthParam = requestUrl.searchParams.get("length");
      const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;
      const requested = lengthParam ? Math.max(0, Number.parseInt(lengthParam, 10) || 0) : stat.size - offset;
      if (offset > stat.size) {
        send(res, jsonResponse(416, { error: "Offset past end of file.", offset, size: stat.size }));
        return;
      }
      const length = Math.min(requested, stat.size - offset);
      const maxBytes = 8 * 1024 * 1024;
      if (length > maxBytes) {
        send(res, jsonResponse(413, { error: "Slice too large for hex view.", size: length, maxBytes }));
        return;
      }
      const fullBuffer = readFileSync(filePath);
      const buffer = (offset === 0 && length === fullBuffer.length) ? fullBuffer : fullBuffer.subarray(offset, offset + length);
      send(res, {
        status: 200,
        body: buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path, projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/depack" && req.method === "POST") {
    // Try a series of pure-TS depackers on the raw bytes the client
    // pushes and stream back whichever one succeeds. Order roughly by
    // how unambiguous the stream format is so we don't happily chew a
    // valid Exomizer wrapper with the RLE depacker.
    const forcePacker = requestUrl.searchParams.get("packer")?.trim() || undefined;
    const destHiParam = requestUrl.searchParams.get("destHi");
    const destHi = destHiParam !== null ? Math.max(0, Math.min(0xff, Number.parseInt(destHiParam, 10) || 0)) : undefined;
    const destAddrParam = requestUrl.searchParams.get("destAddress");
    const endAddrParam = requestUrl.searchParams.get("endAddress");
    const destAddress = destAddrParam !== null ? Math.max(0, Math.min(0xffff, Number.parseInt(destAddrParam, 10) || 0)) : undefined;
    const endAddress = endAddrParam !== null ? Math.max(0, Math.min(0xffff, Number.parseInt(endAddrParam, 10) || 0)) : undefined;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => { chunks.push(chunk); });
    req.on("end", async () => {
      const input = Buffer.concat(chunks);
      if (input.length === 0) {
        send(res, jsonResponse(400, { error: "Empty request body" }));
        return;
      }
      const candidates = forcePacker
        ? [forcePacker]
        : ["byteboozer-lykia", "exomizer_sfx", "exomizer_raw", "byteboozer", "rle"];
      const failures: Array<{ packer: string; error: string }> = [];
      for (const packer of candidates) {
        try {
          let out: Uint8Array | undefined;
          let loadAddress: number | undefined;
          if (packer === "exomizer_sfx") {
            let tempDir: string | undefined;
            try {
              tempDir = await mkdtempAsync(join(tmpdir(), "c64re-depack-"));
              const tempPath = join(tempDir, "input.prg");
              await writeFileAsync(tempPath, input);
              const result = await depackExomizerSfx({ inputPath: tempPath });
              out = result.data;
              loadAddress = result.loadAddress;
            } finally {
              if (tempDir) await rmAsync(tempDir, { recursive: true, force: true });
            }
          } else if (packer === "exomizer_raw") {
            let tempDir: string | undefined;
            try {
              tempDir = await mkdtempAsync(join(tmpdir(), "c64re-depack-"));
              const tempPath = join(tempDir, "input.bin");
              await writeFileAsync(tempPath, input);
              const result = await depackExomizerRaw({ inputPath: tempPath });
              out = result.data;
            } finally {
              if (tempDir) await rmAsync(tempDir, { recursive: true, force: true });
            }
          } else if (packer === "byteboozer") {
            const result = new ByteBoozerDepacker().unpack(input);
            out = result.data;
          } else if (packer === "byteboozer-lykia" || packer === "byteboozer_lykia") {
            // Lykia BB2 expects a 4-byte stream header
            // [destLo, destHi, endLo, endHi] before the bit stream and
            // seeds BB2_BITBUF with destHi. Disk-loader streams already
            // carry this header in their bytes; cart LUT chunks do not
            // (the dest+length live in the LUT entry). When the caller
            // hands us destAddress+endAddress, we synthesise the
            // header and prepend it. Otherwise we trust the input as a
            // header-prefixed stream.
            let stream: Uint8Array;
            let seedHi: number;
            if (destAddress !== undefined && endAddress !== undefined) {
              const hdr = new Uint8Array(4);
              hdr[0] = destAddress & 0xff;
              hdr[1] = (destAddress >> 8) & 0xff;
              hdr[2] = endAddress & 0xff;
              hdr[3] = (endAddress >> 8) & 0xff;
              stream = new Uint8Array(hdr.length + input.length);
              stream.set(hdr, 0);
              stream.set(new Uint8Array(input), hdr.length);
              seedHi = (destAddress >> 8) & 0xff;
            } else {
              stream = new Uint8Array(input);
              seedHi = destHi !== undefined ? destHi : (input.length >= 2 ? input[1]! : 0x40);
            }
            const result = lykiaDecompress(stream, seedHi);
            out = result.data;
            loadAddress = result.destAddress;
          } else if (packer === "rle") {
            const result = new RleDepacker().unpack(input, { hasHeader: input.length >= 2 && input[0] === 0 && input[1] === 0 });
            out = result.data;
          }
          if (!out || out.length === 0) throw new Error("depacker returned no bytes");
          const buffer = Buffer.from(out);
          send(res, {
            status: 200,
            body: buffer,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(buffer.length),
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
              "X-Depacker": packer,
              "X-Load-Address": loadAddress !== undefined ? `$${loadAddress.toString(16).toUpperCase().padStart(4, "0")}` : "",
            },
          });
          return;
        } catch (err) {
          failures.push({ packer, error: err instanceof Error ? err.message : String(err) });
        }
      }
      send(res, jsonResponse(422, {
        error: "No depacker matched the input stream.",
        attempts: failures,
        bytes: input.length,
      }));
    });
    return;
  }

  if (requestUrl.pathname === "/api/disk/assemble-chain" && req.method === "POST") {
    // Assemble a file's bytes by reading a caller-supplied list of
    // sector windows. Works for both standard KERNAL files (link bytes
    // at [0,1]) and custom-LUT files where the whole 256-byte sector is
    // raw data without link bytes. The client sends the exact chain it
    // wants to concatenate so the server never has to guess which
    // convention applies.
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          path?: string;
          chain?: Array<{ track: number; sector: number; offsetInSector?: number; length?: number }>;
          stripLoadAddress?: boolean;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.path || !Array.isArray(payload.chain) || payload.chain.length === 0) {
          send(res, jsonResponse(400, { error: "path and non-empty chain[] required" }));
          return;
        }
        const imagePath = safeProjectPath(projectDir, payload.path);
        if (!imagePath || !existsSync(imagePath)) {
          send(res, jsonResponse(404, { error: "Disk image not found", path: payload.path }));
          return;
        }
        const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
        if (!parser) {
          send(res, jsonResponse(415, { error: "Unrecognised disk image format", path: payload.path }));
          return;
        }
        const chunks: Uint8Array[] = [];
        for (const cell of payload.chain) {
          if (!Number.isInteger(cell.track) || cell.track < 1 || !Number.isInteger(cell.sector) || cell.sector < 0) continue;
          const data = parser.getSector(cell.track, cell.sector);
          if (!data) continue;
          const offset = Math.max(0, cell.offsetInSector ?? 0);
          const maxLength = data.length - offset;
          const length = Math.max(0, Math.min(cell.length ?? maxLength, maxLength));
          if (length > 0) chunks.push(data.subarray(offset, offset + length));
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        let output = new Uint8Array(total);
        let cursor = 0;
        for (const chunk of chunks) {
          output.set(chunk, cursor);
          cursor += chunk.length;
        }
        if (payload.stripLoadAddress && output.length >= 2) output = output.subarray(2);
        const buffer = Buffer.from(output);
        send(res, {
          status: 200,
          body: buffer,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buffer.length),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/disk/file-bytes") {
    // Extract a full file from a D64/G64 image by walking its sector
    // chain starting at the given track/sector. Used by the disk-file
    // hex view so the user sees the ASSEMBLED file, not just the first
    // physical sector.
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    const trackParam = requestUrl.searchParams.get("track");
    const sectorParam = requestUrl.searchParams.get("sector");
    const typeParam = requestUrl.searchParams.get("type") ?? "PRG";
    const stripLoadParam = requestUrl.searchParams.get("strip_load_address") === "1";
    if (!path || !trackParam || !sectorParam) {
      send(res, jsonResponse(400, { error: "Missing path/track/sector query parameters." }));
      return;
    }
    const track = Number.parseInt(trackParam, 10);
    const sector = Number.parseInt(sectorParam, 10);
    if (!Number.isInteger(track) || track < 1 || !Number.isInteger(sector) || sector < 0) {
      send(res, jsonResponse(400, { error: "Invalid track/sector." }));
      return;
    }
    const imagePath = safeProjectPath(projectDir, path);
    if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      send(res, jsonResponse(404, { error: "Disk image not found.", path, projectDir }));
      return;
    }
    try {
      const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
      if (!parser) {
        send(res, jsonResponse(415, { error: "Unrecognised disk image format.", path }));
        return;
      }
      const entry: DiskFileEntry = {
        name: `t${track}s${sector}`,
        type: (typeParam as DiskFileEntry["type"]) ?? "PRG",
        size: 0,
        track,
        sector,
      };
      const bytes = extractFileFromChain((t, s) => parser.getSector(t, s), entry, stripLoadParam);
      if (!bytes) {
        send(res, jsonResponse(404, { error: "File chain produced no bytes.", track, sector }));
        return;
      }
      const buffer = Buffer.from(bytes);
      send(res, {
        status: 200,
        body: buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/disk/sector-bytes") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    const trackParam = requestUrl.searchParams.get("track");
    const sectorParam = requestUrl.searchParams.get("sector");
    if (!path || !trackParam || !sectorParam) {
      send(res, jsonResponse(400, { error: "Missing path/track/sector query parameters." }));
      return;
    }
    const track = Number.parseInt(trackParam, 10);
    const sector = Number.parseInt(sectorParam, 10);
    if (!Number.isInteger(track) || track < 1 || !Number.isInteger(sector) || sector < 0) {
      send(res, jsonResponse(400, { error: "Invalid track/sector." }));
      return;
    }
    const imagePath = safeProjectPath(projectDir, path);
    if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      send(res, jsonResponse(404, { error: "Disk image not found.", path, projectDir }));
      return;
    }
    try {
      const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
      if (!parser) {
        send(res, jsonResponse(415, { error: "Unrecognised disk image format.", path }));
        return;
      }
      const bytes = parser.getSector(track, sector);
      if (!bytes) {
        send(res, jsonResponse(404, { error: "Sector not available.", track, sector, path }));
        return;
      }
      const buffer = Buffer.from(bytes);
      send(res, {
        status: 200,
        body: buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path }));
    }
    return;
  }

  // BUG-017 — whole-track read: every sector of a track concatenated (256 B each,
  // ascending sector order). Format-agnostic via the parser (D64 + G64). Missing
  // sectors are zero-filled so byte offsets stay aligned to sector*256. The
  // client builds per-sector separators from the fixed 256-byte stride.
  if (requestUrl.pathname === "/api/disk/track-bytes") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    const trackParam = requestUrl.searchParams.get("track");
    if (!path || !trackParam) {
      send(res, jsonResponse(400, { error: "Missing path/track query parameters." }));
      return;
    }
    const track = Number.parseInt(trackParam, 10);
    if (!Number.isInteger(track) || track < 1) {
      send(res, jsonResponse(400, { error: "Invalid track." }));
      return;
    }
    const imagePath = safeProjectPath(projectDir, path);
    if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      send(res, jsonResponse(404, { error: "Disk image not found.", path, projectDir }));
      return;
    }
    try {
      const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
      if (!parser) {
        send(res, jsonResponse(415, { error: "Unrecognised disk image format.", path }));
        return;
      }
      const sectorCount = SECTORS_PER_TRACK[track] ?? 17;
      const buffer = Buffer.alloc(sectorCount * 256); // zero-filled; missing sectors stay zero
      for (let sector = 0; sector < sectorCount; sector += 1) {
        const bytes = parser.getSector(track, sector);
        if (bytes) Buffer.from(bytes).copy(buffer, sector * 256);
      }
      send(res, {
        status: 200,
        body: buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
          "X-Sector-Count": String(sectorCount),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/marks") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (req.method === "GET") {
      const filter = requestUrl.searchParams.get("status");
      const all = loadMarks(projectDir);
      const marks = filter ? all.filter((mark) => mark.status === filter) : all;
      send(res, jsonResponse(200, { marks }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as Partial<UiMark>;
          const now = new Date().toISOString();
          const all = loadMarks(projectDir);
          const mark: UiMark = {
            id: payload.id ?? `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            createdAt: payload.createdAt ?? now,
            projectDir,
            url: payload.url ?? "",
            activeTab: payload.activeTab,
            selectedEntityId: payload.selectedEntityId ?? null,
            selectedCartChunkKey: payload.selectedCartChunkKey ?? null,
            selectedDiskFileKey: payload.selectedDiskFileKey ?? null,
            selector: payload.selector,
            componentPath: payload.componentPath,
            textContent: payload.textContent,
            note: payload.note ?? "",
            status: payload.status ?? "open",
          };
          all.push(mark);
          saveMarks(projectDir, all);
          send(res, jsonResponse(200, { mark }));
        } catch (error) {
          send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === "DELETE") {
      const id = requestUrl.searchParams.get("id");
      const filter = requestUrl.searchParams.get("status");
      const all = loadMarks(projectDir);
      let kept: UiMark[];
      if (id) {
        kept = all.filter((mark) => mark.id !== id);
      } else if (!filter || filter === "all") {
        kept = [];
      } else {
        kept = all.filter((mark) => mark.status !== filter);
      }
      saveMarks(projectDir, kept);
      send(res, jsonResponse(200, { cleared: all.length - kept.length, remaining: kept.length }));
      return;
    }
    send(res, jsonResponse(405, { error: "Method not allowed" }));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/marks/")) {
    const id = requestUrl.pathname.slice("/api/marks/".length);
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as Partial<UiMark>;
          const all = loadMarks(projectDir);
          const index = all.findIndex((mark) => mark.id === id);
          if (index < 0) {
            send(res, jsonResponse(404, { error: "Mark not found" }));
            return;
          }
          all[index] = { ...all[index]!, ...payload, id };
          saveMarks(projectDir, all);
          send(res, jsonResponse(200, { mark: all[index] }));
        } catch (error) {
          send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    send(res, jsonResponse(405, { error: "Method not allowed" }));
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    send(res, jsonResponse(200, { ok: true }));
    return;
  }

  if (requestUrl.pathname === "/api/registration-delta") {
    try {
      const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
        ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!.trim())
        : options.projectDir;
      const delta = scanRegistrationDelta(projectDir, 50);
      const service = new ProjectKnowledgeService(projectDir);
      const unimported = findUnimportedAnalysisArtifacts(service);
      send(res, jsonResponse(200, {
        ...delta,
        unimportedAnalysisCount: unimported.length,
        unimportedAnalysisExamples: unimported.slice(0, 10).map((u) => u.relativePath),
      }));
    } catch (e) {
      send(res, jsonResponse(500, { error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  if (options.apiOnly || !hasUiDist) {
    send(res, textResponse(404, "UI bundle not found. Run `npm run ui:build` first or start with Vite in dev mode.\n"));
    return;
  }

  // Spec 757 — ONE UI: the product shell `ui/dist` is served at `/` and
  // `/index.html`. There is no second bundle; the retired `/v3.html` (and any
  // other explicit `.html` entry that has no file) → 404. Non-`.html` unmatched
  // paths fall back to the SPA entry so client-side routes work.
  const wantsEntry = requestUrl.pathname === "/" || requestUrl.pathname === "/index.html";

  let filePath: string | undefined;
  if (wantsEntry && existsSync(uiDistDir)) {
    filePath = join(uiDistDir, "index.html");
  } else {
    const p = safeStaticPath(uiDistDir, requestUrl.pathname);
    if (p && existsSync(p) && statSync(p).isFile()) filePath = p;
    if (!filePath && !requestUrl.pathname.endsWith(".html")) {
      filePath = existsSync(uiDistDir) ? join(uiDistDir, "index.html") : undefined;
    }
  }

  if (!filePath || !existsSync(filePath)) {
    send(res, textResponse(404, "UI entry not found.\n"));
    return;
  }
  try {
    send(res, textResponse(200, readFileSync(filePath), mimeType(filePath)));
  } catch (error) {
    send(res, textResponse(500, `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`));
  }
});

server.listen(options.port, () => {
  console.log(`workspace-ui server listening on http://127.0.0.1:${options.port}`);
  console.log(`default project: ${options.projectDir}`);
  if (!hasUiDist || options.apiOnly) {
    console.log("serving API only");
  }
});
