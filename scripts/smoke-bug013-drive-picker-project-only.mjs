// BUG-013 — the Live Drive insert picker (media/recent WS handler) must list
// ONLY media from the active project in product mode, never repo/dev samples.
// The leak source was the GLOBAL recents store (getRecent), which carried prior
// gate-corpus disks (motm.g64, POLARBEAR.d64, …). This smoke seeds the recents
// store with a project disk AND an external "sample" disk, starts the workspace
// pointed at the project (no --dev-samples), and asserts the picker returns the
// project disk and excludes the external sample.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-013 — Drive picker shows project media only (no dev samples)\n");

// project dir with a real project disk under input/disk/
const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug013-proj-"));
mkdirSync(join(projectDir, "input", "disk"), { recursive: true });
const projDisk = join(projectDir, "input", "disk", "ddd_intro.d64");
writeFileSync(projDisk, Buffer.alloc(174848)); // d64-sized blank

// external "repo sample" disk OUTSIDE the project (simulates samples/motm.g64)
const samplesDir = mkdtempSync(join(tmpdir(), "c64re-bug013-samples-"));
const sampleDisk = join(samplesDir, "motm.g64");
writeFileSync(sampleDisk, Buffer.alloc(1024));

// seed the GLOBAL recents store (via env override) with BOTH — newest first.
const recentFile = join(mkdtempSync(join(tmpdir(), "c64re-bug013-recent-")), "recent-media.json");
writeFileSync(recentFile, JSON.stringify([
  { path: sampleDisk, type: "g64", mountedAt: "2026-05-30T10:00:00.000Z" },
  { path: projDisk, type: "d64", mountedAt: "2026-05-30T09:00:00.000Z" },
], null, 2));

const env = { ...process.env, C64RE_RECENT_FILE: recentFile };
const PORT = 4327;
const srv = spawn("node", [join(ROOT, "scripts/workspace.mjs"), "--project", projectDir, "--port", String(PORT)],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
let log = ""; srv.stdout.on("data", (b) => log += b); srv.stderr.on("data", (b) => log += b);

const tcpUp = (port, ms = 800) => new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port }); const d = (v) => { try { s.destroy(); } catch {} r(v); }; const t = setTimeout(() => d(false), ms); s.once("connect", () => { clearTimeout(t); d(true); }); s.once("error", () => { clearTimeout(t); d(false); }); });
const waitTcp = async (port, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };

try {
  ok(await waitTcp(4312), "1 runtime WS backend up", ":4312");
  const WebSocket = (await import("ws")).default;
  const recent = await new Promise((resolve, reject) => {
    const w = new WebSocket("ws://127.0.0.1:4312"); const id = 1;
    const t = setTimeout(() => { try { w.close(); } catch {} reject(new Error("ws timeout")); }, 10000);
    w.on("open", () => w.send(JSON.stringify({ jsonrpc: "2.0", id, method: "media/recent", params: {} })));
    w.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id === id) { clearTimeout(t); w.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
    w.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  const list = Array.isArray(recent) ? recent : [];
  const paths = list.map((e) => e.path);
  ok(paths.includes(projDisk), "2 project disk present in picker", "ddd_intro.d64");
  ok(!paths.includes(sampleDisk), "3 external sample disk EXCLUDED from picker", "motm.g64 must not appear");
  ok(!paths.some((p) => /\/motm\.g64$|POLARBEAR\.d64$|the_pawn_s1\.g64$/.test(p)), "4 no known repo gate-corpus names leak", "");
  ok(list.length > 0 && list.every((e) => e.path.startsWith(projectDir)), "5 every picker entry is inside the active project dir", `entries=${list.length}`);

  console.log(`\n--- report ---`);
  console.log(`picker entries: ${paths.map((p) => p.replace(projectDir + "/", "")).join(", ") || "(none)"}`);
} catch (e) {
  ok(false, "harness", e.message + (log ? " | " + log.slice(-180) : ""));
} finally {
  try { srv.kill("SIGINT"); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  try { srv.kill("SIGKILL"); } catch {}
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug013: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
