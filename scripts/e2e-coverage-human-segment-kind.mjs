#!/usr/bin/env node
// Coverage takes a segment's kind from the human layer when it has one.
//
// The graph keeps one id in two rows (generated, human). The coverage query merged them
// with MAX(segment_kind), which is a string compare: 'unknown' > 'state_variable' >
// 'lookup_table' > 'code'. A segment the analyser left `unknown` and an annotation then
// classified as `code` stayed `unknown`, and its bytes were reported as "declared unknown".
//
// The human kind must win the way the human name does; a human `unknown` must still be
// unknown (the rule above claimsItsBytes: a blanket `unknown` is never coverage).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const { slotReport } = await import("../dist/slots/state.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

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

const coverageOf = (text) => /Coverage: (\d+) \/ (\d+) bytes/.exec(text)?.slice(1, 3).map(Number) ?? [];
const unknownOf = (text) => Number(/not counted: (\d+) byte\(s\) in ranges declared `unknown`/.exec(text)?.[1] ?? 0);

const SLUG = "segkind";
const OWNER = "blk";
const BASE = 0x9000;
const dir = testTmpDir("c64re-segkind-");
try {
  const svc = new ProjectKnowledgeService(dir);
  svc.initProject({ name: SLUG, description: "coverage human segment kind", tags: ["gate"] });
  mkdirSync(join(dir, "payloads"), { recursive: true });
  // Five 256-byte segments in one 1280-byte headerless file.
  writeFileSync(join(dir, "payloads", `${OWNER}.bin`), Buffer.alloc(5 * 256, 0x33));
  svc.saveArtifact({ kind: "raw", scope: "analysis", title: `${OWNER}.bin`, path: join(dir, "payloads", `${OWNER}.bin`), role: "payload-source", format: "raw" });

  //            generated kind     human kind         what it must count as
  const cases = [
    ["unknown", "code", "counts"],            // A: the human classified what the analyser left open
    ["unknown", "lookup_table", "counts"],    // B: the same, a table
    ["code", null, "counts"],                 // C: control, no human row
    ["unknown", "unknown", "unknown"],        // D: a human-declared unknown stays unknown
    ["code", "unknown", "unknown"],           // E: ... even over a generated classification
  ];
  const id = (i) => `${SLUG}:ram/${OWNER}:segment:${(BASE + i * 256).toString(16)}`;
  const store = GraphStore.open(dir);
  store.replaceGenerated("test", null, cases.map(([gen], i) => ({
    id: id(i), kind: "segment", name: `unknown_${(BASE + i * 256).toString(16).toUpperCase()}`,
    endAddress: BASE + i * 256 + 255, attrs: { segment_kind: gen }, origin: "static", confidence: "certain",
  })), []);
  cases.forEach(([, human], i) => {
    if (human) store.upsertHuman({ id: id(i), kind: "segment", name: `seg_${i}`, attrs: { segment_kind: human }, origin: "user", confidence: "user_asserted" });
  });
  const kinds = store.db.prepare("SELECT layer, json_extract(attrs, '$.segment_kind') AS k FROM nodes WHERE id = ? ORDER BY layer").all(id(0));
  store.close();
  check("fixture: segment A holds 'unknown' (generated) and 'code' (human)",
    JSON.stringify(kinds) === JSON.stringify([{ layer: "generated", k: "unknown" }, { layer: "human", k: "code" }]), JSON.stringify(kinds));

  const COUNTS = 3 * 256, UNKNOWN = 2 * 256;
  const [slots] = await session(dir, [["project_slots", {}]]);
  const [cov, tot] = coverageOf(slots);
  check("denominator = the file (1280)", tot === 1280, `${tot}`);
  check("criterion 1: a human 'code' / 'lookup_table' over a generated 'unknown' counts (A, B, C = 768)",
    cov === COUNTS, `${cov} / expected ${COUNTS}`);
  check("criterion 2: a human 'unknown' stays unknown, also over a generated 'code' (D, E = 512 declared unknown)",
    unknownOf(slots) === UNKNOWN, `${unknownOf(slots)} / expected ${UNKNOWN}`);

  const report = await slotReport(dir);
  check("slotReport agrees", report.coverage.covered === COUNTS && report.coverage.declaredUnknown === UNKNOWN,
    `covered ${report.coverage.covered}, declaredUnknown ${report.coverage.declaredUnknown}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nGREEN  e2e-coverage-human-segment-kind" : `\nRED  e2e-coverage-human-segment-kind: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
