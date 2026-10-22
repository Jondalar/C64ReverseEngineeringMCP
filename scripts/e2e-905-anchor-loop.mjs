#!/usr/bin/env node
// The anchor doors, and the winner into the build. (The runs of fixes from an anchor — baseline beside variants, inputs,
// the verdicts — are the feature file's now: e2e-911-variants, e2e-911-door, e2e-911-candidate.)
//
//   S1 name the instant            anchor set/list/drop disturb nothing; listed with cycle + frame; recorded in the graph
//   S2 go back to it               goto moves the shared machine and pauses it there; the description says so
//   S6 the winner goes into build  verify_build green, and red naming the first differing address (PRG, CRT), on a record
//                                  as the old runner left it (inputs + cycle budget, no feature file)
//   S7 the old door is gone        runtime/candidate_* refused by name pointing at sandbox/runMany; no tool calls it
//   S8 refusals are the daemon's   the 33rd anchor is refused with the daemon's text
//
// S6 and the descriptions need no daemon and run everywhere (the Linux CI job included). Everything else
// starts a trx64-daemon of this run's own on a free port with a temp project and ends it; it SKIPS LOUDLY
// when there is no daemon binary. Nothing here touches :4312 or the owner's session.
//   Locally:  C64RE_RUNTIME_BIN=../TRX64/target/release/trx64-daemon npm run e2e:905
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { prgWithStub } from "./lib/asm6502-mini.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const load = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

let pass = 0, fail = 0;
const waits = [];
let tag = "";
const check = (c, m, d = "") => {
  if (c) pass++; else { fail++; if (tag) waits.push(`${tag} ${m}`); }
  console.log(`  ${c ? "PASS" : "FAIL"}  ${tag && !c ? `${tag} ` : ""}${m}${!c && d !== "" ? `  (${String(d).slice(0, 700)})` : ""}`);
};
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sha = (s) => createHash("sha256").update(s).digest("hex");

const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
const store = await load("candidates/store.js");
const anchorsGraph = await load("anchors/graph.js");
const { resolveDaemonSpawn: resolveDaemonSpawnFor905 } = await load("runtime/resolve-daemon-spawn.js");

const SANDBOX = testTmpDir("c64re-905-");
const cleanups = [];
process.on("exit", () => { for (const f of cleanups.reverse()) { try { f(); } catch { /* gone */ } } try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ } });

function newProject(name) {
  const dir = join(SANDBOX, name);
  mkdirSync(dir, { recursive: true });
  new ProjectKnowledgeService(dir).initProject({ name });
  return dir;
}

/** An MCP session of this repo over stdio against `endpoint`, in `projectDir`. */
async function mcpFor(projectDir, endpoint) {
  const m = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_AUTOSTART: "0", C64RE_STATE_DIR: join(SANDBOX, "state"), ...(endpoint ? { C64RE_RUNTIME_ENDPOINT: endpoint } : {}) } });
  cleanups.push(() => m.stop());
  await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-905", version: "1" } });
  await m.call("agent_onboard", {});
  const tools = (await m.rpc("tools/list", {})).result?.tools ?? [];
  return { call: m.call, stop: m.stop, tools, desc: (n) => tools.find((t) => t.name === n)?.description ?? "" };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The surface: needs no daemon
// ───────────────────────────────────────────────────────────────────────────────────────────────
head("the doors, their descriptions and the retired names (no daemon)");
const projA = newProject("surface");
const mA = await mcpFor(projA);
for (const n of ["runtime_anchor_set", "runtime_anchor_list", "runtime_anchor_drop", "runtime_anchor_goto", "runtime_feature_run", "runtime_candidate_list", "runtime_candidate_choose", "runtime_candidate_derive_delta", "runtime_candidate_verify_build", "runtime_candidate_delete"]) {
  check(mA.tools.some((t) => t.name === n), `${n} is on the default surface`);
}
{
  const d = mA.desc("runtime_anchor_goto");
  check(/MOVES the shared machine/.test(d) && /human/.test(d), "S2: runtime_anchor_goto's description says it moves the shared machine the human watches");
  check(/not move, pause or change the machine/.test(mA.desc("runtime_anchor_set")), "runtime_anchor_set's description says it disturbs nothing");
  check(/LABEL in a trace, not an anchor/.test(mA.desc("runtime_mark")) && /runtime_anchor_set/.test(mA.desc("runtime_mark")), "runtime_mark's description says it is not an anchor and points at runtime_anchor_set");
  check(/shared machine is not touched/.test(mA.desc("runtime_feature_run")), "runtime_feature_run's description says the shared machine is not touched");
  check(/an anchor's name is refused/.test(mA.desc("runtime_checkpoint_unpin")), "unpin's description says a name is refused (measured below)");
}
for (const gone of ["runtime_candidate_create", "runtime_candidate_variant", "runtime_candidate_run", "runtime_candidate_patch", "runtime_candidate_remove_patch"]) {
  check(!mA.tools.some((t) => t.name === gone), `${gone} is not on the surface any more (the feature file replaced it)`);
}
for (const [old, succ] of [["runtime_candidate_export", "runtime_candidate_list"]]) {
  const a = await mA.call(old, { session_id: "shared", id: "x", addr: 49152 });
  check(a.includes(succ) && a.split("\n").filter((l) => l.trim()).length === 1 && /Nothing was done/.test(a), `${old} answers in one line naming ${succ}`, a);
}
const toolSources = ["server-tools/anchor-tools.js", "server-tools/candidate-tools.js", "server-tools/runtime.js", "server-tools/headless.js", "candidates/store.js", "candidates/variant.js", "candidates/verify.js", "anchors/graph.js"];
check(toolSources.every((f) => !/runtime\/candidate_/.test(readFileSync(join(ROOT, "dist", f), "utf8"))), "S7: no tool or library module calls runtime/candidate_* (the one remaining mention is the C64U bridge's refusal list)");
mA.stop();

// ───────────────────────────────────────────────────────────────────────────────────────────────
// S6 — the winner goes into the build (no daemon: a project, a chosen variant, a build command)
// ───────────────────────────────────────────────────────────────────────────────────────────────
head("S6  the winner goes into the build — GREEN, and RED naming the first differing address");
{
  const proj = newProject("s6");
  // The candidate as a daemon-less run leaves it: an anchor, three variants, the second chosen.
  const v2 = [0xa9, 0x01, 0x8d, 0x00, 0xc1, 0x60]; // lda #$01 / sta $c100 / rts
  store.saveCandidate(proj, {
    id: "cand-1", anchor: "vor_level3", inputs: [], cycleBudget: 100000, createdAt: new Date().toISOString(), updatedAt: "",
    variants: [
      { name: "v1", targets: [{ space: "ram", addr: 0xc000, source: "", bytes: [0xea, 0xea] }] },
      { name: "v2", targets: [{ space: "ram", addr: 0xc100, source: "", bytes: v2 }, { space: "ram", addr: 0xc200, source: "", bytes: [0x60] }] },
      { name: "v3", targets: [{ space: "ram", addr: 0xc300, source: "", bytes: [0x00] }] },
    ],
  });
  const m = await mcpFor(proj);
  // the project's build: a script that writes the image from the file the project wires the delta into
  const wired = join(proj, "wired.json");
  writeFileSync(join(proj, "build.mjs"), `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const w = JSON.parse(readFileSync("wired.json", "utf8"));
mkdirSync("out", { recursive: true });
if (w.parts.length > 0) {
  const lo = Math.min(...w.parts.map((p) => p.addr)), hi = Math.max(...w.parts.map((p) => p.addr + p.bytes.length));
  const img = new Uint8Array(hi - lo).fill(0xaa);
  for (const p of w.parts) img.set(p.bytes, p.addr - lo);
  writeFileSync("out/game.prg", Buffer.from([lo & 255, lo >> 8, ...img]));
}
if (w.crt) {
  const bank = Buffer.alloc(0x2000, 0xff); for (const p of w.crt) Buffer.from(p.bytes).copy(bank, p.addr - 0x8000);
  const h = Buffer.alloc(0x40); h.write("C64 CARTRIDGE   ", 0, "ascii"); h.writeUInt32BE(0x40, 0x10); h.writeUInt16BE(0x100, 0x14); h.writeUInt16BE(32, 0x16);
  const chip = Buffer.alloc(0x10); chip.write("CHIP", 0, "ascii"); chip.writeUInt32BE(0x10 + 0x2000, 4); chip.writeUInt16BE(2, 8); chip.writeUInt16BE(w.crtBank, 10); chip.writeUInt16BE(0x8000, 12); chip.writeUInt16BE(0x2000, 14);
  writeFileSync("out/game.crt", Buffer.concat([h, chip, bank]));
}
`);
  const svc = new ProjectKnowledgeService(proj);
  svc.saveProjectProfile({ build: { command: "node build.mjs", outputs: ["out/game.prg"] } });
  const wire = (parts, extra = {}) => writeFileSync(wired, JSON.stringify({ parts, ...extra }));
  const variantParts = [{ addr: 0xc100, bytes: v2 }, { addr: 0xc200, bytes: [0x60] }];

  const noChoice = await m.call("runtime_candidate_verify_build", { id: "cand-1" });
  check(/no chosen variant/.test(noChoice), "verify_build before a variant is chosen says so", noChoice);
  const noDelta = await m.call("runtime_candidate_derive_delta", { id: "cand-1" });
  check(/no chosen variant/.test(noDelta), "derive_delta before a variant is chosen says so");
  const ch = await m.call("runtime_candidate_choose", { id: "cand-1", variant: "v2" });
  check(/"v2" chosen/.test(ch), "variant 2 is marked as the solution", ch);
  const dd = await m.call("runtime_candidate_derive_delta", { id: "cand-1" });
  const deltaDir = join(proj, "delta-cand-1");
  const manifest = JSON.parse(readFileSync(join(deltaDir, "delta-manifest.json"), "utf8"));
  check(manifest.patchCount === 2 && existsSync(join(deltaDir, "DELTA.md")), "the delta is written: one .asm per target + manifest + DELTA.md", dd);
  check(/\* = \$c100/.test(readFileSync(join(deltaDir, manifest.patches[0].file), "utf8")) && /\.byte \$a9,\$01,\$8d,\$00,\$c1,\$60/.test(readFileSync(join(deltaDir, manifest.patches[0].file), "utf8")), "…a target without source is written as its bytes under its own org");
  const cand1 = store.loadCandidate(proj, "cand-1");
  check(cand1.delta?.artifactIds.length === 4, "…its files are registered as artifacts and linked to the candidate", JSON.stringify(cand1.delta?.artifactIds));
  const arts = new ProjectKnowledgeService(proj).listArtifacts().filter((a) => a.tags.includes("candidate:cand-1"));
  check(arts.length === 4 && arts.every((a) => a.role === "candidate-delta"), "…and the artifact store holds them under the candidate's tag", String(arts.length));

  // GREEN: the build contains the winner's bytes at every target
  wire(variantParts);
  const green = await m.call("runtime_candidate_verify_build", { id: "cand-1" });
  check(/^GREEN/.test(green) && /ram \$c100  6 byte\(s\)  ok/.test(green) && /ram \$c200  1 byte\(s\)  ok/.test(green) && /built just now/.test(green), "S6 GREEN: the built PRG holds variant 2's bytes at every target address, each target named", green);
  check(store.loadCandidate(proj, "cand-1").build?.ok === true, "…and the verdict is kept in the candidate");

  // RED: one byte differs — the first differing address is named
  wire([{ addr: 0xc100, bytes: v2 }, { addr: 0xc200, bytes: [0xea] }]);
  const red = await m.call("runtime_candidate_verify_build", { id: "cand-1" });
  check(/^RED/.test(red) && /First differing address: \$c200 — built \$ea, the variant has \$60/.test(red) && /ram \$c100  6 byte\(s\)  ok/.test(red) && /ram \$c200  1 byte\(s\)  DIFFERS/.test(red), "S6 RED: a build without the solution is reported as not containing it, naming the first differing address", red);
  // RED: the target is not in the image at all
  wire([{ addr: 0xc100, bytes: v2 }]);
  const missing = await m.call("runtime_candidate_verify_build", { id: "cand-1" });
  check(/^RED/.test(missing) && /First differing address: \$c200 — the PRG covers \$c100-\$c105; this address is outside it/.test(missing), "…a target outside the image is red too, saying what the image covers", missing);
  // the build itself fails: said, not guessed
  const goodScript = readFileSync(join(proj, "build.mjs"), "utf8");
  writeFileSync(join(proj, "build.mjs"), "process.exit(3)");
  const broke = await m.call("runtime_candidate_verify_build", { id: "cand-1" });
  writeFileSync(join(proj, "build.mjs"), goodScript);
  check(/^BUILD FAILED \(exit 3\)/.test(broke) && /image was not checked/.test(broke), "a build that fails is reported as failed, the image is not checked", broke);
  // an image that is not there
  const gone = await m.call("runtime_candidate_verify_build", { id: "cand-1", image: "out/nope.prg", skip_build: true });
  check(/does not exist/.test(gone), "a missing image is said to be missing", gone);

  // a cartridge image, bank by bank
  {
    const c = store.loadCandidate(proj, "cand-1");
    c.variants.push({ name: "cart", targets: [{ space: "roml", bank: 3, addr: 0x8100, source: "", bytes: [0x4c, 0x00, 0x90] }] });
    store.saveCandidate(proj, c);
  }
  await m.call("runtime_candidate_choose", { id: "cand-1", variant: "cart" });
  wire([], { crt: [{ addr: 0x8100, bytes: [0x4c, 0x00, 0x90] }], crtBank: 3 });
  const crtGreen = await m.call("runtime_candidate_verify_build", { id: "cand-1", image: "out/game.crt" });
  check(/^GREEN/.test(crtGreen) && /roml bank 3 \$8100  3 byte\(s\)  ok/.test(crtGreen) && /, crt,/.test(crtGreen), "a CRT image: GREEN reads bank 3's chip at the window address", crtGreen);
  wire([], { crt: [{ addr: 0x8100, bytes: [0x4c, 0x00, 0x90] }], crtBank: 4 });
  const crtRed = await m.call("runtime_candidate_verify_build", { id: "cand-1", image: "out/game.crt" });
  check(/^RED/.test(crtRed) && /roml bank 3 \$8100 — bank 3 has no chip covering \$8100/.test(crtRed), "…the same bytes in bank 4 are RED, naming the bank and the address", crtRed);

  // raw bytes need an address
  writeFileSync(join(proj, "out/raw.bin"), Buffer.from([0xaa, 0xaa, 0x4c, 0x00, 0x90]));
  const rawNo = await m.call("runtime_candidate_verify_build", { id: "cand-1", image: "out/raw.bin", skip_build: true, raw_load_address: 0x8000 });
  check(/^RED/.test(rawNo) && /holds RAM only|raw_load_address/.test(rawNo), "a raw image cannot hold a cartridge target: red, saying why", rawNo.slice(0, 300));

  m.stop();
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The runtime half
// ───────────────────────────────────────────────────────────────────────────────────────────────
const siblingExe = join(ROOT, "..", "TRX64", "target", "release", process.platform === "win32" ? "trx64-daemon.exe" : "trx64-daemon");
// The environment, then the sibling build, then whatever the product's own resolver finds — the
// pinned install a user (and CI, after `c64re runtime install`) has.
const resolved = (() => {
  try {
    const p = resolveDaemonSpawnFor905({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
    return p && !/\.m?js$/.test(p.cmd) && existsSync(p.cmd) ? p.cmd : undefined;
  } catch { return undefined; }
})();
const DAEMON = process.env.C64RE_RUNTIME_BIN && !/\.m?js$/.test(process.env.C64RE_RUNTIME_BIN) ? process.env.C64RE_RUNTIME_BIN : existsSync(siblingExe) ? siblingExe : resolved;
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("\nSKIPPED the runtime half (S1–S5, S7 with a daemon, S8) — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-905 (no-daemon half only): ${pass} pass, ${fail} fail.`);
  process.exit(fail === 0 ? 0 : 1);
}
console.log(`\nruntime: ${DAEMON}`);

/** A trx64-daemon of this run's own: free port, the given project, ended with the run. */
async function startDaemon(projectDir) {
  const port = await freePort();
  const child = spawn(DAEMON, ["--project", projectDir, "--port", String(port)], { stdio: "ignore" });
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
  cleanups.push(stop);
  for (let i = 0; i < 80; i++) {
    try { const ws = await wsOpen(port); ws.close(); break; } catch { await sleep(250); }
  }
  return { port, endpoint: `ws://127.0.0.1:${port}`, stop: async () => { stop(); await new Promise((r) => child.once("exit", r)); } };
}
const wsOpen = (port) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/?av=0`); ws.once("open", () => res(ws)); ws.once("error", rej); });
async function wsClient(port) {
  const ws = await wsOpen(port);
  let n = 1; const pend = new Map();
  ws.on("message", (m) => { const j = JSON.parse(String(m)); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const call = (method, params = {}) => new Promise((res) => { const id = n++; pend.set(id, res); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  return { call, close: () => ws.close() };
}

// The program under test. Joystick 2 fire is read every loop; the fire path counts at $C001, the
// loop counts at $C000. Layout: $080D sei · $080E lda $DC00 · $0811 and #$10 · $0813 bne · $0815 inc $C001
// · $0818 inc $C000 · $081B jmp $080E.
const PRG = prgWithStub(["SEI", "loop:", "LDA $DC00", "AND #$10", "BNE nofire", "INC $C001", "nofire:", "INC $C000", "JMP loop"]);
const FIRE_INC_OPERAND = 0x0816; // INC $C001's operand
const LOOP_INC_OPERAND = 0x0819; // INC $C000's operand
const BOOT_CYCLES = 300000;
const BUDGET = 200000;
const hex = (n) => `$${n.toString(16).padStart(4, "0")}`;

const proj = newProject("runtime");
const prgPath = join(proj, "t.prg");
writeFileSync(prgPath, PRG);

/** Bring the shared machine to the state the anchors are set on: the PRG running, paused after BOOT_CYCLES. */
async function bringUp(m) {
  await m.call("runtime_session_start", {});
  await m.call("runtime_run_prg", { session_id: "shared", prg_path: prgPath, run: "080d" });
  await m.call("runtime_session_run", { session_id: "shared", cycle_budget: BOOT_CYCLES, max_instructions: 10000000 });
}

/** Everything about the shared machine that "unchanged" has to mean: clock, registers, run state, all of RAM. */
async function shot(ws, m) {
  const st = (await ws.call("session/state", { session_id: "shared" })).result;
  const ram = await m.call("runtime_monitor_memory", { session_id: "shared", start: 0, end: 0xffff });
  return JSON.stringify({ cycles: st.c64Cycles, cpu: st.cpu, runState: st.runState, controlOwner: st.controlOwner, ram: sha(ram) });
}

let d1 = await startDaemon(proj);
let ws = await wsClient(d1.port);
let m = await mcpFor(proj, d1.endpoint);
await bringUp(m);
head("S1  name the instant");
const before1 = await shot(ws, m);
const setOut = await m.call("runtime_anchor_set", { name: "vor_level3", why: "just before level 3 loads" });
const after1 = await shot(ws, m);
const st0 = (await ws.call("session/state", { session_id: "shared" })).result;
check(/^ANCHOR vor_level3 — cycle \d+, frame \d+/.test(setOut), "the LLM sets anchor vor_level3", setOut);
check(before1 === after1, "the shared machine's cycles, registers, run state and RAM are byte-identical before and after set");
const lst = await m.call("runtime_anchor_list", {});
const anchorCycle = Number(/vor_level3\s+cycle (\d+)/.exec(lst)?.[1]);
check(anchorCycle === st0.c64Cycles && /vor_level3\s+cycle \d+\s+frame \d+/.test(lst), "it is listed with its cycle and frame — the cycle is the instant the machine was at", lst);
check((await shot(ws, m)) === before1, "list disturbs nothing");
{
  const rec = anchorsGraph.readAnchor(proj, "vor_level3");
  check(rec?.cycle === anchorCycle && rec?.why === "just before level 3 loads" && typeof rec?.frame === "number", "the project graph records the anchor: name, cycle, frame, why", JSON.stringify(rec));
}
const marks = (await ws.call("mark/list")).result;
check(marks.marks.some((x) => x.name === "vor_level3" && x.cycle === anchorCycle), "…and the runtime's own mark list agrees (workbench half: see smoke:905)");
const dup = await m.call("runtime_anchor_set", { name: "vor_level3" });
check(/refused by the runtime/.test(dup) && /already a mark/.test(dup), "setting the same name again is refused with the runtime's text", dup);
await m.call("runtime_anchor_set", { name: "tmp1" });
const dr = await m.call("runtime_anchor_drop", { name: "tmp1" });
check(/^DROPPED tmp1/.test(dr) && !/tmp1/.test(await m.call("runtime_anchor_list", {}).then((t) => t.split("Recorded in the project")[0])), "drop frees the name", dr);
check((await shot(ws, m)) === before1, "set, list and drop together left the shared machine untouched");
check(/refused by the runtime/.test(await m.call("runtime_anchor_drop", { name: "nope" })), "dropping an unknown anchor is the runtime's refusal");

head("S2  go back to it — and the doors that take a name");
await m.call("runtime_session_run", { session_id: "shared", cycle_budget: 150000, max_instructions: 10000000 });
const moved = (await ws.call("session/state", { session_id: "shared" })).result;
check(moved.c64Cycles > anchorCycle, "the machine has run on past the anchor", `${moved.c64Cycles} > ${anchorCycle}`);
const go = await m.call("runtime_anchor_goto", { name: "vor_level3" });
const atGo = (await ws.call("session/state", { session_id: "shared" })).result;
check(atGo.c64Cycles === anchorCycle && /paused here/.test(go), "goto: the machine stands at the anchor's cycle", `${atGo.c64Cycles} vs ${anchorCycle}`);
check(atGo.runState !== "running", "…and is paused", String(atGo.runState));
check((await m.call("runtime_anchor_goto", { name: "no_such" })).includes("refused by the runtime"), "goto an unknown name is the runtime's refusal");
// each door that takes an anchor id, measured with a name
{
  const cp = (name, id) => ws.call(name, { session_id: "shared", id }).then((r) => r);
  const pin = await m.call("runtime_checkpoint_pin", { session_id: "shared", id: "vor_level3" });
  check(/"pinned": true/.test(pin) || /vor_level3/.test(pin), "runtime_checkpoint_pin accepts the name", pin.slice(0, 200));
  const unpin = await m.call("runtime_checkpoint_unpin", { session_id: "shared", id: "vor_level3" });
  check(/unknown id/.test(unpin) || /# tool error/.test(unpin), "runtime_checkpoint_unpin refuses the name (an anchor holds its own pin; it is released with drop)", unpin.slice(0, 200));
  void cp;
  await m.call("runtime_session_run", { session_id: "shared", cycle_budget: 50000, max_instructions: 10000000 });
  const rs = await m.call("runtime_checkpoint_restore", { session_id: "shared", id: "vor_level3" });
  const afterRs = (await ws.call("session/state", { session_id: "shared" })).result;
  check(afterRs.c64Cycles === anchorCycle, "runtime_checkpoint_restore accepts the name and lands on the anchor's cycle", rs.slice(0, 200));
  await m.call("runtime_session_run", { session_id: "shared", cycle_budget: 50000, max_instructions: 10000000 });
  const ov = await m.call("runtime_overlay_run", { session_id: "shared", anchor_id: "vor_level3", patches: [{ addr: 0xc700, bytes: [1] }], run_cycles: 1000 });
  check(/"applied"/.test(ov) && !/error|unknown/i.test(ov.slice(0, 120)), "runtime_overlay_run accepts the name as anchor_id", ov.slice(0, 200));
}
// in replay (after a goto) an anchor is not set: the runtime would name the older checkpoint under the cursor and replace ITS name
await m.call("runtime_anchor_goto", { name: "vor_level3" });
{
  const inReplay = await m.call("runtime_anchor_set", { name: "while_replay" });
  const al = await m.call("runtime_anchor_list", {});
  check(/not set — the shared machine stands in replay/.test(inReplay) && /vor_level3/.test(al) && !/while_replay/.test(al.split("Recorded")[0]), "in replay a set is refused with the way out, and vor_level3 keeps its name", inReplay.slice(0, 300));
  const tot = (await ws.call("transport/status")).result.frameTotal;
  await m.call("runtime_monitor", { session_id: "shared", command: `goto ${tot}` });
  check((await ws.call("transport/status")).result.atHead === true, "…the way out (goto the last frame) brings the transport back to the head");
}

head("S8  refusals are the daemon's, verbatim");
{
  const have = (await ws.call("mark/list")).result.used;
  for (let i = have; i < 32; i++) {
    const r = await m.call("runtime_anchor_set", { name: `fill_${i}` });
    if (!/^ANCHOR/.test(r)) { check(false, `fill anchor ${i}`, r); break; }
  }
  const used = (await ws.call("mark/list")).result;
  check(used.used === 32, "32 anchors are set", String(used.used));
  const r33 = await m.call("runtime_anchor_set", { name: "the_33rd" });
  const daemonText = (await ws.call("mark/set", { name: "the_33rd_direct" })).error?.message ?? "";
  check(/refused by the runtime/.test(r33) && daemonText.length > 20 && r33.includes(daemonText.replace(/the_33rd_direct/g, "the_33rd")) || r33.includes(daemonText.replace("mark/set: ", "")), "the 33rd is refused with the daemon's own text, not an empty success", r33);
  check(/limit \(32\)/.test(r33), "…naming the limit", r33);
  check(!/^ANCHOR/.test(r33) && (await ws.call("mark/list")).result.used === 32, "…and nothing was set");
  for (let i = 0; i < 32; i++) await ws.call("mark/drop", { name: `fill_${i}` });
}

head("S7  the old door no longer exists in a form that moves the machine");
{
  const shotBefore = await shot(ws, m);
  const r = await ws.call("runtime/candidate_run", { id: "cand-1" });
  const msg = r.error?.message ?? JSON.stringify(r.result ?? {});
  check(r.error !== undefined && /candidate_run/.test(msg) && /sandbox\/runMany/.test(msg), "runtime/candidate_run is refused by name, pointing at sandbox/runMany", msg);
  const c = await ws.call("runtime/candidate_create", { anchor: "vor_level3" });
  check(c.error !== undefined && /sandbox\/runMany/.test(c.error.message ?? ""), "…runtime/candidate_create too", JSON.stringify(c).slice(0, 200));
  check(shotBefore === (await shot(ws, m)), "…and the shared machine did not move");
}

ws.close(); m.stop(); await d1.stop();
console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-905: ${pass} pass, ${fail} fail.`);
if (waits.length > 0) { console.log("\nFailing checks that wait on the TRX64 half:"); for (const w of waits) console.log(`  ${w}`); }
process.exit(fail === 0 ? 0 : 1);
