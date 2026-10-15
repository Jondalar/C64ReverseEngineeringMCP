#!/usr/bin/env node
// Issue #91 — a sandbox works on a COPY of the medium. Whatever the program writes to the disk, however the
// machine ends, the project's file is byte-identical afterwards.
//
// The runtime writes a mounted disk back to the file it was given (eject, persist, and on its way out). So the
// only thing that keeps a project's D64 safe is that no sandbox daemon is ever handed the project's path.
//
//   A  runtime_sandbox_run   ends while the program is still writing / after it wrote / a disk swapped in by `insert`
//   B  runtime_sandbox_start ended by runtime_sandbox_end / by the budget / by the idle limit / by the MCP process
//                            going away; and a disk mounted LATER with runtime_media_mount and the monitor's `mount`
//   C  runtime_scene_reel    the origin disk and a disk inserted by a step
//
// Every case also proves the sandbox DID write (the directory it lists shows the new file) — an untouched project
// file proves nothing about a program that never wrote. The disks and the "program" (BASIC typed at the prompt:
// `SAVE`) are made here; no third-party bytes.
//
//   C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:issue91-sandbox-media-copy
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d64WithPrg } from "./lib/d64-fixture.mjs";
import { Harness, ROOT, findDaemon, load, loopPrg, makeChecker, scratchDirs, sleep } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }

const T = makeChecker("e2e-issue91");
const { check, head } = T;
const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`runtime: ${DAEMON}`);

// A private temp dir for this run and every process it starts: the scratch check below scans the
// temp dir, and another gate or sandbox running on this machine at the same time makes its own
// c64re-reel-* there.
const ownTmp = mkdtempSync(join(tmpdir(), "c64re-91-tmp-"));
process.env.TMPDIR = ownTmp;
process.on("exit", () => { try { rmSync(ownTmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const scratchBefore = new Set(scratchDirs());
const H = new Harness("c64re-91-");
const proj = await H.project("proj");
const media = join(proj, "media");
mkdirSync(media, { recursive: true });
const disk = (name, tag) => {
  const p = join(media, name);
  writeFileSync(p, d64WithPrg(tag, loopPrg(), { diskName: tag }));
  return p;
};
const mcp = await H.mcp(proj, { env: { C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_BIN: DAEMON } });

// the "program": a BASIC line and a SAVE to drive 8, then the directory listed so the screen shows the new file
const SAVE = ['I wait 170 frames', 'I type "10 REM X{RETURN}"', 'I wait 20 frames', 'I type "SAVE{QUOTE}WROTE{QUOTE},8{RETURN}"'];
const LIST = ['I wait until the drive is idle within 3000 frames', 'I type "LOAD{QUOTE}$ {QUOTE},8{RETURN}"'.replace("$ ", "$"), 'I wait until the drive is idle within 3000 frames', 'I type "LIST{RETURN}"', 'I wait 60 frames'];
const sawWrite = (t) => /"WROTE\s*"/.test(t);
const stable = async () => { await sleep(1500); };

// ── A. runtime_sandbox_run ─────────────────────────────────────────────────────────────────────
head("A  runtime_sandbox_run");
{
  const d = disk("a-after.d64", "AFTER");
  const before = md5(d);
  const r = await mcp.call("runtime_sandbox_run", { media_path: d, steps: [...SAVE, ...LIST], budget_seconds: 240 });
  check(sawWrite(r), "the program wrote (the directory it lists holds WROTE)", r.slice(-900));
  check(md5(d) === before, "ended after writing: the project's disk is byte-identical");
}
{
  const d = disk("a-during.d64", "DURING");
  const before = md5(d);
  const r = await mcp.call("runtime_sandbox_run", { media_path: d, steps: [...SAVE, "I wait 40 frames"], budget_seconds: 240 });
  check(!/error|refused/i.test(r.slice(0, 200)), "the run answered", r.slice(0, 300));
  check(md5(d) === before, "ended while the program was still writing: byte-identical");
}
{
  const first = disk("a-first.d64", "FIRST");
  const second = disk("a-second.d64", "SECOND");
  const [b1, b2] = [md5(first), md5(second)];
  const r = await mcp.call("runtime_sandbox_run", {
    media_path: first, budget_seconds: 300,
    steps: [`I insert the disk "${second}"`, ...SAVE, ...LIST],
  });
  check(sawWrite(r), "a disk swapped in by an `insert` step was written to", r.slice(-700));
  check(md5(first) === b1 && md5(second) === b2, "…and neither the first nor the swapped-in project disk changed");
}

// ── B. runtime_sandbox_start ───────────────────────────────────────────────────────────────────
const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];
const typeLine = (id, text) => mcp.call("runtime_type", { session_id: id, text, settle: true, extra_frames: 6 });
const runFrames = (id, frames) => mcp.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: frames * 19656 });
async function writeAndList(id, label) {
  await runFrames(id, 170);
  await typeLine(id, "10 REM X\\r");
  await typeLine(id, 'SAVE"WROTE",8\\r');
  await runFrames(id, 1500);
  await typeLine(id, 'LOAD"$",8\\r');
  await runFrames(id, 1500);
  await typeLine(id, "LIST\\r");
  await runFrames(id, 60);
  const screen = await mcp.call("runtime_monitor", { session_id: id, command: "screen" });
  check(sawWrite(screen), `${label}: the sandbox wrote (its directory lists WROTE)`, screen.slice(0, 900));
}
const start = async (d, extra = {}) => {
  const s = await mcp.call("runtime_sandbox_start", { purpose: "issue 91", budget_minutes: 5, media_path: d, ...extra });
  const id = idOf(s);
  check(!!id, "a sandbox session started", s.slice(0, 300));
  return id;
};

head("B  runtime_sandbox_start");
{
  const d = disk("b-end.d64", "END");
  const before = md5(d);
  const id = await start(d);
  await writeAndList(id, "end");
  const ended = await mcp.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "issue 91" });
  check(/ended: reached/.test(ended), "runtime_sandbox_end answered", ended.slice(0, 200));
  await stable();
  check(md5(d) === before, "ended by runtime_sandbox_end: byte-identical");
}
{
  const d = disk("b-idle.d64", "IDLE");
  const before = md5(d);
  const id = await start(d, { idle_minutes: 0.12 }); // 7 s
  await writeAndList(id, "idle");
  let ended = "";
  for (let i = 0; i < 40 && !/ended: idle/.test(ended); i++) { await sleep(1000); ended = await mcp.call("runtime_sandbox_list", {}); }
  check(/idle/.test(ended), "the session ended by the idle limit", ended.slice(0, 300));
  await stable();
  check(md5(d) === before, "ended by the idle limit: byte-identical");
}
{
  const d = disk("b-budget.d64", "BUDGET");
  const before = md5(d);
  const id = await start(d, { budget_minutes: 0.5, idle_minutes: 30 }); // 30 s
  await writeAndList(id, "budget");
  let ended = "";
  for (let i = 0; i < 60 && !/budget/.test(ended); i++) { await sleep(1000); ended = await mcp.call("runtime_sandbox_list", {}); }
  check(/budget/.test(ended), "the session ended by its budget", ended.slice(0, 300));
  await stable();
  check(md5(d) === before, "ended by the budget: byte-identical");
}
{
  const d = disk("b-mount.d64", "MOUNT");
  const d2 = disk("b-mount2.d64", "MOUNTTWO");
  const [b1, b2] = [md5(d), md5(d2)];
  const id = await start(undefined);
  const m = await mcp.call("runtime_media_mount", { session_id: id, path: d });
  check(!/error/i.test(m.slice(0, 120)), "runtime_media_mount into the sandbox answered", m.slice(0, 200));
  await writeAndList(id, "mount");
  await mcp.call("runtime_monitor", { session_id: id, command: `mount ${d2}` });
  await runFrames(id, 200);
  await typeLine(id, 'SAVE"SECOND",8\\r');
  await runFrames(id, 1500);
  await mcp.call("runtime_media_persist", { session_id: id });
  await mcp.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "issue 91" });
  await stable();
  check(md5(d) === b1 && md5(d2) === b2, "mounted later (tool and monitor `mount`), persisted, ended: both byte-identical");
}
{
  const d = disk("b-owner.d64", "OWNER");
  const before = md5(d);
  const own = await H.mcp(proj, { env: { C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_BIN: DAEMON } });
  const s = await own.call("runtime_sandbox_start", { purpose: "issue 91 owner", budget_minutes: 5, media_path: d });
  const id = idOf(s);
  await own.call("runtime_type", { session_id: id, text: "10 REM X\\r", settle: true });
  await own.call("runtime_type", { session_id: id, text: 'SAVE"WROTE",8\\r', settle: true });
  await own.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 1500 * 19656 });
  own.stop(); // the MCP process goes away; the keeper ends the daemon
  await sleep(12000);
  check(md5(d) === before, "the owning MCP process killed: byte-identical");
}

// ── C. runtime_scene_reel ──────────────────────────────────────────────────────────────────────
head("C  runtime_scene_reel");
{
  const d = disk("c-origin.d64", "ORIGIN");
  const e = disk("c-insert.d64", "INSERT");
  const [b1, b2] = [md5(d), md5(e)];
  const feature = [
    "Scenario: save to the origin disk, then to an inserted one",
    `  Given the disk "${d}"`,
    "  When I wait 170 frames",
    '  And I type "10 REM X{RETURN}"',
    "  And I wait 20 frames",
    '  And I type "SAVE{QUOTE}WROTE{QUOTE},8{RETURN}"',
    "  And I wait 800 frames",
    '  And I capture "origin"',
    `  And I insert the disk "${e}"`,
    "  And I wait 100 frames",
    '  And I type "SAVE{QUOTE}WROTE{QUOTE},8{RETURN}"',
    "  And I wait 800 frames",
    '  And I capture "inserted"',
    "  Then the reel has at least 2 screens",
    "",
  ].join("\n");
  const out = join(proj, "reel.gif");
  const r = await mcp.call("runtime_scene_reel", { feature, out_path: out, budget_seconds: 300 });
  check(existsSync(out), "the reel ran and wrote its GIF", r.slice(0, 500));
  check(md5(d) === b1 && md5(e) === b2, "the origin disk and the inserted disk are byte-identical");
}

head("scratch");
await sleep(2000);
let left = [];
for (let i = 0; i < 30; i++) { left = scratchDirs().filter((n) => !scratchBefore.has(n)); if (!left.length) break; await sleep(1000); }
check(left.length === 0, "no sandbox scratch (and so no copy) is left behind", left.join(", "));

process.exit(T.done());
