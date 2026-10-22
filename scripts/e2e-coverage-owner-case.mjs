#!/usr/bin/env node
// Coverage owner lookup is case-insensitive the way the graph is.
//
// The graph keys a file's nodes under normStem of its name, which is lower case
// (`im2_a520_game_a520_end` for `im2_A520_game_a520_end.bin`). The coverage loop looked
// those owners up with the file stem as written, so a file with capitals in its name was
// measured against no ranges at all - fully annotated, 0 bytes covered.
//
// One project, three files, each covered to its last byte in the graph: a lower-case stem
// (the control), a mixed-case stem and an upper-case stem. project_slots over the stdio MCP
// server must count all three in full, with and without a contract scope naming them.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const { slotReport } = await import("../dist/slots/state.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { saveContract } = await import("../dist/contract/contract.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
const { normStem } = await import("../dist/knowledge-graph/migrate/classify.js");

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

const SLUG = "ownercase";
const dir = testTmpDir("c64re-ownercase-");
try {
  const svc = new ProjectKnowledgeService(dir);
  svc.initProject({ name: SLUG, description: "coverage owner case", tags: ["gate"] });
  mkdirSync(join(dir, "payloads"), { recursive: true });
  // name, size, load address
  const files = [
    ["room_lower.bin", 480, 0x80f9],
    ["Game_A520_end.bin", 4560, 0xa520],
    ["TITLE_A57D.bin", 300, 0xa57d],
  ];
  for (const [name, size] of files) {
    writeFileSync(join(dir, "payloads", name), Buffer.alloc(size, 0x22));
    svc.saveArtifact({ kind: "raw", scope: "analysis", title: name, path: join(dir, "payloads", name), role: "payload-source", format: "raw" });
  }
  // The graph's owner of a file is normStem of its name - lower case - as every producer writes it.
  const store = GraphStore.open(dir);
  const nodes = files.map(([name, size, load]) => {
    const owner = normStem(name);
    return { id: `${SLUG}:ram/${owner}:routine:${load.toString(16).padStart(4, "0")}`, kind: "routine", name: `R${load.toString(16)}`, endAddress: load + size - 1, origin: "static", confidence: "certain" };
  });
  store.replaceGenerated("test", null, nodes, []);
  for (const n of nodes) store.upsertHuman({ id: n.id, kind: "routine", name: `${n.name.toLowerCase()}_main`, origin: "user", confidence: "user_asserted" });
  store.close();
  check("fixture: graph owners are lower case", normStem("Game_A520_end.bin") === "game_a520_end", normStem("Game_A520_end.bin"));

  const TOTAL = 480 + 4560 + 300;
  const [slots] = await session(dir, [["project_slots", {}]]);
  const [cov, tot] = coverageOf(slots);
  check("denominator = the three files", tot === TOTAL, `${tot} / expected ${TOTAL}`);
  check("every file, whatever the case of its name, is covered to its last byte",
    cov === TOTAL, `${cov} / expected ${TOTAL} (lower-case file alone: 480)`);

  const report = await slotReport(dir);
  check("slotReport agrees: covered = total", report.coverage.covered === TOTAL, `${report.coverage.covered} / ${report.coverage.total}`);

  // A contract scope names the files as they are spelled on disk.
  saveContract(dir, {
    goal: "reverse the game",
    deliver: { scope: [{ file: "Game_A520_end.bin", why: "game" }, { file: "TITLE_A57D.bin", why: "title" }], coverageRatio: 0.5 },
  });
  const scoped = await slotReport(dir);
  check("contract scope: denominator = the two capitalised files", scoped.coverage.total === 4560 + 300, `${scoped.coverage.total}`);
  check("contract scope: both are covered in full", scoped.coverage.covered === 4560 + 300, `${scoped.coverage.covered} / expected ${4560 + 300}`);

  saveContract(dir, {
    goal: "reverse the game",
    deliver: { scope: [{ file: "room_lower.bin", why: "room" }], coverageRatio: 0.5 },
  });
  const scoped2 = await slotReport(dir);
  check("contract scope: the lower-case file alone is 480 of 480", scoped2.coverage.covered === 480 && scoped2.coverage.total === 480,
    `${scoped2.coverage.covered} / ${scoped2.coverage.total}`);
  const aside = scoped2.scope?.outOfScope ?? [];
  const asideOf = (owner) => aside.find((o) => o.owner === owner);
  check("set aside, reported: a capitalised file keeps its own coverage (4560 of 4560)",
    asideOf("game_a520_end")?.bytes === 4560 && asideOf("game_a520_end")?.covered === 4560, JSON.stringify(asideOf("game_a520_end")));
  check("set aside, reported: an upper-case file keeps its own coverage (300 of 300)",
    asideOf("title_a57d")?.bytes === 300 && asideOf("title_a57d")?.covered === 300, JSON.stringify(asideOf("title_a57d")));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nGREEN  e2e-coverage-owner-case" : `\nRED  e2e-coverage-owner-case: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
