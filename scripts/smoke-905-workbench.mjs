#!/usr/bin/env node
// The workbench half of anchors: the page's own anchor code (ui/src/workbench/anchors.ts, esbuild-bundled
// with the page's WsClient) against a real trx64-daemon of this run's own, beside an MCP session on the
// SAME daemon.
//
//   A  an anchor set over MCP is listed by the page's code on the next list, with cycle and frame — no reload
//   B  an anchor set by the page (on a selected frame; on the machine's present instant) is listed over MCP
//   C  go to an anchor from the page: the shared machine stands at its cycle, paused; the transport line
//      names the nearest anchor
//   D  drop from the page: gone over MCP; a refusal (a taken name) reaches the page as the runtime's text
//   E  the page's source: the filmstrip and the Trace tab use the anchor code, the dead listBookmarks
//      call and the bookmark panel are gone; the built bundle carries the controls
//
// Without a trx64-daemon binary A–D SKIP LOUDLY (E still runs). Never touches :4312.
//   C64RE_RUNTIME_BIN=<abs path> npm run smoke:905
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { prgWithStub } from "./lib/asm6502-mini.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d !== "" ? `  (${String(d).slice(0, 500)})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const SANDBOX = mkdtempSync(join(tmpdir(), "c64re-905ui-"));
const cleanups = [];
process.on("exit", () => { for (const f of cleanups.reverse()) { try { f(); } catch { /* gone */ } } try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ } });

const siblingExe = join(ROOT, "..", "TRX64", "target", "release", process.platform === "win32" ? "trx64-daemon.exe" : "trx64-daemon");
const DAEMON = process.env.C64RE_RUNTIME_BIN && !/\.m?js$/.test(process.env.C64RE_RUNTIME_BIN) ? process.env.C64RE_RUNTIME_BIN : existsSync(siblingExe) ? siblingExe : undefined;

if (!DAEMON) {
  console.log("SKIPPED A–D — no trx64-daemon binary (set C64RE_RUNTIME_BIN to an absolute path). Skipped, NOT passed.");
} else {
  const { build } = await import("esbuild");
  const out = await build({ entryPoints: [join(ROOT, "ui/src/workbench/anchors.ts")], bundle: true, format: "esm", platform: "node", write: false });
  const anchorsFile = join(SANDBOX, "anchors.mjs");
  writeFileSync(anchorsFile, out.outputFiles[0].text);
  const ws = await build({ entryPoints: [join(ROOT, "ui/src/workbench/ws-client.ts")], bundle: true, format: "esm", platform: "node", write: false });
  const wsFile = join(SANDBOX, "ws-client.mjs");
  writeFileSync(wsFile, ws.outputFiles[0].text);
  const A = await import(pathToFileURL(anchorsFile).href);
  const { WsClient } = await import(pathToFileURL(wsFile).href);

  const { ProjectKnowledgeService } = await import(pathToFileURL(join(ROOT, "dist/project-knowledge/service.js")).href);
  const proj = join(SANDBOX, "proj");
  mkdirSync(proj, { recursive: true });
  new ProjectKnowledgeService(proj).initProject({ name: "ui905" });
  writeFileSync(join(proj, "t.prg"), prgWithStub(["SEI", "loop:", "INC $C000", "JMP loop"]));
  const port = await freePort();
  const child = spawn(DAEMON, ["--project", proj, "--port", String(port)], { stdio: "ignore" });
  cleanups.push(() => child.kill("SIGTERM"));
  for (let i = 0; i < 80; i++) { try { await new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}/?av=0`); w.once("open", () => { w.close(); res(); }); w.once("error", rej); }); break; } catch { await sleep(250); } }

  const endpoint = `ws://127.0.0.1:${port}`;
  const mcp = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_STATE_DIR: join(SANDBOX, "state"), C64RE_RUNTIME_ENDPOINT: endpoint } });
  cleanups.push(() => mcp.stop());
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-905", version: "1" } });
  await mcp.call("agent_onboard", {});
  await mcp.call("runtime_session_start", {});
  await mcp.call("runtime_run_prg", { session_id: "shared", prg_path: join(proj, "t.prg"), run: "080d" });
  await mcp.call("runtime_session_run", { session_id: "shared", cycle_budget: 400000, max_instructions: 10000000 });

  const client = new WsClient(endpoint);
  client.connect();
  for (let i = 0; i < 100 && client.getState() !== "open"; i++) await sleep(50);
  const page = { call: (m, p) => client.call(m, p) };

  head("A  set over MCP, listed by the page");
  const set1 = await mcp.call("runtime_anchor_set", { name: "from_mcp", why: "smoke" });
  const l1 = await A.listAnchors(page);
  const mine = l1.anchors.find((a) => a.name === "from_mcp");
  check(/^ANCHOR from_mcp/.test(set1) && mine && mine.cycle > 0 && typeof mine.frame === "number", "the page's list shows the anchor the assistant set, with cycle and frame, with no reload", JSON.stringify(mine));
  check(l1.cap === 32 && l1.used === 1, "…and the 32-slot use", JSON.stringify([l1.used, l1.cap]));

  head("B  set by the page, listed over MCP");
  const cps = (await page.call("checkpoint/list", {})).checkpoints;
  const oldest = cps[0];
  await page.call("checkpoint/restore", { session_id: "shared", id: oldest.id, then: "pause" }); // the user clicks a frame
  const clickedFrame = oldest.id;
  const onFrame = await A.setAnchor(page, "shared", "from_ui_frame", { frameId: oldest.id });
  check(onFrame.cycle === oldest.cycles && onFrame.anchorId === clickedFrame && onFrame.name === "from_ui_frame", "setting on the selected frame names THAT frame (its cycle)", JSON.stringify([onFrame.cycle, oldest.cycles]));
  check(/from_mcp/.test(await mcp.call("runtime_anchor_list", {})), "…and the anchor the assistant set keeps its name (a frame is named by moving the cursor onto it, never by whatever the runtime picks)");
  const again = await A.setAnchor(page, "shared", "second_name", { frameId: oldest.id }).then(() => "", (e) => String(e?.message ?? e));
  check(/already the anchor "from_ui_frame"/.test(again), "naming a frame that already has a name is refused, saying so", again);
  const inReplay = await A.setAnchor(page, "shared", "no_frame", {}).then(() => "", (e) => String(e?.message ?? e));
  check(/stands in replay/.test(inReplay), "naming the present instant while the transport is in replay is refused with the way out", inReplay);
  const asHead = await page.call("transport/status", {});
  await page.call("transport/goto", { frame: asHead.frameTotal }); // back to the head, as the filmstrip's live frame
  const nowSt = (await page.call("session/state", { session_id: "shared" })).c64Cycles;
  const present = await A.setAnchor(page, "shared", "from_ui_now", {});
  check(present.cycle === nowSt, "setting with no frame selected captures the machine's present instant and names it", JSON.stringify([present.cycle, nowSt]));
  const ml = await mcp.call("runtime_anchor_list", {});
  check(/from_ui_frame\s+cycle \d+/.test(ml) && /from_ui_now\s+cycle \d+/.test(ml) && /from_mcp/.test(ml), "all three are listed over MCP", ml);

  head("C  go to an anchor from the page");
  const moveTo = await A.gotoAnchor(page, "from_mcp");
  const st = await page.call("session/state", { session_id: "shared" });
  check(st.c64Cycles === mine.cycle && st.runState !== "running", "the shared machine stands at the anchor's cycle, paused", JSON.stringify([st.c64Cycles, mine.cycle, st.runState]));
  const line = await A.transportLine(page);
  check(/nearest anchor: from_mcp \+0/.test(line), "the transport line names the nearest anchor and the distance", line);
  void moveTo;

  head("D  drop; refusals reach the page as the runtime said them");
  await A.dropAnchor(page, "from_ui_frame");
  check(!/from_ui_frame/.test(await mcp.call("runtime_anchor_list", {})), "a dropped anchor is gone over MCP");
  await page.call("transport/goto", { frame: (await page.call("transport/status", {})).frameTotal });
  const dup = await A.setAnchor(page, "shared", "from_mcp", {}).then(() => "", (e) => String(e?.message ?? e));
  check(/already a mark/.test(dup), "setting a taken name rejects with the runtime's own text", dup);
  const empty = await A.setAnchor(page, "shared", "  ", {}).then(() => "", (e) => String(e?.message ?? e));
  check(/needs a name/.test(empty), "an empty name is refused before anything is captured");
  client.close?.();
  mcp.stop();
}

head("E  the page's source and the built bundle");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const uiSources = walk("ui/src").filter((f) => /\.(tsx?|css)$/.test(f));
check(uiSources.every((f) => !/listBookmarks/.test(read(f))), "no UI source calls the dead listBookmarks");
check(!existsSync(join(ROOT, "ui/src/workbench/components/BookmarkOverlay.tsx")), "the bookmark panel is gone");
check(/listAnchors/.test(read("ui/src/workbench/tabs/Trace.tsx")) && /AnchorList/.test(read("ui/src/workbench/tabs/Trace.tsx")), "the Trace tab's panel is the anchor list");
const film = read("ui/src/workbench/components/Filmstrip.tsx");
check(/setAnchor\(/.test(film) && /gotoAnchor\(/.test(film) && /transportLine\(/.test(film) && /MOVES the shared machine/.test(film), "the filmstrip sets, goes to and drops anchors, shows the transport line, and says that go moves the machine");
const dist = join(ROOT, "ui/dist/assets");
if (existsSync(dist)) {
  const bundle = readdirSync(dist).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
  check(/Set anchor/.test(bundle) && /mark\/goto/.test(bundle) && /nearest anchor/.test(bundle) && !/listBookmarks/.test(bundle), "the built bundle carries the controls and not the dead call");
} else console.log("  SKIPPED  the built bundle (ui/dist is not built — npm run ui:build)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-905 workbench: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
