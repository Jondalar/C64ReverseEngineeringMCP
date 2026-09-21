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
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ───────────────────────────────────────── 5. the GRAPH under the same treatment
//
// The JSON stores got a cross-process lock; knowledge/graph.sqlite did not, and it
// showed: with four subagents writing at once, one open came back
//
//   ERR_SQLITE_ERROR: database is locked
//     at new GraphStore (dist/knowledge-graph/store.js:42)
//
// and a single retry cured it. Line 42 is `PRAGMA journal_mode = WAL`, and that is
// the whole story: switching the journal mode takes an EXCLUSIVE lock and SQLite
// does not run the busy handler for it, so the connection's 5 s timeout buys
// nothing. Every open of every writer tried the switch, whether or not the file
// was already WAL.
//
// 5a is deterministic — somebody else holds the file and the mode is not WAL yet,
// which is exactly the race four subagents create between them. 5b is the real
// one: eight writer processes, proved from their own timestamps to have been alive
// together.

{
  const { GraphStore } = await import(pathToFileURL(join(ROOT, "dist/knowledge-graph/store.js")).href);

  const makeGraphProject = (label) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `c64re-graph-${label}-`)));
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: "graphconc", slug: "gc" }));
    return dir;
  };
  const node = (owner, addr) => ({
    id: `gc:ram/${owner}:routine:${addr.toString(16).padStart(4, "0")}`,
    kind: "routine", name: `r_${addr.toString(16)}`, origin: "static", confidence: "certain",
  });

  head("5a", "a writer opens a graph somebody else is holding, in a mode that is not WAL yet");
  {
    const dir = makeGraphProject("hold");
    { const s = GraphStore.open(dir); s.replaceGenerated("seed", "seed", [node("seed", 0x1000)], []); s.close(); }
    // Put it back into rollback-journal mode: the state every graph is in before the
    // first writer has managed the switch.
    const raw = `
      const { createRequire } = await import("node:module");
      const db = createRequire(import.meta.url)("node:sqlite");
      const h = new db.DatabaseSync(process.argv[1]);
      h.exec("PRAGMA journal_mode = DELETE;");
      h.close();
    `;
    await new Promise((res) => spawn(process.execPath, ["--input-type=module", "-e", raw, "--", join(dir, "knowledge", "graph.sqlite")], { stdio: "ignore" }).on("exit", res));

    // A holds a WRITE transaction for 1200 ms — one producer mid-`replaceGenerated`.
    // The journal_mode switch wants EXCLUSIVE, cannot have it, and SQLite does not
    // run the busy handler for a journal_mode change, so the other open dies on the
    // spot however long its timeout is.
    const holder = `
      const { createRequire } = await import("node:module");
      const db = createRequire(import.meta.url)("node:sqlite");
      const h = new db.DatabaseSync(process.argv[1], { timeout: 5000 });
      h.exec("BEGIN IMMEDIATE");
      h.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('holder','1')");
      console.log("HOLDING");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      h.exec("COMMIT");
      h.close();
    `;
    const holderProc = spawn(process.execPath, ["--input-type=module", "-e", holder, "--", join(dir, "knowledge", "graph.sqlite")], { stdio: ["ignore", "pipe", "ignore"] });
    const holderExit = new Promise((res) => holderProc.on("exit", res));
    await new Promise((res) => holderProc.stdout.on("data", (d) => { if (/HOLDING/.test(d.toString())) res(); }));

    const writerSrc = `
      const { GraphStore } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist/knowledge-graph/store.js")).href)});
      const s = GraphStore.open(process.argv[1]);
      s.replaceGenerated("held", "held", [{ id: "gc:ram/held:routine:2000", kind: "routine", name: "r", origin: "static", confidence: "certain" }], []);
      s.close();
      console.log("WROTE");
    `;
    const w = await new Promise((res) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", writerSrc, "--", dir], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("exit", (code) => res({ code, out, err }));
    });
    await holderExit;
    check(w.code === 0, "the writer did not die of `database is locked` on the journal-mode switch",
      w.code === 0 ? "exit 0" : (w.err.split("\n").find((l) => /Error|ERR_/.test(l)) ?? `exit ${w.code}`));
    check(/WROTE/.test(w.out), "…and its rows actually landed", w.out.trim() || "nothing written");
    const s = GraphStore.open(dir, { readOnly: true });
    const n = Number(s.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner = 'held'").get().n);
    s.close();
    check(n === 1, "the row is in the graph", `${n}`);
    rmSync(dir, { recursive: true, force: true });
  }

  head("5b", "eight writers CREATE and fill one graph at the same moment, six times over");
  {
    const N = 8;
    const TRIALS = 6;
    const src = `
      const { GraphStore } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist/knowledge-graph/store.js")).href)});
      const [dir, tag, rounds] = process.argv.slice(1);
      for (let i = 0; i < Number(rounds); i += 1) {
        const s = GraphStore.open(dir);
        s.replaceGenerated("race-" + tag, tag + "-" + i, [{
          id: "gc:ram/" + tag + ":routine:" + (0x2000 + i).toString(16).padStart(4, "0"),
          kind: "routine", name: tag + "_" + i, origin: "static", confidence: "certain",
        }], []);
        s.upsertHuman({ id: "gc:ram/" + tag + ":routine:" + (0x2000 + i).toString(16).padStart(4, "0"), kind: "routine", name: "h" + i, origin: "user", confidence: "user_asserted" });
        s.close();
      }
    `;
    const ROUNDS = 12;
    const runOne = (dir, tag) => new Promise((res) => {
      const startedAt = Date.now();
      const p = spawn(process.execPath, ["--input-type=module", "-e", src, "--", dir, tag, String(ROUNDS)], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("exit", (code) => res({ tag, code, err, startedAt, endedAt: Date.now() }));
    });

    // A fresh project per trial, so the graph does not exist when the eight start:
    // the create race is where the journal-mode switch collides, and a graph that
    // is already WAL has nothing left to race over.
    let overlapped = 0, died = [], locked = [], rowsOk = 0, humanOk = 0, modes = new Set();
    for (let t = 0; t < TRIALS; t += 1) {
      const dir = makeGraphProject(`race${t}`);
      // Every child is spawned before any is awaited; the timestamps turn the overlap
      // from an assumption into an assertion, the way section 1 does.
      const runs = await Promise.all(Array.from({ length: N }, (_, i) => runOne(dir, `w${i}`)));
      const firstStart = Math.min(...runs.map((r) => r.startedAt));
      const lastStart = Math.max(...runs.map((r) => r.startedAt));
      const firstEnd = Math.min(...runs.map((r) => r.endedAt));
      if (lastStart < firstEnd) overlapped += 1;
      died.push(...runs.filter((r) => r.code !== 0).map((r) => (r.err.match(/(?:Error|ERR_SQLITE_ERROR)[^\n]*/) ?? [`exit ${r.code}`])[0]));
      locked.push(...runs.map((r) => (r.err.match(/database is locked[^\n]*/) ?? [""])[0]).filter(Boolean));
      try {
        const s = GraphStore.open(dir, { readOnly: true });
        if (Number(s.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'generated'").get().n) === N * ROUNDS) rowsOk += 1;
        if (Number(s.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human'").get().n) === N * ROUNDS) humanOk += 1;
        modes.add(String(s.db.prepare("PRAGMA journal_mode").get().journal_mode ?? "").toLowerCase());
        s.close();
      } catch (e) { died.push(`readback: ${e.message}`); }
      rmSync(dir, { recursive: true, force: true });
    }
    check(overlapped === TRIALS, `in all ${TRIALS} trials the ${N} writers were alive at the same instant — these are concurrency tests`, `${overlapped}/${TRIALS}`);
    check(died.length === 0, `no writer died on the graph in ${TRIALS} × ${N} runs`, died.slice(0, 3).join(" | ") || `${TRIALS * N} exited 0`);
    check(locked.length === 0, "and nothing anywhere said `database is locked`", locked.slice(0, 3).join(" | ") || "clean");
    check(rowsOk === TRIALS, `every generated row of all ${N} writers is in the graph, every trial`, `${rowsOk}/${TRIALS} × ${N * ROUNDS}`);
    check(humanOk === TRIALS, "and every human row too — no lost update", `${humanOk}/${TRIALS}`);
    check(modes.size === 1 && modes.has("wal"), "every graph ended up in WAL, which is what makes readers never block", [...modes].join(","));
  }

  head("5c", "readers through the same race, and the one shape that still loses it");
  {
    // What the WRITERS can fix is now fixed; what is left is the reader's own busy
    // timeout. In WAL mode a reader is not blocked by a writer, but the last
    // connection to close checkpoints and unlinks the -wal under an EXCLUSIVE lock,
    // and a reader that opens in that window and has no timeout simply loses. The
    // two shapes below are run side by side so the difference is measured, not
    // argued: everything under src/ opens through GraphStore, which passes one.
    const graphSrc = readFileSync(join(ROOT, "src/knowledge-graph/store.ts"), "utf8");
    check(/new DatabaseSync\(path, \{ readOnly, timeout: BUSY_TIMEOUT_MS \}\)/.test(graphSrc),
      "GraphStore gives EVERY connection a busy timeout, read-only ones included");
    check(/PRAGMA busy_timeout[\s\S]{0,200}ensureWal/.test(graphSrc),
      "…and sets it before it touches the journal mode, which the busy handler does not cover");

    const dir = makeGraphProject("reader");
    { const s = GraphStore.open(dir); s.replaceGenerated("seed", "seed", [node("seed", 0x1000)], []); s.close(); }
    const graphFile = join(dir, "knowledge", "graph.sqlite");
    // `timeout: null` = exactly pipeline/src/analysis/graph-reader.ts: existsSync,
    // then `new DatabaseSync(path, { readOnly: true })`. That file belongs to another
    // agent and is not touched here; this measures what it costs.
    const readerSrc = (timeout) => `
      const { existsSync } = await import("node:fs");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const [path, rounds] = process.argv.slice(1);
      let errs = 0, reads = 0, last = "";
      for (let i = 0; i < Number(rounds); i += 1) {
        if (!existsSync(path)) continue;
        reads += 1;
        try {
          const db = new DatabaseSync(path, ${timeout === null ? "{ readOnly: true }" : `{ readOnly: true, timeout: ${timeout} }`});
          db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer = '820'").get();
          db.close();
        } catch (e) { errs += 1; last = String(e && e.message); }
      }
      console.log("READ errors=" + errs + "/" + reads + " last=" + last);
    `;
    const writerSrc = `
      const { GraphStore } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist/knowledge-graph/store.js")).href)});
      const [dir, tag, rounds] = process.argv.slice(1);
      for (let i = 0; i < Number(rounds); i += 1) {
        const s = GraphStore.open(dir);
        s.replaceGenerated("rd-" + tag, tag + "-" + i, [{ id: "gc:ram/" + tag + ":routine:" + (0x3000 + i).toString(16), kind: "routine", name: tag, origin: "static", confidence: "certain" }], []);
        s.close();
      }
    `;
    const spawnOne = (src, args) => new Promise((res) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", src, "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("exit", (code) => res({ code, out, err }));
    });
    const errsOf = (rows) => rows.reduce((a, r) => a + Number((r.out.match(/errors=(\d+)/) ?? [0, 0])[1]), 0);
    const readsOf = (rows) => rows.reduce((a, r) => a + Number((r.out.match(/errors=\d+\/(\d+)/) ?? [0, 0])[1]), 0);
    const res = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => spawnOne(writerSrc, [dir, `w${i}`, "12"])),
      ...Array.from({ length: 4 }, () => spawnOne(readerSrc(5000), [graphFile, "60"])),
      ...Array.from({ length: 4 }, () => spawnOne(readerSrc(null), [graphFile, "60"])),
    ]);
    const timed = res.slice(4, 8);
    const untimed = res.slice(8, 12);
    check(errsOf(timed) === 0, `four readers WITH a busy timeout through the whole race: no ERR_SQLITE_ERROR (${readsOf(timed)} reads)`,
      timed.map((r) => r.out.trim()).join(" | "));
    // The untimed shape is kept as the CONTROL, not as a residual: it is what the
    // pipeline's reader used to be, and it is why the argument below is asserted. The
    // race does not fire on every run, so its error count is reported and never asserted
    // — a green here would otherwise mean "the race did not happen", not "it is fixed".
    const lost = errsOf(untimed);
    console.log(`  note   the same reader with NO busy timeout lost ${lost} of ${readsOf(untimed)} reads`
      + `\n         side by side here: ${errsOf(timed)} errors with a timeout, ${lost} without.`);
    // The one shape outside GraphStore. pipeline/ cannot import it, so the argument is
    // asserted from the source instead of inherited.
    const readerSrcFile = readFileSync(new URL("../pipeline/src/analysis/graph-reader.ts", import.meta.url), "utf8");
    const opens = [...readerSrcFile.matchAll(/new DatabaseSync\([^)]*\)/gu)].map((m) => m[0]);
    check(opens.length > 0 && opens.every((o) => /timeout:\s*\d+/u.test(o)),
      "the pipeline's own graph reader opens with a busy timeout too — the one connection GraphStore does not make",
      opens.join(" | ") || "(no DatabaseSync open found)");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} store concurrency: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
