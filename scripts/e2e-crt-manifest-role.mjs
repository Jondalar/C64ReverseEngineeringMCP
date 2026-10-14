// extract_crt registers the cartridge manifest as role crt-manifest / kind manifest —
// for the first CRT, the second CRT, and a project that still carries the old wrong
// record (disasm-target / prg) from before the fix.
// Hermetic: synthetic CRTs, temp project outside the repo, live MCP stdio.
// Run: npm run e2e:crt-manifest-role (build:mcp first).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
console.log("extract_crt manifest role (first CRT, second CRT, old wrong record)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

function makeCrt(name, loadAddr) {
  const chipData = 32, hdr = 0x40, pkt = 0x10 + chipData;
  const crt = Buffer.alloc(hdr + pkt, 0);
  crt.write("C64 CARTRIDGE   ", 0, "ascii");
  crt.writeUInt32BE(hdr, 0x10);
  crt.writeUInt16BE(0x0100, 0x14);
  crt[0x19] = 0x01;
  crt.write(name, 0x20, "ascii");
  crt.write("CHIP", hdr, "ascii");
  crt.writeUInt32BE(pkt, hdr + 4);
  crt.writeUInt16BE(0, hdr + 0x0a);
  crt.writeUInt16BE(loadAddr, hdr + 0x0c);
  crt.writeUInt16BE(chipData, hdr + 0x0e);
  Buffer.from([0, 0, 0, 0, 0xc3, 0xc2, 0xcd, 0x38, 0x30]).copy(crt, hdr + 0x10);
  for (let i = 9; i < chipData; i++) crt[hdr + 0x10 + i] = i % 2 ? 0xea : 0x60;
  return crt;
}

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-crtmanifest-"));
ok(!projectDir.startsWith(ROOT), "project dir is outside the repo", projectDir);
mkdirSync(join(projectDir, "media"), { recursive: true });
writeFileSync(join(projectDir, "media", "one.crt"), makeCrt("ONE", 0x8000));
writeFileSync(join(projectDir, "media", "two.crt"), makeCrt("TWO", 0x8000));

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
function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const manifests = (dir) => new ProjectKnowledgeService(projectDir).listArtifacts()
  .filter((a) => a.relativePath.endsWith("manifest.json") && a.relativePath.includes(dir));
const wrong = (a) => a.role !== "crt-manifest" || a.kind !== "manifest";
const shape = (list) => list.map((a) => `${a.role}/${a.kind}`).join(",");

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  await call("project_init", { project_dir: projectDir, name: "crt-manifest-role" });
  await call("agent_onboard", { project_dir: projectDir });
  const r1 = await call("extract_crt", { project_dir: projectDir, crt_path: "media/one.crt", output_dir: "analysis/crt-one" });
  console.log(textOf(r1).split("\n").map((l) => "    | " + l).join("\n"));
  let m = manifests("crt-one");
  ok(m.length === 1, "first CRT: one manifest artifact", String(m.length));
  ok(m.length === 1 && !wrong(m[0]), "first CRT: role crt-manifest / kind manifest", shape(m));

  await call("extract_crt", { project_dir: projectDir, crt_path: "media/two.crt", output_dir: "analysis/crt-two" });
  ok(!new ProjectKnowledgeService(projectDir).listArtifacts().some((a) => a.relativePath.includes("manifest.json_")),
    "the manifest was never disassembled as if it were code");
  m = manifests("crt-two");
  ok(m.length === 1 && !wrong(m[0]), "second CRT: role crt-manifest / kind manifest", shape(m));
  m = manifests("crt-one");
  ok(m.length === 1 && !wrong(m[0]), "first CRT's record untouched by the second extract", shape(m));

  // Old project: the record as the buggy version left it.
  const svc = new ProjectKnowledgeService(projectDir);
  const one = manifests("crt-one")[0];
  svc.saveArtifact({ id: one.id, kind: "prg", scope: "input", title: one.title, path: one.path, role: "disasm-target" });
  const broken = manifests("crt-one")[0];
  ok(broken.role === "disasm-target", "old project carries the wrong record", shape([broken]));

  await call("project_inventory_sync", { project_dir: projectDir });
  const fixed = manifests("crt-one");
  ok(fixed.length === 1 && !wrong(fixed[0]), "inventory sync corrects the old record", shape(fixed));
} catch (e) {
  ok(false, "script ran", String(e));
} finally {
  proc.kill();
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  crt manifest role: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
