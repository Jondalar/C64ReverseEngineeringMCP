// Spec 899 — input offsets, sweeps, windowed checks and series: the notation and every
// decision that can be made without a machine. Hermetic (no daemon, no media, no :4312).
// The half that runs machines is e2e-899-sweep.mjs, which needs a runtime with cycle-exact
// input and skips loudly without one.
//
//   npm run e2e:899-notation
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const load = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { parseCheck, parseStep, parseFeature, parseSeriesRead, parseSeriesReads, STEP_KINDS } = await load("project-knowledge/scenario-gherkin.js");
const { VOCABULARY, missingKinds } = await load("project-knowledge/scenario-vocabulary.js");
const { inputOffsetFor, offsetRefusal, offsetsRequested, sweepOffsets } = await load("reel/input-offset.js");
const probe = await load("reel/frame-probe.js");
const { sweepRefusal } = await load("reel/sweep.js");
const { runSandbox } = await load("reel/run-sandbox.js");
const { formatSeries, formatSweep } = await load("reel/probe-report.js");
const { collectToolInventory } = await load("server.js");

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };

console.log("Spec 899 — input offsets, windows and series: the notation\n");

// ── D3: a Then that holds over a window ─────────────────────────────────────────
console.log("D3. a check over a window of frames");
const win = (text) => parseCheck(text);
check(same(win("$D01C@io is $04 throughout the next 600 frames")?.check,
  { kind: "memory", address: 0xd01c, lens: "io", op: "is", values: [4], window: { frames: 600 } }), "throughout the next N frames");
check(same(win("$D01C@io is $04 at every frame for 600 frames")?.check?.window, { frames: 600 }), "at every frame for N frames");
check(same(win("$D01C@io is $04 throughout the next 600 frames at raster line 250")?.check?.window, { frames: 600, line: 250 }), "…with an optional raster line");
check(same(win("$D01C@io is not $00 throughout the next 5 frames")?.check?.op, "isNot"), "is not over a window");
check(same(win("$D01C@io is one of $04, $05 throughout the next 5 frames")?.check?.values, [4, 5]), "is one of over a window");
check(same(win("$40 is $26 $40 throughout the next 5 frames")?.check?.values, [0x26, 0x40]), "several bytes over a window");
check(parseCheck("$D01C@io is $04")?.check?.window === undefined, "a plain check has no window (unchanged)");
for (const bad of [
  "$D01C@io is $04 throughout the next 0 frames", "$D01C@io is $04 throughout the next 50001 frames",
  "$D01C@io is $04 throughout 600 frames", "$D01C@io is $04 at every frame",
  "the CPU is at $0812 throughout the next 5 frames", 'the screen shows "READY." throughout the next 5 frames',
  "$D01C@io is $04 throughout the next 5 frames at raster line 5000",
]) {
  const r = parseCheck(bad);
  check(r && "error" in r, `refused: ${bad}`, r && "error" in r ? r.error.slice(0, 80) : JSON.stringify(r));
}
check(parseCheck("the player holds the line throughout the next 5 frames") === undefined, "prose with a window stays prose");

// ── D4: a series ────────────────────────────────────────────────────────────────
console.log("\nD4. a sample series");
const ser = (t) => parseStep(t);
const s1 = ser('I read the series "$D01C:1@io", "$D029@io" every frame for 600 frames')?.step;
check(s1?.kind === "series" && s1.frames === 600 && s1.everyFrames === 1 && s1.reads.length === 2 && s1.line === undefined, "I read the series … every frame for N frames");
check(same(s1?.reads.map((r) => [r.addr, r.len, r.lens]), [[0xd01c, 1, "io"], [0xd029, 1, "io"]]), "…its reads: address, length, lens");
const s2 = ser('I read the series "$C000:16" every 3 frames for 90 frames at raster line 250')?.step;
check(s2?.everyFrames === 3 && s2.line === 250 && s2.reads[0].len === 16 && s2.reads[0].lens === "cpu", "every N frames, at a raster line, decimal length, default lens");
check(parseSeriesRead("$D01C:$10@io").read?.len === 16, "a $-length is hex");
for (const bad of [
  'I read the series "$D01C" for 600 frames', 'I read the series $D01C every frame for 600 frames',
  'I read the series "$D01C:0" every frame for 5 frames', 'I read the series "$D01C@vic" every frame for 5 frames',
  'I read the series "$D01C" every 9 frames for 5 frames', 'I read the series "$D01C" every frame for 50001 frames',
  'I read the series "$C000:200", "$C100:100" every frame for 5 frames', 'I read the series "$FFFF:2" every frame for 5 frames',
]) {
  const r = ser(bad);
  check(r?.error !== undefined, `refused: ${bad}`, r?.error?.slice(0, 80));
}
check(parseSeriesReads([]).error !== undefined, "an empty list of reads is refused");
check(STEP_KINDS.includes("series") && missingKinds().length === 0, "the series is a step kind and the vocabulary covers it", missingKinds().join(","));
check(VOCABULARY.some((v) => v.kind === "series") && VOCABULARY.some((v) => /throughout/.test(v.form)), "…and so does the throughout form");

console.log("\nD5. one notation: a .feature file carries all of it");
const feature = [
  "Feature: f", "  Scenario: window and series",
  '    Given the disk "x.prg"',
  "    When I wait 20 frames",
  "    And I hold joystick 2 fire for 3 frames",
  '    And I read the series "$D01C:1@io" every frame for 600 frames',
  "    Then $D01C@io is $04 throughout the next 600 frames",
].join("\n");
const parsed = parseFeature(feature, "f.feature");
const sc = parsed.scenarios[0];
check(parsed.issues.length === 0 && sc?.steps.map((s) => s.kind).join() === "wait,joystick,series", "parses, in order", JSON.stringify(parsed.issues));
check(sc?.criteria[0]?.check?.window?.frames === 600 && sc.criteria[0].afterSteps === 3, "…the window is on the check, decided after the series", String(sc?.criteria[0]?.afterSteps));
const badFeature = parseFeature(feature.replace("throughout the next 600 frames", "throughout 600 frames"), "f.feature");
check(badFeature.issues.some((i) => i.line === 7), "a malformed window is a parse issue on its line", JSON.stringify(badFeature.issues));

// ── D1/D2: where in the frame ───────────────────────────────────────────────────
console.log("\nD1/D2. offsets, seeds and a sweep");
check(inputOffsetFor({}, 3, 19656) === undefined && !offsetsRequested({}), "no option: no offset, the run is as before");
check(inputOffsetFor({ inputOffsetCycles: 1234 }, 3, 19656) === 1234, "input_offset_cycles is the offset of every step");
check(inputOffsetFor({ inputOffsetCycles: 0 }, 3, 19656) === 0 && offsetsRequested({ inputOffsetCycles: 0 }), "…0 included: asked for is asked for");
const j = (seed, i) => inputOffsetFor({ jitterSeed: seed }, i, 19656);
check(j(7, 2) === j(7, 2) && j(7, 2) >= 0 && j(7, 2) < 19656, "a seeded offset is repeatable and inside the frame", String(j(7, 2)));
const spread = new Set(Array.from({ length: 40 }, (_, i) => j(99, i)));
check(spread.size > 30, "…each step has its own", `${spread.size} different of 40`);
check(j(7, 2) !== j(8, 2) && j(7, 2) !== j(7, 3), "…a different seed or step gives another");
check(Array.from({ length: 200 }, (_, i) => inputOffsetFor({ jitterSeed: i - 100 }, i, 17095)).every((o) => o >= 0 && o < 17095), "…and stays inside an NTSC frame");
check(same(sweepOffsets(8, 19656), [0, 2457, 4914, 7371, 9828, 12285, 14742, 17199]), "sweep 8 on PAL: evenly across 19656 cycles");
check(sweepOffsets(3, 17095).join() === "0,5698,11396", "…and on NTSC: 17095 cycles");
check(offsetRefusal({ inputOffsetCycles: 1, jitterSeed: 1 }) !== undefined, "an offset and a seed together are refused");
check(offsetRefusal({ inputOffsetCycles: -1 }) !== undefined && offsetRefusal({ inputOffsetCycles: 1.5 }) !== undefined, "…and so is a negative or fractional offset");
check(offsetRefusal({}) === undefined && offsetRefusal({ jitterSeed: -5 }) === undefined, "…while no option, or a negative seed, is fine");
const press = [parseStep("I hold joystick 2 fire for 3 frames").step];
const decide = [{ check: parseCheck("$C002 is $01").check, afterSteps: 1, text: "x" }];
check(sweepRefusal({ steps: press, checks: decide }, 8) === undefined, "a sweep over a press with a check is allowed");
check(sweepRefusal({ steps: press, checks: decide }, 1) !== undefined && sweepRefusal({ steps: press, checks: decide }, 65) !== undefined, "…2 to 64 runs");
check(sweepRefusal({ steps: press, checks: [] }, 8) !== undefined, "…a sweep with nothing to decide by is refused");
check(sweepRefusal({ steps: [parseStep("I wait 5 frames").step], checks: decide }, 8) !== undefined, "…and so is one over steps that press nothing");
check(sweepRefusal({ steps: press, checks: decide, inputOffsetCycles: 5 }, 8) !== undefined, "…and one that also fixes the offset");
const early = await rejects(runSandbox({ steps: press, inputOffsetCycles: 5, jitterSeed: 5 }));
check(/two ways to choose/.test(early ?? ""), "contradicting options are refused before any daemon starts", early?.slice(0, 60));

// ── the runtime half, against a stand-in that answers like each kind of runtime ──
console.log("\nA runtime that cannot do it is refused by name; one that stops the probe says so");
const old = async () => { throw new Error("Method not found: session/frame_probe"); };
const refused = await rejects(probe.requireProbeRuntime(old, "an input offset"));
check(/an input offset needs a TRX64 with cycle-exact input and the frame probe/.test(refused ?? ""), "an old runtime is refused, naming what is needed", refused?.slice(0, 90));
check(/Nothing was run, and nothing fell back to frame-boundary input/.test(refused ?? ""), "…and says it did not fall back");
const current = async () => { throw new Error("session/frame_probe: `frames` must be an integer in 1..=50000"); };
check((await rejects(probe.requireProbeRuntime(current, "x"))) === undefined, "a runtime that has the probe passes the gate");

const stopReply = { stopped: "breakpoint", frame: 12, c64Cycles: 777, line: 100, cycle: 9, pc: 0x0850, breakpoint: { pc: 0x850, num: 1 }, rows: [{ frame: 0, c64Cycles: 1, line: 288, cycle: 0, bytes: [4] }], samples: 12, changes: 0 };
const a = await probe.probeAssert(async () => stopReply, { frames: 600, line: 288, addr: 0xd01c, lens: "io", expect: [4] });
check("stopped" in a && a.stopped.kind === "breakpoint" && a.stopped.pc === 0x850 && a.stopped.frame === 12, "an assert stopped by a breakpoint is reported as a stop, not as held or failed", JSON.stringify(a));
const sr = await probe.probeSeries(async () => stopReply, { frames: 600, line: 288, reads: [{ addr: 0xd01c, len: 1, lens: "io", label: "x" }] });
check(sr.stopped?.kind === "breakpoint" && sr.rows.length === 1, "…and a series keeps the rows collected before the stop");
check(/stopped by a breakpoint at PC \$0850 in frame 12/.test(probe.describeStop(a.stopped)), "…in words", probe.describeStop(a.stopped));
const w = await probe.probeAssert(async () => ({ stopped: "watchpoint", frame: 3, c64Cycles: 9, line: 1, cycle: 2, pc: 0x1234 }), { frames: 9, line: 288, addr: 0, lens: "cpu", expect: [0] });
check("stopped" in w && w.stopped.kind === "watchpoint", "a watchpoint stop is told apart");
const sent = [];
await probe.probeAssert(async (m, p) => { sent.push([m, p]); return { held: true, samples: 5, c64Cycles: 5 }; }, { frames: 5, line: 288, addr: 0x40, lens: "ram", expect: [0x26, 0x40] });
check(same(sent[0], ["session/frame_probe", { frames: 5, line: 288, mode: "assert", addresses: [{ addr: 0x40, len: 2, lens: "ram" }], expect: [{ addr: 0x40, value: 0x26 }, { addr: 0x41, value: 0x40 }] }]), "an `is` of several bytes is ONE address range with one expectation per byte");

console.log("\nevery N frames reads the change rows; it is not a second run");
const rows = [{ frame: 0, c64Cycles: 100, line: 288, cycle: 0, bytes: [4] }, { frame: 43, c64Cycles: 5000, line: 288, cycle: 1, bytes: [0] }, { frame: 46, c64Cycles: 5900, line: 288, cycle: 0, bytes: [4] }];
const dec = probe.everyNth(rows, 10, 100);
check(same(dec.map((r) => [r.frame, r.bytes[0]]), [[0, 4]]), "every 10 frames misses a glitch that lives in frames 43-45, as sampling every 10th frame must", JSON.stringify(dec.map((r) => [r.frame, r.bytes[0]])));
const dec3 = probe.everyNth(rows, 3, 60);
check(dec3.map((r) => r.frame).join() === "0,45,48", "every 3 frames: 0, 45 (value from frame 43), 48 (value from frame 46)", dec3.map((r) => r.frame).join());
check(dec3[1].seenFrame === 43 && dec3[1].c64Cycles === 5000, "…a row says where the probe first saw its value");

console.log("\nthe report");
const table = formatSeries({
  step: 2, text: "t", reads: [{ addr: 0xd01c, len: 1, lens: "io", label: "$D01C:1@io" }], everyFrames: 1, frames: 600, line: 288,
  startCycle: 1, endCycle: 2, rows, samples: 600, changes: 2,
});
check(table.length === 2 + 3 && /600 frames, sampled at raster line 288; 600 samples, 3 of them rows \(2 changes\)/.test(table[0]), "a series header counts samples, rows and changes", table[0]);
check(/^ {2}43 +5000 +288 +1 +00/.test(table[3]), "…and a row carries frame, cycle, line, raster cycle and the bytes", table[3]);
const sweepText = formatSweep({
  count: 2, machine: { model: "c64-pal" }, cyclesPerFrame: 19656, pass: 1, fail: 1, error: 0, firstFailing: 2457,
  runs: [{ offset: 0, verdict: "PASS", checks: [] }, { offset: 2457, verdict: "FAIL", checks: [{ text: "$C002 is $01", pass: false, actual: "$FF" }] }],
}).join("\n");
check(/first failing offset: 2457 cycles — run it again with input_offset_cycles: 2457/.test(sweepText) && /offset 2457 +FAIL\n +FAIL +\$C002 is \$01 — \$FF/.test(sweepText), "a sweep names the first failing offset and how to replay it");

// ── the surface ─────────────────────────────────────────────────────────────────
console.log("\nD5. the tools describe it");
const inventory = collectToolInventory();
const box = inventory.find((t) => t.name === "runtime_sandbox_run");
const reel = inventory.find((t) => t.name === "runtime_scene_reel");
for (const p of ["input_offset_cycles", "jitter_seed", "sweep", "read_series", "every_frames", "series_frames", "series_line"]) {
  check(box?.schema?.[p] !== undefined && String(box.schema[p].description ?? box.schema[p]._def?.description ?? "").length > 20, `runtime_sandbox_run has \`${p}\`, described`);
}
for (const p of ["input_offset_cycles", "jitter_seed"]) check(reel?.schema?.[p] !== undefined, `runtime_scene_reel has \`${p}\``);
check(/throughout the next/.test(box?.description ?? "") && /sweep/.test(box?.description ?? "") && /frame probe/.test(box?.description ?? ""), "the sandbox description explains windows, sweeps and what they need");
check(!/\bSpec\s+\d/i.test(box?.description ?? "") && !/\bSpec\s+\d/i.test(reel?.description ?? ""), "…without a spec number");
const docs = readFileSync(join(ROOT, "docs/runtime-sandbox.md"), "utf8");
check(/input_offset_cycles/.test(docs) && /throughout the next/.test(docs) && /read_series/.test(docs) && /--sweep/.test(docs), "docs/runtime-sandbox.md describes the notation");
const mine = docs.slice(docs.indexOf("## Where in the frame"), docs.indexOf("<!-- deliberate-limitation"));
check(mine.length > 500 && !/\bSpec\s+\d{3}/i.test(mine), "…without a spec number in that part");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-899 notation: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
