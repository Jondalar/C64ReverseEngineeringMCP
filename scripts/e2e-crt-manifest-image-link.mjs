// project_inventory_sync repairs a cartridge manifest that an older extract_crt left as a
// `prg` disasm-target with NO link to its .crt — role AND image link — so the cartridge
// is registered (Spec 909) and a bank's bytes resolve to it, not to the project's other
// cartridge as "the project's only cartridge".
// Hermetic: synthetic CRTs, temp project outside the repo, live MCP stdio.
// Run: npm run e2e:crt-manifest-image-link
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
console.log("crt manifest image link (old record repaired, cartridge registered, bank resolves to it)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");

// Two cartridges with the same header name and size, different bytes: the header alone cannot tell them apart.
function makeCrt(fill) {
  const chipData = 32, hdr = 0x40, pkt = 0x10 + chipData;
  const crt = Buffer.alloc(hdr + pkt, 0);
  crt.write("C64 CARTRIDGE   ", 0, "ascii");
  crt.writeUInt32BE(hdr, 0x10);
  crt.writeUInt16BE(0x0100, 0x14);
  crt[0x19] = 0x01;
  crt.write("SAME NAME", 0x20, "ascii");
  crt.write("CHIP", hdr, "ascii");
  crt.writeUInt32BE(pkt, hdr + 4);
  crt.writeUInt16BE(0, hdr + 0x0a);
  crt.writeUInt16BE(0x8000, hdr + 0x0c);
  crt.writeUInt16BE(chipData, hdr + 0x0e);
  Buffer.from([0x09, 0x80, 0x09, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30]).copy(crt, hdr + 0x10);
  for (let i = 9; i < chipData; i++) crt[hdr + 0x10 + i] = fill;
  return crt;
}

const projectDir = testTmpDir("c64re-e2e-crtimagelink-");
ok(!projectDir.startsWith(ROOT), "project dir is outside the repo", projectDir);
mkdirSync(join(projectDir, "media"), { recursive: true });
writeFileSync(join(projectDir, "media", "one.crt"), makeCrt(0xea));
writeFileSync(join(projectDir, "media", "two.crt"), makeCrt(0x60));

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
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const artifacts = () => new ProjectKnowledgeService(projectDir).listArtifacts();
const manifestOf = (dir) => artifacts().find((a) => a.relativePath === `analysis/${dir}/manifest.json`);
const imageOf = (file) => artifacts().find((a) => a.relativePath === `media/${file}`);
const cartTokens = () => {
  const db = new DatabaseSync(join(projectDir, "knowledge", "graph.sqlite"));
  try { return db.prepare("SELECT DISTINCT id FROM nodes WHERE kind = 'cartridge'").all().map((r) => r.id.split(":")[1].slice(4)).sort(); }
  finally { db.close(); }
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  await call("project_init", { preferred_assembler: "kickass", project_dir: projectDir, name: "crt-manifest-image-link" });
  await call("agent_onboard", { project_dir: projectDir });
  await call("extract_crt", { project_dir: projectDir, crt_path: "media/one.crt", output_dir: "analysis/extracted" });
  await call("extract_crt", { project_dir: projectDir, crt_path: "media/two.crt", output_dir: "analysis/extracted-two" });
  ok(JSON.stringify(cartTokens()) === JSON.stringify(["one", "two"]), "fresh extracts: two cartridges", cartTokens().join(","));

  // The project as an older extract_crt left it (before Spec 909 registered cartridges): the payload auto-chain
  // disassembled the FIRST cartridge's manifest.json as code, the registration re-labelled the record
  // disasm-target / prg and dropped its link to the .crt, and no cartridge node was ever made for it.
  const one = manifestOf("extracted");
  const svc = new ProjectKnowledgeService(projectDir);
  svc.saveArtifact({ id: one.id, kind: "prg", scope: "input", title: one.title, path: one.path, role: "disasm-target", producedByTool: "disasm", sourceArtifactIds: [], tags: ["disasm", "input"] });
  const db = new DatabaseSync(join(projectDir, "knowledge", "graph.sqlite"));
  db.prepare("DELETE FROM nodes WHERE kind = 'cartridge' AND id LIKE '%:crt/one:cartridge'").run();
  db.close();
  const broken = manifestOf("extracted");
  ok(broken.role === "disasm-target" && (broken.sourceArtifactIds ?? []).length === 0, "old project: manifest is a disasm-target with no image link", `${broken.role}/${broken.kind} src=${JSON.stringify(broken.sourceArtifactIds)}`);
  ok(JSON.stringify(cartTokens()) === JSON.stringify(["two"]), "old project: only the second cartridge is registered", cartTokens().join(","));

  await call("project_inventory_sync", { project_dir: projectDir });

  const fixed = manifestOf("extracted");
  const oneImage = imageOf("one.crt");
  ok(fixed.role === "crt-manifest" && fixed.kind === "manifest", "inventory sync restores role crt-manifest / kind manifest", `${fixed.role}/${fixed.kind}`);
  ok((fixed.sourceArtifactIds ?? []).includes(oneImage.id), "inventory sync restores the manifest's link to ITS image (one.crt, not two.crt)", `src=${JSON.stringify(fixed.sourceArtifactIds)} one.crt=${oneImage.id}`);
  ok(JSON.stringify(cartTokens()) === JSON.stringify(["one", "two"]), "after the sync the project holds both cartridges", cartTokens().join(","));

  const r = await call("disasm", { project_dir: projectDir, path: "analysis/extracted/chips/bank_00_8000.bin", load_address: "$8000", bank: 0, space: "crt", no_analysis: true, import_graph: false });
  const text = textOf(r);
  const prov = /^Provenance: .*$/m.exec(text)?.[0] ?? "(no Provenance line)";
  console.log(`    | ${prov}`);
  ok(/cartridge one, bank 0, space crt/.test(prov), "disasm of the first cartridge's bank 0 names cartridge one", prov);
  ok(!/the project's only cartridge/.test(text), "and does not fall back to \"the project's only cartridge\"");
} catch (e) {
  ok(false, "script ran", String(e?.stack ?? e));
} finally {
  proc.kill();
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  crt manifest image link: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
