#!/usr/bin/env node
// The knowledge store under two writers at once.
//
// Six registrations in about 590 calls died like this, only ever at 3- to 6-way
// parallelism and never once serially:
//
//   Error: ENOENT: no such file or directory,
//   rename '…/knowledge/artifacts.json.tmp' -> '…/knowledge/artifacts.json'
//     at writeStoreAtomic (dist/pipeline/lib/artifact-register.cjs:71:30)
//
// The staging name was fixed, so two pipeline children staging at the same
// moment wrote the same file and one of them renamed something that was no
// longer there. And the worse half was invisible: a call printed `rebuild
// verified byte-identical` and then, at the bottom of the same answer,
// `Knowledge registration skipped: ENOENT…`. The artifact was never registered
// and nothing in the result said the work had not landed.
//
// A serial test cannot see any of this, so this gate does not run one. It
// spawns real pipeline children, proves from their own timestamps that they
// were alive together, and then asserts that every registration is in the file.
// The lost-update half is the sharper check: with a unique staging name but no
// lock, nothing crashes and the store ends up with ONE row instead of eight.
//
// Hermetic: temp projects, synthetic PRGs, the bundled pipeline. No ROMs, no
// media, no assembler, no runtime daemon, no network.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:store-concurrency

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const head = (n, title) => console.log(`\n── ${n}. ${title}`);

const mcpCli = join(ROOT, "dist/cli.js");
const pipelineCli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(mcpCli) || !existsSync(pipelineCli)) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("Two writers, one knowledge store\n");

// ───────────────────────────────────────── 0. one protocol, written down twice

{
  head(0, "both trees run the same lock protocol");
  // src/ is ESM and pipeline/src/ is CommonJS and they cannot import each other,
  // so the file exists twice. A lock only works if every writer runs the same
  // protocol, so the two copies have to be the same text — which is why the
  // helper imports nothing but node builtins.
  const esm = readFileSync(join(ROOT, "src/lib/json-store-lock.ts"), "utf8");
  const cjs = readFileSync(join(ROOT, "pipeline/src/lib/json-store-lock.ts"), "utf8");
  check(esm === cjs, "src/lib/json-store-lock.ts and pipeline/src/lib/json-store-lock.ts are identical",
    esm === cjs ? `${esm.length} bytes` : "they have drifted apart");
  check(!/from "\.\.?\//.test(esm), "and it imports nothing but node builtins, so they can stay identical");

  const register = readFileSync(join(ROOT, "pipeline/src/lib/artifact-register.ts"), "utf8");
  const storage = readFileSync(join(ROOT, "src/project-knowledge/storage.ts"), "utf8");
  check(!/`\$\{path\}\.tmp`/.test(register) && !/`\$\{path\}\.tmp`/.test(storage),
    "neither writer stages through a fixed <store>.tmp any more");
  check(/withJsonStoreLock/.test(register) && /withJsonStoreLock/.test(storage),
    "and both take the lock");
  const service = readFileSync(join(ROOT, "src/project-knowledge/service.ts"), "utf8");
  check(/withJsonStoreLock\(\s*this\.storage\.paths\.knowledgeArtifacts/.test(service),
    "saveArtifact holds the lock across the READ too — a write-only lock still loses rows");
}

// ───────────────────────────────────────── a project the pipeline will register into

function makeProject(label) {
  // realpath, because the child's cwd is canonical and the paths this test hands
  // it must be too — otherwise the row it writes is about a file "outside" the
  // project and the assertion below would be testing the test.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `c64re-conc-${label}-`)));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  // registerCliArtifact keys "am I inside a project" on knowledge/phase-plan.json.
  writeFileSync(join(dir, "knowledge", "phase-plan.json"), JSON.stringify({ schemaVersion: 1, phases: [] }, null, 2));
  mkdirSync(join(dir, "artifacts", "prg"), { recursive: true });
  return dir;
}

/** A real PRG: load $C000, `LDA #$01 / STA $D020 / RTS`, padded so the analyser has work. */
function writePrg(path, pad) {
  writeFileSync(path, Buffer.from([0x00, 0xc0, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60, ...new Array(pad).fill(0xea)]));
}

function runPipeline(projectDir, args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [pipelineCli, ...args], {
      cwd: projectDir,
      env: { ...process.env, C64RE_PROJECT_DIR: projectDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr, startedAt, endedAt: Date.now() }));
  });
}

const readStore = (dir) => {
  const path = join(dir, "knowledge", "artifacts.json");
  if (!existsSync(path)) return { items: [] };
  return JSON.parse(readFileSync(path, "utf8"));
};

// ───────────────────────────────────────── 1. eight children, all at once

{
  head(1, "eight pipeline children register at the same moment and all eight land");
  const N = 8;
  const proj = makeProject("many");
  const expected = [];
  for (let i = 0; i < N; i += 1) {
    const prg = join(proj, "artifacts", "prg", `p${i}.prg`);
    writePrg(prg, 700 + i);
    expected.push(`artifacts/prg/p${i}_analysis.json`);
  }

  // Every child is spawned before any of them is awaited, so they overlap for
  // real. `spawn` returns before the process has done anything, and the
  // timestamps below turn that from an assumption into an assertion.
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) => runPipeline(proj, [
      "analyze-prg",
      join(proj, "artifacts", "prg", `p${i}.prg`),
      join(proj, "artifacts", "prg", `p${i}_analysis.json`),
    ])),
  );

  const lastStart = Math.max(...runs.map((r) => r.startedAt));
  const firstEnd = Math.min(...runs.map((r) => r.endedAt));
  check(lastStart < firstEnd,
    `all ${N} children were running at the same instant — the test is a concurrency test`,
    `last spawn +${lastStart - Math.min(...runs.map((r) => r.startedAt))} ms, first exit +${firstEnd - Math.min(...runs.map((r) => r.startedAt))} ms`);

  const crashed = runs.filter((r) => r.code !== 0);
  check(crashed.length === 0, `no child failed`, crashed.map((r) => r.stderr.split("\n")[0]).join(" | ") || `${N} exited 0`);
  const enoent = runs.filter((r) => /ENOENT/.test(r.stderr));
  check(enoent.length === 0, "no child hit ENOENT renaming its staging file into place",
    enoent.map((r) => (r.stderr.match(/ENOENT[^\n]*/) ?? [""])[0]).join(" | ") || "none");
  check(runs.every((r) => !/NOT REGISTERED/.test(r.stderr)), "and none of them reported a registration it could not make");

  // The sharp one. Without a lock across the read every child reads a store
  // that has nobody else's row in it and writes its own back, so the file ends
  // up with one row — and nothing anywhere says the other seven were lost.
  const store = readStore(proj);
  const landed = expected.filter((rel) => store.items.some((item) => item.relativePath === rel));
  check(landed.length === N, `all ${N} registrations are in knowledge/artifacts.json`,
    `${landed.length}/${N} — missing: ${expected.filter((r) => !landed.includes(r)).join(", ") || "none"}`);

  // And nothing was left lying around.
  const litter = readdirSync(join(proj, "knowledge")).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
  check(litter.length === 0, "no staging or lock file survives the run", litter.join(", ") || "clean");
  rmSync(proj, { recursive: true, force: true });
}

// ───────────────────────────────────────── 2. two rounds against a store that already has rows

{
  head(2, "a second wave appends to the first rather than replacing it");
  const N = 6;
  const proj = makeProject("waves");
  for (let i = 0; i < N * 2; i += 1) writePrg(join(proj, "artifacts", "prg", `w${i}.prg`), 300 + i);

  const wave = (from) => Promise.all(
    Array.from({ length: N }, (_, i) => runPipeline(proj, [
      "analyze-prg",
      join(proj, "artifacts", "prg", `w${from + i}.prg`),
      join(proj, "artifacts", "prg", `w${from + i}_analysis.json`),
    ])),
  );

  await wave(0);
  const afterFirst = readStore(proj).items.length;
  await wave(N);
  const afterSecond = readStore(proj).items.length;
  check(afterFirst === N, `the first wave left ${N} rows`, `${afterFirst}`);
  check(afterSecond === N * 2, `the second wave left ${N * 2}, so the first wave's rows survived it`, `${afterSecond}`);
  rmSync(proj, { recursive: true, force: true });
}

// ───────────────────────────────────────── 3. a failure is a failure, out loud

{
  head(3, "a registration that cannot be made is said out loud");
  const proj = makeProject("broken");
  const prg = join(proj, "artifacts", "prg", "x.prg");
  writePrg(prg, 64);

  // Force the store write to fail in the one place it matters, with no
  // permission games: put a DIRECTORY where artifacts.json goes. The staging
  // write succeeds, the rename onto a directory does not.
  mkdirSync(join(proj, "knowledge", "artifacts.json"), { recursive: true });

  const run = await runPipeline(proj, ["analyze-prg", prg, join(proj, "artifacts", "prg", "x_analysis.json")]);
  check(existsSync(join(proj, "artifacts", "prg", "x_analysis.json")), "the analysis the command was asked for is still written");
  check(/NOT REGISTERED/.test(run.stderr), "the failure is reported as a failure, not as a line in the middle of a success",
    run.stderr.split("\n").find((l) => /NOT REGISTERED/.test(l)) ?? run.stderr.slice(0, 120));
  check(/project_inventory_sync/.test(run.stderr), "and it names the way out", "project_inventory_sync");
  check(!/\bskipped\b/i.test(run.stderr), "the word is not 'skipped' — skipping is a decision, this was a failure");
  check(!/ {4}at |node:internal/.test(run.stderr), "with no node stack trace in it", run.stderr.split("\n").find((l) => /\bat /.test(l)) ?? "none");
  rmSync(proj, { recursive: true, force: true });
}

// ───────────────────────────────────────── 4. …and on the MCP side of the same store

{
  head(4, "an MCP door says so too, before it says anything else");
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "c64re-conc-mcp-")));
  const proc = spawn(process.execPath, [mcpCli], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return (r.result?.content || []).map((c) => c.text).join("\n");
  };

  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-store-concurrency", version: "1" } });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await call("project_init", { name: "storeconcurrency" });
    await call("agent_onboard", {});

    // Same forced failure, on the other writer of the same file.
    rmSync(join(proj, "knowledge", "artifacts.json"), { force: true });
    mkdirSync(join(proj, "knowledge", "artifacts.json"), { recursive: true });

    const answer = await call("extract_disk", { image_path: join(ROOT, "samples/fixtures/load-fidelity/lf-002-5block.d64") });
    const firstLine = answer.split("\n")[0];
    check(/NOT REGISTERED/.test(firstLine), "the banner is the FIRST thing the door says", firstLine.slice(0, 110));
    check(!/registration skipped/i.test(answer), "the old 'registration skipped' wording is gone");
    check(/project_inventory_sync/.test(answer), "and the answer names the way out");
    check(/Extraction complete/.test(answer), "while still reporting what it did write — the bytes did land");
  } catch (error) {
    failCount += 1;
    console.log(`  FAIL  the MCP half threw: ${error.message}`);
  } finally {
    proc.stdin.end();
    proc.kill();
  }
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} store concurrency: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
