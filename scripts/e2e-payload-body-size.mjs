#!/usr/bin/env node
// Issue #82 - a payload is a payload. Only a headed PRG spends two bytes on a load address;
// a headerless block counts every byte, and its coverage range sits at the load address it
// runs at.
//
// The records here are written by the REAL writers, over the stdio MCP server the way a
// session reaches them (register_payloads_from_manifest, register_payload,
// project_inventory_sync) and by the disk-manifest import - never hand-typed. The one
// hand-written shape is the OLD one (`kind: prg, format: raw`) an earlier build left on
// disk, so the repair can be shown to fix it.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { slotReport, payloadBodySize } = await import("../dist/slots/state.js");
const { artifactHasLoadHeader } = await import("../dist/project-knowledge/artifact-header.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { saveContract } = await import("../dist/contract/contract.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

// ---- one MCP session over stdio: onboard, then the calls, then gone -------------------------
async function session(projectDir, calls) {
  const proc = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "1", C64RE_SLOT_GATE: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const pend = new Map();
  let nid = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } catch { /* not a response */ }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = nid++; pend.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await rpc("tools/call", { name: "agent_onboard", arguments: { project_dir: projectDir } });
  const out = [];
  for (const [name, args] of calls) {
    const r = await rpc("tools/call", { name, arguments: args });
    out.push((r.result?.content ?? []).map((c) => c.text).join("\n") || JSON.stringify(r));
  }
  proc.kill();
  return out;
}

const dirs = [];
function project(slug) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-bodysize-${slug}-`));
  dirs.push(dir);
  new ProjectKnowledgeService(dir).initProject({ name: slug, description: `issue 82 ${slug}`, tags: ["gate"] });
  return dir;
}
const headed = (n, load) => { const b = Buffer.alloc(n, 0xea); b.writeUInt16LE(load, 0); return b; };
const rid = (slug, owner, a) => `${slug}:ram/${owner}:routine:${a.toString(16).padStart(4, "0")}`;
const totalOf = (text) => Number(/Coverage: (\d+) \/ (\d+) bytes/.exec(text)?.[2]);
const coveredOf = (text) => Number(/Coverage: (\d+) \/ (\d+) bytes/.exec(text)?.[1]);

try {
  // ============================ A. the real writers, one session ============================
  const SLUG = "bodysize";
  const dir = project(SLUG);
  mkdirSync(join(dir, "payloads"), { recursive: true });
  writeFileSync(join(dir, "payloads", "boot.prg"), headed(111, 0x0801));        // headed, via the manifest (format prg): 109 body
  writeFileSync(join(dir, "payloads", "room_a.bin"), Buffer.alloc(480, 0x11));  // headerless, via the manifest (format raw)
  writeFileSync(join(dir, "payloads", "tower.bin"), Buffer.alloc(3840, 0x22));  // headerless, via the manifest (format raw)
  writeFileSync(join(dir, "payloads", "engine.prg"), headed(1002, 0x4000));     // headed, via register_payload: 1000 body
  writeFileSync(join(dir, "payloads", "blobx.bin"), Buffer.alloc(300, 0x33));   // headerless, via register_payload format raw
  const span = { kind: "sector", track: 17, sector: 0, offsetInSector: 0, length: 254 };
  writeFileSync(join(dir, "payloads", "manifest.spec784.json"), JSON.stringify({
    manifestVersion: 1,
    extractor: "e2e",
    loaderModels: [{ id: "custom", kind: "custom-fastloader" }],
    payloads: [
      { name: "boot", derivedBy: "custom", format: "prg", loadAddress: 0x0801, spans: [span], bytesPath: "payloads/boot.prg" },
      { name: "room_a", derivedBy: "custom", format: "raw", loadAddress: 0x80f9, spans: [span], bytesPath: "payloads/room_a.bin" },
      { name: "tower", derivedBy: "custom", format: "raw", loadAddress: 0xa520, spans: [span], bytesPath: "payloads/tower.bin" },
    ],
  }, null, 2));

  // room_a runs at $80F9 and is covered to its last byte; boot is covered from $0801 to its last byte
  const store = GraphStore.open(dir);
  store.replaceGenerated("test", null, [
    { id: rid(SLUG, "room_a", 0x80f9), kind: "routine", name: "RA", endAddress: 0x80f9 + 479, origin: "static", confidence: "certain" },
    { id: rid(SLUG, "boot", 0x0801), kind: "routine", name: "BOOT", endAddress: 0x0801 + 108, origin: "static", confidence: "certain" },
  ], []);
  for (const [o, a] of [["room_a", 0x80f9], ["boot", 0x0801]]) {
    store.upsertHuman({ id: rid(SLUG, o, a), kind: "routine", name: `${o}_main`, origin: "user", confidence: "user_asserted" });
  }
  store.close();

  const [regM, regP, regB, slotsA] = await session(dir, [
    ["register_payloads_from_manifest", { manifest_path: "payloads/manifest.spec784.json" }],
    ["register_payload", { name: "engine", load_address: 0x4000, source_prg_path: "payloads/engine.prg", format: "prg" }],
    ["register_payload", { name: "blobx", load_address: 0x9000, source_prg_path: "payloads/blobx.bin", format: "raw" }],
    ["project_slots", {}],
  ]);
  check("register_payloads_from_manifest ran", /Registered 3 payload/.test(regM), regM.split("\n")[0]);
  check("register_payload (headed) ran", /Payload registered/.test(regP), regP.split("\n")[0]);
  check("register_payload (raw) ran", /Payload registered/.test(regB), regB.split("\n")[0]);

  const rec = new KnowledgeRecords(dir);
  const byName = (n) => rec.listArtifacts().find((a) => a.relativePath.endsWith(n));
  check("writer: a manifest raw payload is recorded as raw, not as a PRG row",
    byName("room_a.bin")?.kind === "raw" && byName("room_a.bin")?.format === "raw", JSON.stringify([byName("room_a.bin")?.kind, byName("room_a.bin")?.format]));
  check("writer: a manifest prg payload is recorded as a headed PRG",
    byName("boot.prg")?.kind === "prg" && artifactHasLoadHeader(byName("boot.prg")));
  check("writer: register_payload format raw is recorded as raw",
    byName("blobx.bin")?.kind === "raw", byName("blobx.bin")?.kind);
  check("writer: register_payload on a carved .prg stays a headed PRG",
    byName("engine.prg")?.kind === "prg" && artifactHasLoadHeader(byName("engine.prg")));

  const EXPECT = 109 + 480 + 3840 + 1000 + 300;
  check("denominator = exact body sum (two headed PRGs lose 2 each, three raw files lose nothing)",
    totalOf(slotsA) === EXPECT, `${totalOf(slotsA)} / expected ${EXPECT}`);
  check("a raw file is covered n/n bytes (480 of 480) and the headed PRG to its last body byte (109 of 109)",
    coveredOf(slotsA) === 480 + 109, `${coveredOf(slotsA)} / expected ${480 + 109}`);

  // ============================ B. the OLD shape, and the repair ============================
  // What an earlier build left behind: the same source file, recorded kind prg + format raw.
  const svc = new ProjectKnowledgeService(dir);
  for (const n of ["room_a.bin", "tower.bin"]) {
    const a = byName(n);
    svc.saveArtifact({ id: a.id, kind: "prg", scope: a.scope, title: a.title, path: a.relativePath, role: "payload-source", format: "raw" });
  }
  const old = new KnowledgeRecords(dir).listArtifacts().find((a) => a.relativePath.endsWith("tower.bin"));
  check("fixture: the old ambiguous shape is on disk (kind prg, format raw)", old.kind === "prg" && old.format === "raw");
  check("one helper: the old shape is still read as headerless", !artifactHasLoadHeader(old) && payloadBodySize(old) === 3840);
  const [slotsOld] = await session(dir, [["project_slots", {}]]);
  check("the old shape measures the same denominator without any repair", totalOf(slotsOld) === EXPECT, `${totalOf(slotsOld)} / expected ${EXPECT}`);

  const [sync1, sync2] = await session(dir, [["project_inventory_sync", {}], ["project_inventory_sync", {}]]);
  check("project_inventory_sync repairs the old rows once", /re-labelled raw: 2/.test(sync1), (/.*re-labelled.*/.exec(sync1) ?? ["(no line)"])[0]);
  check("...and a second run repairs none", !/re-labelled raw/.test(sync2));
  const fixed = new KnowledgeRecords(dir).listArtifacts().find((a) => a.relativePath.endsWith("tower.bin"));
  check("...the row now says kind raw", fixed.kind === "raw" && fixed.format === "raw", JSON.stringify([fixed.kind, fixed.format]));
  const [slotsFixed] = await session(dir, [["project_slots", {}]]);
  check("...and the denominator is unchanged by the repair", totalOf(slotsFixed) === EXPECT, `${totalOf(slotsFixed)} / expected ${EXPECT}`);

  // ============================ C. a contract scope ============================
  saveContract(dir, {
    goal: "port the game",
    deliver: { scope: [{ file: "boot.prg", why: "boot" }, { file: "room_a.bin", why: "room" }, { file: "engine.prg", why: "engine" }], coverageRatio: 0.5 },
  });
  const scoped = await slotReport(dir);
  check("contract scope: denominator = the exact body sum of the files named (109 + 480 + 1000)",
    scoped.coverage.total === 109 + 480 + 1000, `${scoped.coverage.total} / expected ${109 + 480 + 1000}`);
  check("contract scope: the raw room is covered 480 of 480 inside it", scoped.coverage.covered === 480 + 109, `${scoped.coverage.covered}`);

  // ============================ D. the disk-manifest import ============================
  const D = "disk82";
  const dd = project(D);
  const service = new ProjectKnowledgeService(dd);
  const diskDir = join(dd, "analysis", "disk", "fixture");
  mkdirSync(diskDir, { recursive: true });
  writeFileSync(join(diskDir, "01_loader.prg"), headed(1002, 0x0801));   // a real PRG: 1000 body bytes
  writeFileSync(join(diskDir, "02_t202.prg"), Buffer.concat([Buffer.from([0x00, 0xff]), Buffer.alloc(2000, 0x41)])); // a record file: PRG-typed, no address
  const manifestPath = join(diskDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    sourceImage: "fixture.d64", format: "d64", diskName: "FIXTURE", diskId: "83",
    files: [
      { index: 0, origin: "kernal", name: "loader", type: "PRG", sizeSectors: 5, sizeBytes: 1002, track: 17, sector: 0, loadAddress: 0x0801, relativePath: "01_loader.prg" },
      { index: 1, origin: "kernal", name: "t202", type: "PRG", sizeSectors: 9, sizeBytes: 2002, track: 20, sector: 0, loadAddress: 0xff00, relativePath: "02_t202.prg" },
    ],
  }, null, 2));
  const ma = service.saveArtifact({ kind: "manifest", scope: "generated", title: "Fixture disk manifest", path: manifestPath, role: "disk-manifest", format: "json", producedByTool: "extract_disk" });
  service.importManifestArtifact(ma.id);
  const arts = service.listArtifacts();
  const loader = arts.find((a) => a.relativePath.endsWith("01_loader.prg"));
  const record = arts.find((a) => a.relativePath.endsWith("02_t202.prg"));
  check("disk import: a real PRG file is a headed PRG", loader?.kind === "prg" && artifactHasLoadHeader(loader), JSON.stringify([loader?.kind, loader?.format]));
  check("disk import: a PRG-typed record file with no address is NOT a headed PRG (it was, by its extension)",
    record !== undefined && !artifactHasLoadHeader(record), JSON.stringify([record?.kind, record?.format]));
  const ent = service.listEntities().find((e) => e.kind === "disk-file" && (e.name === "01_loader" || (e.aliases ?? []).includes("loader")));
  check("disk import: the payload's extent is the body ($0801..$0BE8 = 1000 bytes), not the file",
    ent?.addressRange?.start === 0x0801 && ent?.addressRange?.end === 0x0801 + 999, JSON.stringify(ent?.addressRange));
  const diskSlots = await slotReport(dd);
  check("disk import: denominator = 1000 (headed PRG body) + 2002 (record file, every byte)",
    diskSlots.coverage.total === 1000 + 2002, `${diskSlots.coverage.total} / expected ${1000 + 2002}`);

  // ============================ F. the disk is the truth for sizes ============================
  const G = "grow82";
  const gd = project(G);
  mkdirSync(join(gd, "payloads"), { recursive: true });
  writeFileSync(join(gd, "payloads", "a.prg"), headed(102, 0x0801));       // 100 body
  writeFileSync(join(gd, "payloads", "b.bin"), Buffer.alloc(100, 0x44));   // registered at 100, grows to 160
  writeFileSync(join(gd, "payloads", "c.bin"), Buffer.alloc(50, 0x55));    // registered, then deleted
  await session(gd, [
    ["register_payload", { name: "a", load_address: 0x0801, source_prg_path: "payloads/a.prg", format: "prg" }],
    ["register_payload", { name: "b", load_address: 0x9000, source_prg_path: "payloads/b.bin", format: "raw" }],
    ["register_payload", { name: "c", load_address: 0xa000, source_prg_path: "payloads/c.bin", format: "raw" }],
  ]);
  const gRec = new KnowledgeRecords(gd);
  check("writer: a registered file's size is stat'ed at registration (b.bin = 100)",
    gRec.listArtifacts().find((a) => a.relativePath.endsWith("b.bin"))?.fileSize === 100);
  writeFileSync(join(gd, "payloads", "b.bin"), Buffer.alloc(160, 0x44));
  rmSync(join(gd, "payloads", "c.bin"));
  const grown = await slotReport(gd);
  check("a record whose file grew is counted at its disk size (100 + 160, not 100 + 100)",
    grown.coverage.total === 100 + 160, `${grown.coverage.total} / expected 260`);
  check("a registered file that is gone is named, not counted",
    grown.coverage.missing.length === 1 && /c\.bin$/.test(grown.coverage.missing[0]), JSON.stringify(grown.coverage.missing));
  const { formatSlotReport } = await import("../dist/slots/state.js");
  check("...and the S12 answer says 'missing on disk'", /missing on disk[^\n]*c\.bin/.test(formatSlotReport(grown)));
  const [gs1, gs2] = await session(gd, [["project_inventory_sync", {}], ["project_inventory_sync", {}]]);
  check("project_inventory_sync re-reads the grown record's size", /re-read from disk: 1/.test(gs1), (/.*re-read.*/.exec(gs1) ?? ["(no line)"])[0]);
  check("...names the missing file (keeps it)", /missing on disk[^\n]*c\.bin/.test(gs1));
  check("...a second run re-reads none", !/re-read from disk/.test(gs2));
  check("...the stored size now equals the disk",
    new KnowledgeRecords(gd).listArtifacts().find((a) => a.relativePath.endsWith("b.bin"))?.fileSize === 160);
  check("...the record of the missing file is still there",
    new KnowledgeRecords(gd).listArtifacts().some((a) => a.relativePath.endsWith("c.bin")));

  // ============================ E. the helper, unit-wise ============================
  check("payloadBodySize: raw counts every byte", payloadBodySize({ kind: "raw", fileSize: 480 }) === 480);
  check("payloadBodySize: extract counts every byte", payloadBodySize({ kind: "extract", fileSize: 9360 }) === 9360);
  check("payloadBodySize: prg loses the load address", payloadBodySize({ kind: "prg", fileSize: 1002 }) === 1000);
  check("payloadBodySize: prg + format raw is headerless", payloadBodySize({ kind: "prg", format: "raw", fileSize: 480 }) === 480);
  check("payloadBodySize: a recorded range wins", payloadBodySize({ kind: "raw", fileSize: 480, addressRange: { start: 0xc000, end: 0xc0ff } }) === 256);
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nGREEN  e2e-payload-body-size" : `\nRED  e2e-payload-body-size: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
