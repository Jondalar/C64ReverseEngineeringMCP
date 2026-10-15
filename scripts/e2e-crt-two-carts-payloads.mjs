// Issue #90 — two different cartridges in one project keep separate chip payloads.
// The first (or only) cartridge keeps today's ids `<slug>:crt/NN:chip:8000`; a second,
// different CRT's chips get a cartridge qualifier, so list_payloads shows both sets,
// each `src=` pointing at its own extract, and the payload folders under
// artifacts/generated/payloads/ are separate per CRT.
// Hermetic: synthetic 4-bank EasyFlash CRTs, temp project outside the repo, live MCP stdio.
// Run: npm run e2e:crt-two-carts-payloads (build:mcp first).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
console.log("issue #90: two CRTs in one project keep separate chip payloads\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

const BANKS = 4;
const CHIP = 0x2000;
/** An EasyFlash CRT (hw type 32) with BANKS x 8K ROML chips at $8000; `seed` changes the bytes. */
function makeCrt(name, seed) {
  const hdr = 0x40, pkt = 0x10 + CHIP;
  const crt = Buffer.alloc(hdr + BANKS * pkt, 0);
  crt.write("C64 CARTRIDGE   ", 0, "ascii");
  crt.writeUInt32BE(hdr, 0x10);
  crt.writeUInt16BE(0x0100, 0x14);
  crt.writeUInt16BE(32, 0x16);
  crt[0x18] = 0x01; crt[0x19] = 0x00;
  crt.write(name, 0x20, "ascii");
  for (let b = 0; b < BANKS; b++) {
    const o = hdr + b * pkt;
    crt.write("CHIP", o, "ascii");
    crt.writeUInt32BE(pkt, o + 4);
    crt.writeUInt16BE(2, o + 0x08);
    crt.writeUInt16BE(b, o + 0x0a);
    crt.writeUInt16BE(0x8000, o + 0x0c);
    crt.writeUInt16BE(CHIP, o + 0x0e);
    // a tiny routine per bank: LDA #seed+bank ; STA $D020 ; RTS, then filler
    Buffer.from([0xa9, (seed + b) & 0xff, 0x8d, 0x20, 0xd0, 0x60]).copy(crt, o + 0x10);
    for (let i = 6; i < CHIP; i++) crt[o + 0x10 + i] = (i * (seed + 3) + b) & 0xff;
  }
  return crt;
}

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-twocarts-"));
ok(!projectDir.startsWith(ROOT), "project dir is outside the repo", projectDir);
mkdirSync(join(projectDir, "input", "crt"), { recursive: true });
writeFileSync(join(projectDir, "input", "crt", "game.crt"), makeCrt("GAME", 0x11));
writeFileSync(join(projectDir, "input", "crt", "Game1012.crt"), makeCrt("GAME 1012", 0x57));

const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 300000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** list_payloads rows of kind chip: { id, src, srcPath } */
async function chipPayloads() {
  const text = textOf(await call("list_payloads", { project_dir: projectDir, limit: 500 }));
  const paths = new Map(new ProjectKnowledgeService(projectDir).listArtifacts().map((a) => [a.id, a.relativePath]));
  return text.split("\n")
    .map((l) => l.match(/^\s+(\S+:crt\/\S+:chip:[0-9a-f]{4}) \| .* src=(\S+)/u))
    .filter(Boolean)
    .map((m) => ({ id: m[1], src: m[2], srcPath: paths.get(m[2]) ?? "?" }));
}
const FIRST = /^[a-z0-9][a-z0-9-]*:crt\/0[0-3]:chip:8000$/u;

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { project_dir: projectDir, name: "two-carts" });
  await call("agent_onboard", { project_dir: projectDir });

  await call("extract_crt", { project_dir: projectDir, crt_path: "input/crt/game.crt", output_dir: "analysis/extracted" });
  const one = await chipPayloads();
  ok(one.length === BANKS, `first CRT: ${BANKS} chip payloads`, String(one.length));
  ok(one.every((p) => FIRST.test(p.id)), "first CRT: ids keep today's form <slug>:crt/NN:chip:8000", one.map((p) => p.id).join(", "));
  const firstIds = one.map((p) => p.id).sort();

  await call("extract_crt", { project_dir: projectDir, crt_path: "input/crt/Game1012.crt", output_dir: "analysis/extracted_1012" });
  const both = await chipPayloads();
  ok(both.length === 2 * BANKS, `both CRTs: ${2 * BANKS} chip payloads listed (criterion 1)`, String(both.length));
  const a = both.filter((p) => FIRST.test(p.id));
  const b = both.filter((p) => !FIRST.test(p.id));
  ok(JSON.stringify(a.map((p) => p.id).sort()) === JSON.stringify(firstIds), "first CRT's ids unchanged after the second extract");
  ok(a.length === BANKS && a.every((p) => p.srcPath.startsWith("analysis/extracted/")), "first CRT's src= points at its own extract", a.map((p) => p.srcPath).join(", "));
  ok(b.length === BANKS && new Set(b.map((p) => p.id)).size === BANKS, "second CRT: its own distinct ids", b.map((p) => p.id).join(", "));
  ok(b.length === BANKS && b.every((p) => p.srcPath.startsWith("analysis/extracted_1012/")), "second CRT's src= points at its own extract", b.map((p) => p.srcPath).join(", "));

  const payloadsDir = join(projectDir, "artifacts", "generated", "payloads");
  const dirs = existsSync(payloadsDir) ? readdirSync(payloadsDir).filter((d) => /chip/u.test(d)) : [];
  ok(dirs.length === 2 * BANKS, `payload folders separate per CRT: ${2 * BANKS} chip folders (criterion 2)`, dirs.join(", "));

  // Re-extracting the first CRT changes nothing about either set.
  await call("extract_crt", { project_dir: projectDir, crt_path: "input/crt/game.crt", output_dir: "analysis/extracted" });
  const again = await chipPayloads();
  ok(again.length === 2 * BANKS && JSON.stringify(again.map((p) => p.id).sort()) === JSON.stringify(both.map((p) => p.id).sort()),
    "re-extracting the first CRT keeps both sets", String(again.length));
  // ...and so does re-extracting the second one.
  await call("extract_crt", { project_dir: projectDir, crt_path: "input/crt/Game1012.crt", output_dir: "analysis/extracted_1012" });
  const again2 = await chipPayloads();
  ok(again2.length === 2 * BANKS && JSON.stringify(again2.map((p) => p.id).sort()) === JSON.stringify(both.map((p) => p.id).sort()),
    "re-extracting the second CRT keeps both sets", String(again2.length));
} catch (e) {
  ok(false, "script ran", String(e));
} finally {
  proc.kill();
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  two CRTs, separate payloads: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
