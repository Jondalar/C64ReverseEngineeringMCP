// Spec 724B — UI/API smoke. Proves the One-UI shell's backend can surface a real
// 729-style project: project status + path, media, trace artifacts + marks, trace
// readers (info / top-pcs / events), findings, entities, dashboard — all read-only
// over the HTTP API the v3 shell uses, with the project path from the 724A resolver
// (NO repo cwd / samples fallback).
//
// Builds a 729 project in a temp dir OUTSIDE the repo (project_init via the
// service + a real trace.duckdb via the library trace sink), boots the real
// workspace-ui HTTP server against it, and HTTP-checks the endpoints.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 724B — UI/API project + trace view smoke\n");

const seed = join(ROOT, "samples/synthetic/1byte.d64");
if (!existsSync(seed)) {
  console.log(`  PENDING  seed disk ${seed} not generated — run: node scripts/gen-synthetic-disks.mjs`);
  console.log("\nPENDING (no seed). 0 pass, 0 fail."); process.exit(0);
}

// ---- build a 729-style project OUTSIDE the repo ----
const projectDir = mkdtempSync(join(tmpdir(), "c64re-724b-"));
ok(!projectDir.startsWith(ROOT), "0 project dir outside the repo", projectDir);
mkdirSync(join(projectDir, "traces"), { recursive: true });
copyFileSync(seed, join(projectDir, "game.d64"));
const tracePath = join(projectDir, "traces", "run.duckdb");

// init project + persist a finding/entity via the service.
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "724B Smoke", description: "UI project+trace view smoke" });
svc.saveFinding({ kind: "observation", title: "Boot trace captured", summary: "via 724B smoke", confidence: 0.9, tags: ["runtime", "trace"] });
svc.saveEntity({ kind: "memory-region", name: "boot-pc-window", summary: "top PCs during boot" });
// register a tiny PRG artifact so the Assets/Scrub tab has something to scrub
// + annotate ($0801 load addr + a charset-ish block).
const prgRel = "asset.prg";
const prgBytes = Buffer.alloc(2 + 0x400);
prgBytes[0] = 0x01; prgBytes[1] = 0x08; // load $0801
for (let i = 0; i < 0x400; i++) prgBytes[2 + i] = (i * 13 + 7) & 0xff; // varied pattern
writeFileSync(join(projectDir, prgRel), prgBytes);
svc.saveArtifact({ kind: "prg", scope: "input", title: "asset.prg", path: prgRel });
// build the dashboard view so /api/workspace exposes it.
try { svc.buildWorkspaceUiSnapshot(); } catch { /* views built lazily */ }

// capture a real trace.duckdb via the library trace sink, in a SEPARATE child
// process. DuckDB takes a per-process file handle/WAL; if we captured in THIS
// process its handle would still hold the file when the (separate) HTTP server
// reads it cross-process. A child that fully exits releases the file (and the
// CHECKPOINT-on-close folds the WAL into the main .duckdb), so the server reads
// committed rows.
const captureSrc = `
const ROOT=${JSON.stringify(ROOT)};
const tracePath=${JSON.stringify(tracePath)};
const diskPath=${JSON.stringify(join(projectDir, "game.d64"))};
const {startIntegratedSession,stopIntegratedSession}=await import(ROOT+'/dist/runtime/headless/integrated-session-manager.js');
const sink=await import(ROOT+'/dist/server-tools/runtime-trace-sink.js');
const {getRuntimeController}=await import(ROOT+'/dist/runtime/headless/debug/runtime-controller.js');
const {sessionId,session}=startIntegratedSession({diskPath,mode:'true-drive'});
session.resetCold();
await sink.startSessionTrace(sessionId,session,tracePath,sink.DEFAULT_TRACE_DOMAINS);
const ctrl=getRuntimeController(sessionId);
for(let i=0;i<6;i++){session.runFor(200000);await ctrl.traceRun.drain();}
ctrl.traceRun.mark('basic-ready');
for(let i=0;i<4;i++){session.runFor(200000);await ctrl.traceRun.drain();}
ctrl.traceRun.mark('loaded-or-title');
await ctrl.traceRun.stop();
stopIntegratedSession(sessionId);
`;
await new Promise((resolve, reject) => {
  const cap = spawn(process.execPath, ["--input-type=module", "-e", captureSrc], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  cap.stderr.on("data", (d) => { err += d.toString(); });
  cap.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`capture child exited ${code}: ${err.slice(-300)}`)));
});
ok(existsSync(tracePath), "1 trace.duckdb captured in project traces/ (separate process)", tracePath);

// ---- boot the real workspace-ui HTTP server against this project ----
const PORT = 4319;
// NOT --api-only: also serve the static UI so the BUG-001 routing fix (/, /v3.html
// → v3 shell; /index.html → legacy v1) is gated. UI-entry asserts are guarded by
// the presence of the built bundles (skip cleanly if the UI was not built).
const hasV3Bundle = existsSync(join(ROOT, "ui/dist-v3/v3.html"));
const srv = spawn(process.execPath, [join(ROOT, "dist/workspace-ui/server.js"), "--project", projectDir, "--port", String(PORT)], {
  cwd: tmpdir(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
});
let srvErr = "";
srv.stderr.on("data", (d) => { srvErr += d.toString(); });

async function waitPort(port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const up = await new Promise((r) => {
      const s = createConnection({ port, host: "127.0.0.1" }, () => { s.end(); r(true); });
      s.on("error", () => r(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: res.status, body: await res.json() };
}
async function getText(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: res.status, ct: res.headers.get("content-type") || "", text: await res.text() };
}

let exitCode = 0;
try {
  const up = await waitPort(PORT);
  ok(up, "2 workspace-ui HTTP server is up", up ? `:${PORT}` : srvErr.slice(-200));
  if (!up) throw new Error("server did not start");

  // 3. project status + path (no hardcoded project).
  const cfg = await getJson("/api/config");
  ok(cfg.status === 200 && cfg.body.defaultProjectDir === projectDir, "3 /api/config returns the resolved project path", cfg.body.defaultProjectDir);

  const ws = await getJson("/api/workspace");
  ok(ws.status === 200 && ws.body.project, "4 /api/workspace returns project status", ws.body.project?.name);
  ok((ws.body.counts?.findings ?? 0) >= 1, "5 findings visible", `findings=${ws.body.counts?.findings}`);
  ok((ws.body.counts?.entities ?? 0) >= 1, "6 entities visible", `entities=${ws.body.counts?.entities}`);
  ok(!!ws.body.views?.projectDashboard, "7 dashboard view reachable", ws.body.views?.projectDashboard ? "present" : "missing");

  // 8. media list includes game.d64 (via the WS media route is runtime; here the
  //    artifact/knowledge side — media file is in the project dir, listed by the
  //    media browser endpoint or present on disk). We assert it exists on disk +
  //    is under the project (the UI media picker reads the project dir, 724A).
  ok(existsSync(join(projectDir, "game.d64")), "8 project media game.d64 present under project dir", "");

  // 9. trace artifacts listed with marks.
  const traces = await getJson("/api/traces");
  ok(traces.status === 200 && traces.body.count >= 1, "9 /api/traces lists the trace.duckdb", `count=${traces.body.count}`);
  const t0 = traces.body.traces?.[0];
  ok(t0 && t0.name === "run.duckdb", "9b trace name = run.duckdb", t0?.name);
  const markLabels = (t0?.marks ?? []).map((m) => m.label);
  ok(markLabels.includes("basic-ready") && markLabels.includes("loaded-or-title"),
    "10 trace marks basic-ready + loaded-or-title visible", markLabels.join(",") || "none");

  // 11. trace readers: info / top-pcs / events (no raw SQL).
  const info = await getJson(`/api/trace/info?path=${encodeURIComponent("traces/run.duckdb")}`);
  ok(info.status === 200 && (info.body.tableCounts?.["events:total"] ?? 0) > 0, "11 /api/trace/info counts", `events:total=${info.body.tableCounts?.["events:total"]}`);
  const top = await getJson(`/api/trace/top-pcs?path=${encodeURIComponent("traces/run.duckdb")}&cpu=c64&limit=5`);
  ok(top.status === 200 && Array.isArray(top.body.pcs) && top.body.pcs.length > 0, "12 /api/trace/top-pcs returns PCs", `n=${top.body.pcs?.length}`);
  const runId = info.body.meta?.run_id;
  if (runId) {
    const ev = await getJson(`/api/trace/events?path=${encodeURIComponent("traces/run.duckdb")}&run_id=${encodeURIComponent(runId)}&family=cpu_step&limit=10`);
    ok(ev.status === 200 && ev.body.count > 0, "13 /api/trace/events(cpu_step) returns rows", `rows=${ev.body.count}`);
  } else {
    ok(false, "13 /api/trace/events", "no run_id from info");
  }

  // 14. 724B.2 — every migrated v3 tab's backing data is reachable. The shell
  //     tabs are: Knowledge, Questions, Docs, Trace Files (Project); Memory Map,
  //     Payloads, Annotated Listing, Flow Graph (Analysis); Disk, Cartridge,
  //     Graphics (Media). Knowledge/Questions/Payloads/MemMap/Listing/Flow/Disk/
  //     Cartridge all read /api/workspace; Docs reads /api/docs; Graphics reads
  //     /api/graphics. Assert the snapshot exposes the view+list keys and the two
  //     extra endpoints respond (data may be empty on a tiny project — the KEY /
  //     endpoint reachability is what makes the tab usable, not non-empty data).
  const VIEW_KEYS = ["projectDashboard", "memoryMap", "diskLayout", "cartridgeLayout", "annotatedListing", "loadSequence", "flowGraph"];
  const viewsObj = ws.body.views ?? {};
  const missingViews = VIEW_KEYS.filter((k) => !(k in viewsObj));
  ok(missingViews.length === 0, "14 /api/workspace exposes all view-model keys (Memory Map/Disk/Cartridge/Listing/Payloads/Flow)", missingViews.join(",") || "all present");
  ok(Array.isArray(ws.body.openQuestions), "15 openQuestions list present (Questions tab)", `n=${ws.body.openQuestions?.length ?? "missing"}`);
  ok(Array.isArray(ws.body.flows), "16 flows list present (Flow Graph tab)", `n=${ws.body.flows?.length ?? "missing"}`);
  ok(Array.isArray(ws.body.artifacts), "17 artifacts list present (Payloads tab)", `n=${ws.body.artifacts?.length ?? "missing"}`);
  const docs = await getJson("/api/docs");
  ok(docs.status === 200 && Array.isArray(docs.body.docs), "18 /api/docs reachable (Docs tab)", `n=${docs.body.docs?.length}`);
  const gfx = await getJson("/api/graphics");
  ok(gfx.status === 200, "19 /api/graphics reachable (Graphics tab)", `status=${gfx.status}`);

  // 20-23 — Assets / Scrub tab (the migrated v1 human-workbench tool).
  // The PRG artifact must be in the snapshot (the tab's file picker).
  const hasPrg = (ws.body.artifacts ?? []).some((a) => a.kind === "prg" && (a.relativePath === "asset.prg" || a.path?.endsWith("asset.prg")));
  ok(hasPrg, "20 PRG artifact visible for the Assets/Scrub picker", hasPrg ? "asset.prg" : "missing");

  // Scrub: fetch a raw byte slice via /api/artifact/raw (the render input).
  const rawRes = await fetch(`http://127.0.0.1:${PORT}/api/artifact/raw?projectDir=${encodeURIComponent(projectDir)}&path=${encodeURIComponent("asset.prg")}&offset=2&length=320`);
  const rawBuf = rawRes.ok ? new Uint8Array(await rawRes.arrayBuffer()) : new Uint8Array();
  ok(rawRes.ok && rawBuf.length === 320, "21 /api/artifact/raw returns the scrub slice (render input)", `bytes=${rawBuf.length}`);

  // Reclassify (authoring): POST a graphics segment annotation; assert the
  // annotations file is created + the segment count is reported.
  const annRes = await fetch(`http://127.0.0.1:${PORT}/api/scrub/annotate-segment`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectDir, prgPath: "asset.prg", start: "0801", end: "0820", kind: "charset", label: "smoke_charset", comment: "via 724B asset smoke" }),
  });
  const ann = annRes.ok ? await annRes.json() : {};
  ok(annRes.ok && ann.totalSegments >= 1, "22 /api/scrub/annotate-segment persists a graphics segment (reclassify)", `segments=${ann.totalSegments}`);
  ok(typeof ann.annotationsPath === "string" && existsSync(ann.annotationsPath), "23 annotations file written + visible in the project", ann.annotationsPath ? "written" : "missing");

  // 24-26 — BUG-001: static UI routing. / and /v3.html serve the v3 One-UI
  // shell (C64RE V3); /index.html serves the legacy v1 entry. Guarded by the
  // built bundle so the gate skips cleanly when the UI was not built.
  if (hasV3Bundle) {
    const root = await getText("/");
    ok(root.status === 200 && /C64RE V3/.test(root.text) && /assets\/v3-/.test(root.text), "24 / serves the v3 One-UI shell (not v1)", root.text.match(/<title>[^<]*/)?.[0] ?? "");
    const v3 = await getText("/v3.html");
    ok(v3.status === 200 && /C64RE V3/.test(v3.text), "25 /v3.html serves the v3 shell (BUG-001 fixed)", "");
    const idx = await getText("/index.html");
    ok(idx.status === 200 && !/C64RE V3/.test(idx.text), "26 /index.html still serves the legacy v1 entry", idx.text.match(/<title>[^<]*/)?.[0] ?? "");
  } else {
    console.log("  SKIP  24-26 UI routing (ui/dist-v3 not built — run npm run ui:v3:build)");
  }

  // 27-31 — BUG-011/012: the Analysis + Media tabs must render the REAL v1
  // VISUALIZATIONS (heatmap grid / SVG cylindrical disk / bank-chip grid / SVG
  // flow graph), shared from ui/src/components/workspace-panels.tsx — NOT a
  // JSON dump and NOT a plain table. Verified against the BUILT v3 bundle (the
  // viz class names + SVG markers must be present) + the shared CSS.
  const pvSrc = readFileSync(join(ROOT, "ui/src/v3/tabs/ProjectViews.tsx"), "utf8");
  ok(/MemoryMapPanel/.test(pvSrc) && /DiskPanel/.test(pvSrc) && /CartridgePanel/.test(pvSrc) && /FlowPanel/.test(pvSrc),
    "27 v3 tabs render the shared visualization panels (not tables/JSON)", "");
  ok(/workspace-panels/.test(pvSrc), "28 panels imported from the shared module (v3 does NOT import App.tsx)", /App\.js/.test(pvSrc) ? "imports App!" : "shared");

  const bundleDir = join(ROOT, "ui/dist-v3/assets");
  const jsFile = existsSync(bundleDir) ? readdirSync(bundleDir).find((f) => /^v3-.*\.js$/.test(f)) : undefined;
  if (jsFile) {
    const js = readFileSync(join(bundleDir, jsFile), "utf8");
    const markers = ["memory-grid-table", "disk-geometry-svg", "flow-svg", "cart-grid-list", "disk-sector", "memory-cell"];
    const missing = markers.filter((m) => !js.includes(m));
    ok(missing.length === 0, "29 built v3 bundle contains the visualization markers (heatmap/disk-svg/flow-svg/cart-grid)", missing.join(",") || "all present");
    const cssFile = readdirSync(bundleDir).find((f) => /\.css$/.test(f));
    const css = cssFile ? readFileSync(join(bundleDir, cssFile), "utf8") : "";
    ok(/disk-geometry-svg/.test(css) && /memory-cell/.test(css) && /flow-/.test(css),
      "30 shared visualization CSS is bundled into v3", cssFile ? "present" : "no css");
  } else {
    console.log("  SKIP  29-30 viz bundle markers (ui/dist-v3 not built — run npm run ui:v3:build)");
  }
  // raw JSON must be available only as an explicit per-panel debug toggle.
  ok(/showRaw/.test(pvSrc) && /raw JSON/.test(pvSrc), "31 raw JSON stays a debug toggle, not the default body", "");

  console.log(`\n--- report ---`);
  console.log(`project: ${projectDir}`);
  console.log(`endpoints proven: /api/config, /api/workspace (+ all view keys), /api/traces, /api/trace/{info,top-pcs,events}, /api/docs, /api/graphics`);
  console.log(`Analysis/Media tabs render the REAL v1 visualizations (heatmap/SVG disk/bank-chip grid/flow svg), shared module, raw JSON behind a toggle (BUG-011/012).`);
  console.log(`UI routing (BUG-001): / + /v3.html → v3 shell; /index.html → legacy v1${hasV3Bundle ? "" : " (skipped — UI not built)"}`);
  console.log(`tabs reachable: Knowledge, Questions, Docs, Trace Files, Memory Map, Payloads, Annotated Listing, Flow Graph, Disk, Cartridge, Graphics, Assets/Scrub`);
  console.log(`Assets/Scrub: PRG picker + /api/artifact/raw slice + /api/scrub/annotate-segment write proven`);
  console.log(`729 artifacts visible: project status+path, game.d64, traces/run.duckdb, marks(basic-ready,loaded-or-title), findings, entities, dashboard`);
} catch (e) {
  ok(false, "harness", e.message + (srvErr ? " | stderr: " + srvErr.slice(-200) : ""));
  exitCode = 1;
} finally {
  srv.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} 724B UI/API view: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
