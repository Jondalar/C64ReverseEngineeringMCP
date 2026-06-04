// Spec 724B (final) — ONE product UI = the v1 workbench (functional source of
// truth) restyled v3 + with a Live runtime tab. Proves the routing + composition
// contract WITHOUT a browser:
//   - / and /index.html serve the v1 product bundle (one product UI, no second).
//   - /v3.html is retired -> 404 (one UI, no second entry, Spec 757).
//   - the v1 bundle embeds the Live tab (wb-live) AND keeps the core v1 tabs +
//     the central Inspector + the real visualizations (no no-op core, no raw JSON).
//   - the scoped Live CSS is bundled and carries NO v3 global resets.
//   - the runtime backend dependency is actionable + a Live session exists.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 724B (final) — product UI = v1 workbench + Live tab\n");

// ---- static bundle assertions ----
const v1Dist = join(ROOT, "ui/dist/assets");
if (!existsSync(v1Dist)) { console.log("  PENDING  ui/dist not built — run npm run ui:build"); console.log("\nPENDING."); process.exit(0); }
const jsName = readdirSync(v1Dist).find((f) => /^index-.*\.js$/.test(f));
const cssName = readdirSync(v1Dist).find((f) => /^index-.*\.css$/.test(f));
const v1Js = readFileSync(join(v1Dist, jsName), "utf8");
const v1Css = readFileSync(join(v1Dist, cssName), "utf8");
const inBundle = (m) => v1Js.includes(m) || v1Css.includes(m);

// 1. core workbench tabs + Inspector + visualizations survive (functional base intact).
const core = ["tab-strip", "workspace-main", "workspace-side", "app-main-grid", "inspector-card", "memory-cell", "disk-geometry-svg", "flow-svg"];
const missing = core.filter((c) => !inBundle(c));
ok(missing.length === 0, "1 v1 product bundle keeps workbench tabs + Inspector + visualizations", missing.join(",") || "all present");

// 2. Live tab embedded.
ok(inBundle("wb-live"), "2 Live runtime tab embedded in the product bundle (wb-live)", "");

// 3. scoped Live CSS bundled.
ok(v1Css.includes(".wb-live"), "3 scoped Live CSS bundled into the product UI", "");

// 4. the scoped Live CSS source carries no v3 global resets.
const liveCss = readFileSync(join(ROOT, "ui/src/components/live-runtime.css"), "utf8");
const leak = /(^|\n)\s*(body|html|\*)\s*[,{]/.test(liveCss) || /[,\s]#root\s*[,{]/.test(liveCss);
ok(!leak, "4 scoped Live CSS has NO v3 global resets (body/*/#root)", leak ? "LEAK" : "clean");

// 4b. BUG-016 / Live layout — the Live cockpit is bound to the viewport so the
// C64 screen fills the available area while the Monitor stays visible (no full
// page scroll). The bundle must carry the `.app-root.live-mode` viewport bind.
const liveModeRule = v1Css.match(/\.app-root\.live-mode\{[^}]*\}/)?.[0] ?? "";
ok(/height:100vh/.test(liveModeRule) && /overflow:hidden/.test(liveModeRule) && /flex/.test(liveModeRule),
  "4b BUG-016: Live tab binds the cockpit to the viewport (.app-root.live-mode)", liveModeRule ? "bound" : "rule missing");

// ---- live routing assertions (boot the real workspace, HTTP+WS) ----
const PORT = 4326;
const projectDir = mkdtempSync(join(tmpdir(), "c64re-prod-"));
const srv = spawn("node", [join(ROOT, "scripts/workspace.mjs"), "--project", projectDir, "--port", String(PORT)],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (b) => log += b); srv.stderr.on("data", (b) => log += b);
const tcpUp = (port, ms = 800) => new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port }); const d = (v) => { try { s.destroy(); } catch {} r(v); }; const t = setTimeout(() => d(false), ms); s.once("connect", () => { clearTimeout(t); d(true); }); s.once("error", () => { clearTimeout(t); d(false); }); });
const waitTcp = async (port, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
const text = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, body: await r.text() }; };
const json = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, body: await r.json() }; };

try {
  ok(await waitTcp(PORT), "5 workspace HTTP up", `:${PORT}`);
  const wsUp = await waitTcp(4312);
  ok(wsUp, "6 runtime WS backend up (Live tab can get a session/frame)", wsUp ? ":4312" : log.slice(-160));

  const root = await text("/");
  ok(root.status === 200 && /C64RE Workbench/.test(root.body) && /assets\/index-/.test(root.body),
    "7 / serves the v1 product UI (C64RE Workbench)", root.body.match(/<title>[^<]*/)?.[0] ?? "");
  ok(!/C64RE V3<\/title>/.test(root.body), "7b / is NOT the v3 shell", "");

  const idx = await text("/index.html");
  ok(idx.status === 200 && /C64RE Workbench/.test(idx.body), "8 /index.html = SAME product UI (no second UI)", "");

  // Spec 757 — ONE UI: the standalone /v3.html entry is retired → 404.
  const v3 = await text("/v3.html");
  ok(v3.status === 404, "9 /v3.html is gone (ONE UI — no second entry)", `status=${v3.status}`);

  const rs = await json("/api/runtime-status");
  ok(rs.status === 200 && rs.body.reachable === true, "10 /api/runtime-status reachable", `reachable=${rs.body.reachable}`);

  const WebSocket = (await import("ws")).default;
  const sessions = await new Promise((resolve, reject) => {
    const w = new WebSocket("ws://127.0.0.1:4312"); const id = 1;
    const t = setTimeout(() => { try { w.close(); } catch {} reject(new Error("ws timeout")); }, 8000);
    w.on("open", () => w.send(JSON.stringify({ jsonrpc: "2.0", id, method: "session/list", params: {} })));
    w.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id === id) { clearTimeout(t); w.close(); resolve(m.result); } });
    w.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  ok(Array.isArray(sessions) && sessions.length > 0, "11 runtime WS has a live session for the Live tab", `sessions=${sessions?.length}`);

  // 12. the headless backend actually STREAMS frames — the Live tab paints
  // BIN_TYPE_VIC_FRAME (0x01) binary WS broadcasts. This is the user's concern
  // ("frame connected nicht zum Headless Backend"): prove a frame arrives.
  const sid = sessions?.[0]?.sessionId;
  const frame = await new Promise((resolve) => {
    const w = new WebSocket("ws://127.0.0.1:4312");
    let got = false;
    const done = (v) => { if (!got) { got = true; try { w.close(); } catch {} resolve(v); } };
    const t = setTimeout(() => done(null), 12000);
    w.on("open", () => w.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "debug/run", params: { session_id: sid, pacing: { mode: "pal" } } })));
    w.on("message", (d, isBinary) => {
      if (isBinary && d.length >= 5 && d[0] === 0x01) { clearTimeout(t); done({ bytes: d.length, w: d.readUInt16LE(5), h: d.readUInt16LE(7) }); }
    });
    w.on("error", () => { clearTimeout(t); done(null); });
  });
  ok(frame !== null, "12 headless backend STREAMS a VIC frame to the Live tab (debug/run → binary frame)", frame ? `${frame.w}x${frame.h}, ${frame.bytes}B` : "no frame in 12s");

  console.log(`\n--- report ---`);
  console.log(`product UI: / + /index.html = the workbench (C64RE Workbench) + embedded Live tab`);
  console.log(`routing: /v3.html → 404 (one UI, no second entry)`);
  console.log(`Live: scoped .wb-live CSS, WS :4312 reachable, session present`);
} catch (e) {
  ok(false, "harness", e.message + (log ? " | " + log.slice(-160) : ""));
} finally {
  try { srv.kill("SIGINT"); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  try { srv.kill("SIGKILL"); } catch {}
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} product-ui: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
