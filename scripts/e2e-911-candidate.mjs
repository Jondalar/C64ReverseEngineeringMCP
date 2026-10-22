#!/usr/bin/env node
// A run of a feature file is the project's memory of what was tried, and the winner goes into the build.
//
//   S6  the run is remembered and goes into the build   a candidate record linked to the anchor and the feature file;
//                                                       the second run of the same scenario is a new entry in the same
//                                                       record; choose, derive the delta, verify the build: GREEN with
//                                                       the chosen variant's bytes (a PRG and a cartridge bank), RED
//                                                       naming the first address that does not have them
//   S7  the shared machine never moves; the old door   the shared session's cycle is unchanged across the whole run;
//       is gone                                         the three runners and their alias are not in the tool list; an
//                                                       old record (inputs + cycle budget) is still listed, chosen,
//                                                       derived and verified
//
// Real daemons of this run's own, a TMPDIR of the run's own (removed on exit), a test program and cartridge built here, fixes
// assembled by the project's assembler (64tass; SKIPS LOUDLY without it).
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:911-candidate
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Harness, ROOT, findDaemon, load, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";
import { liveMachines, privateTmp, runCli } from "./lib/e2e-911-env.mjs";
import { efCrt, hex4, pollPrg, writeFixes } from "./lib/e2e-911-fixtures.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-911-candidate");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
const { find64tassBinary } = await load("assemble-source.js");
if (!find64tassBinary()) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and 64tass was not found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — 64tass not found (put it on PATH). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
const tmp = privateTmp("c64re-911-candidate-");
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\n`);

const H = new Harness("h-");
const { prg, poll } = pollPrg();
const lines = (...l) => [...l, ""].join("\n");
const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
const store = await load("candidates/store.js");

const BUILD = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const w = JSON.parse(readFileSync("wired.json", "utf8"));
mkdirSync("out", { recursive: true });
if (w.parts && w.parts.length > 0) {
  const lo = Math.min(...w.parts.map((p) => p.addr)), hi = Math.max(...w.parts.map((p) => p.addr + p.bytes.length));
  const img = new Uint8Array(hi - lo).fill(0xaa);
  for (const p of w.parts) img.set(p.bytes, p.addr - lo);
  writeFileSync("out/game.prg", Buffer.from([lo & 255, lo >> 8, ...img]));
}
if (w.crt) {
  const b = readFileSync("media/game.crt");
  for (let o = 0x40; o < b.length; o += b.readUInt32BE(o + 4)) {
    if (b.readUInt16BE(o + 10) === w.crtBank && b.readUInt16BE(o + 12) === 0x8000) for (const p of w.crt) Buffer.from(p.bytes).copy(b, o + 0x10 + (p.addr - 0x8000));
  }
  writeFileSync("out/game.crt", b);
}
`;

try {
  const proj = await H.project("proj");
  for (const d of ["media", "scenarios", "out"]) mkdirSync(join(proj, d), { recursive: true });
  writeFileSync(join(proj, "media", "poll.prg"), prg);
  writeFileSync(join(proj, "media", "game.crt"), efCrt());
  writeFileSync(join(proj, "build.mjs"), BUILD);
  writeFixes(proj);
  const sc = (n) => join(proj, "scenarios", n);
  const shared = await H.daemon(DAEMON, proj);
  const sharedWs = await H.ws(shared.port);
  const pin = await H.pinShared(sharedWs);
  const m = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1", C64RE_SLOT_GATE: "0" } });
  const svc = new ProjectKnowledgeService(proj);
  svc.saveProjectProfile({ build: { command: "node build.mjs", outputs: ["out/game.prg"] } });
  const wired = (obj) => writeFileSync(join(proj, "wired.json"), JSON.stringify(obj));

  writeFileSync(sc("make.feature"), lines(
    "Scenario: boot to the waiting loop",
    '  Given the medium "../media/poll.prg"',
    `  When I wait until the CPU reaches ${hex4(poll)} within 600 frames`,
    '  And I set the anchor "a2"',
    `  Then the CPU is at ${hex4(poll)}`,
  ));
  check(runCli([sc("make.feature")]).code === 0, "setup: the anchor a2 is made by a feature");
  writeFileSync(sc("lift.feature"), lines(
    "Feature: the lift",
    "Scenario: the lift at level 3",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C100',
    '  And variant "fix2" assembles "../fixes/fix2.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
  ));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S6  the run is remembered");
  const first = await m.call("runtime_feature_run", { feature_path: "scenarios/lift.feature" });
  const idLine = /→ candidate (cand-\d+)/.exec(first);
  const id = idLine?.[1];
  check(!!id, "a run with variants says which candidate keeps it", first.slice(0, 400));
  const rec = store.loadCandidate(proj, id);
  check(rec?.feature?.path === "scenarios/lift.feature" && rec.feature.scenario === "the lift at level 3" && rec.feature.line === 2, "the record holds the feature file and the scenario line", JSON.stringify(rec?.feature));
  check(rec?.anchor === "a2", "…and the anchor it started from", rec?.anchor);
  const fix1 = rec?.variants.find((v) => v.name === "fix1");
  check(fix1?.targets[0]?.addr === 0xc100 && fix1.targets[0].bytes.length === 14 && fix1.targets[0].bytes[0] === 0xa9 && fix1.targets[0].sourcePath === "fixes/fix1.tas", "…each variant's targets with the bytes as assembled, and where they came from", JSON.stringify(fix1?.targets?.[0]).slice(0, 200));
  check(fix1?.result?.verdict === "PASS" && fix1.result.checks.length === 1 && rec.variants.find((v) => v.name === "fix2")?.result?.verdict === "FAIL", "…each variant's verdict and checks", JSON.stringify(rec?.variants.map((v) => [v.name, v.result?.verdict])));
  check((fix1?.result?.sideEffects ?? []).some((e) => e.space === "io" && e.from === 0xd020), "…and what it changed besides", JSON.stringify(fix1?.result?.sideEffects));
  check(rec?.baselineResult?.verdict === "FAIL" && rec.history?.length === 1, "…the baseline, and a history of one run", `${rec?.baselineResult?.verdict} ${rec?.history?.length}`);

  const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"), { readOnly: true });
  const edges = db.prepare("SELECT e.type, n.kind, n.name FROM edges e JOIN nodes n ON n.id = e.to_id WHERE e.from_id IN (SELECT id FROM nodes WHERE kind = 'candidate')").all();
  db.close();
  check(edges.some((e) => e.type === "STARTS_FROM" && e.kind === "anchor" && e.name === "a2"), "the graph: the candidate STARTS_FROM the anchor a2", JSON.stringify(edges));
  check(edges.some((e) => e.type === "FROM_FEATURE" && e.kind === "feature" && e.name === "scenarios/lift.feature"), "…and has a link to the feature file", JSON.stringify(edges));

  const second = await m.call("runtime_feature_run", { feature_path: "scenarios/lift.feature" });
  check(new RegExp(`→ candidate ${id}\\b`).test(second), "the same scenario run again keeps the same candidate", second.slice(0, 300));
  const rec2 = store.loadCandidate(proj, id);
  check(rec2.history.length === 2 && store.listCandidates(proj).length === 1, "…as a second entry in its history, not a second record", `${rec2.history.length} / ${store.listCandidates(proj).length}`);

  const listed = await m.call("runtime_candidate_list", {});
  check(listed.includes(id) && /scenarios\/lift\.feature/.test(listed) && /2 run/.test(listed), "runtime_candidate_list shows it", listed);
  const one = await m.call("runtime_candidate_list", { id });
  check(/variant "fix1"/.test(one) && /last run: PASS/.test(one) && /also changed/.test(one) && /history/.test(one), "…and in full: the variants, their last run with the side effects, the history", one);

  head("S6  choose, derive the delta, verify the build");
  const ch = await m.call("runtime_candidate_choose", { id, variant: "fix1" });
  check(/"fix1" chosen/.test(ch), "fix1 is chosen", ch);
  const dd = await m.call("runtime_candidate_derive_delta", { id });
  check(/Delta of "fix1" written/.test(dd) && existsSync(join(proj, `delta-${id}`, "delta-manifest.json")), "the delta of fix1 is written", dd.slice(0, 300));
  const f1 = fix1.targets[0].bytes;
  wired({ parts: [{ addr: 0xc100, bytes: f1 }] });
  const green = await m.call("runtime_candidate_verify_build", { id });
  check(/^GREEN/.test(green) && /ram \$c100  14 byte\(s\)  ok/.test(green), "S6: verify_build is GREEN when the built image holds fix1's bytes", green);
  wired({ parts: [{ addr: 0xc100, bytes: f1.map((b, i) => (i === 7 ? b ^ 0xff : b)) }] });
  const red = await m.call("runtime_candidate_verify_build", { id });
  check(/^RED/.test(red) && /First differing address: \$c107 — built \$/.test(red), "…and RED naming the first address without them", red);
  const kept = store.loadCandidate(proj, id);
  check(kept.chosen === "fix1" && kept.delta && kept.build?.ok === false, "…the choice, the delta and the last check are kept in the record");

  const rerun = await m.call("runtime_feature_run", { feature_path: "scenarios/lift.feature" });
  const after = store.loadCandidate(proj, id);
  check(after.chosen === "fix1" && after.delta && /→ candidate/.test(rerun), "running the file again does not lose the choice while the chosen fix assembles to the same bytes", `${after.chosen}`);
  writeFileSync(join(proj, "fixes", "fix1.tas"), "* = $c100\n        lda #$06\n        sta $d020\n        lda #$77\n        sta $c300\n        rts\n");
  const changed = await m.call("runtime_feature_run", { feature_path: "scenarios/lift.feature" });
  const after2 = store.loadCandidate(proj, id);
  check(after2.chosen === "fix1" && !after2.delta && !after2.build && /assembles to other bytes/.test(changed), "…and says so, clearing the delta, when the chosen fix now assembles to other bytes", changed.slice(0, 400));

  head("S6  two scenarios in one file are two records");
  writeFileSync(sc("two.feature"), lines(
    "Scenario: first",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
    "",
    "Scenario: second",
    '  Given the mark "a2"',
    '  And variant "fix2" assembles "../fixes/fix2.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $00",
  ));
  const two = await m.call("runtime_feature_run", { feature_path: "scenarios/two.feature" });
  const twoIds = [...two.matchAll(/→ candidate (cand-\d+)/g)].map((x) => x[1]);
  check(twoIds.length === 2 && twoIds[0] !== twoIds[1] && store.listCandidates(proj).length === 3, "each gets a record of its own (never the same number twice)", `${twoIds.join(",")} / ${store.listCandidates(proj).length}`);

  head("S6  a cartridge bank in the build");
  writeFileSync(sc("cart.feature"), lines(
    "Scenario: a fix in a cartridge bank",
    '  Given the cart "../media/game.crt"',
    '  And variant "romfix" assembles "../fixes/romfix.tas" at roml bank 3 $9100',
    "  When I wait 5 frames",
    "  Then $0311 is $55",
  ));
  const cart = await m.call("runtime_feature_run", { feature_path: "scenarios/cart.feature" });
  const cid = /→ candidate (cand-\d+)/.exec(cart)?.[1];
  check(!!cid && /PASS\s+romfix/.test(cart), "the cartridge fix passes", cart.slice(0, 400));
  await m.call("runtime_candidate_choose", { id: cid, variant: "romfix" });
  const rb = store.loadCandidate(proj, cid).variants[0].targets[0];
  check(rb.space === "roml" && rb.bank === 3 && rb.addr === 0x9100, "its target is bank 3 of ROML at $9100", JSON.stringify({ ...rb, bytes: undefined }));
  wired({ crt: [{ addr: 0x9100 - 0x8000 + 0x8000, bytes: rb.bytes }], crtBank: 3 });
  svc.saveProjectProfile({ build: { command: "node build.mjs", outputs: ["out/game.crt"] } });
  const cg = await m.call("runtime_candidate_verify_build", { id: cid });
  check(/^GREEN/.test(cg) && /roml bank 3 \$9100/.test(cg), "GREEN: the built cartridge holds the bytes in bank 3", cg);
  wired({ crt: [{ addr: 0x9100, bytes: rb.bytes }], crtBank: 0 });
  const cr = await m.call("runtime_candidate_verify_build", { id: cid });
  check(/^RED/.test(cr) && /roml bank 3 \$9100/.test(cr), "RED naming bank 3 and the address when the bytes are in another bank", cr);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S7  the old door is gone; an old record still works");
  for (const n of ["runtime_candidate_create", "runtime_candidate_variant", "runtime_candidate_run", "runtime_candidate_patch", "runtime_candidate_remove_patch"]) {
    check(!m.tools.some((t) => t.name === n), `${n} is not in the tool list`);
  }
  for (const n of ["runtime_feature_run", "runtime_candidate_list", "runtime_candidate_choose", "runtime_candidate_derive_delta", "runtime_candidate_verify_build", "runtime_candidate_delete", "runtime_anchor_set"]) {
    check(m.tools.some((t) => t.name === n), `${n} is on the tool surface`);
  }
  const noRef = m.tools.filter((t) => /runtime_candidate_(create|variant|run)\b|candidate_patch/.test(t.description ?? ""));
  check(noRef.length === 0, "no tool description sends the reader to a retired name", noRef.map((t) => t.name).join(", "));

  // a record as the old runner left it: an input script and a cycle budget, no feature
  const old = [0xa9, 0x01, 0x8d, 0x00, 0xc1, 0x60];
  store.saveCandidate(proj, {
    id: "cand-old", anchor: "vor_level3", anchorCycle: 123456, anchorFrame: 6, inputs: [{ atCycle: 100, kind: "joystick2", payload: { fire: true } }], cycleBudget: 100000,
    createdAt: new Date().toISOString(), updatedAt: "",
    variants: [
      { name: "v1", targets: [{ space: "ram", addr: 0xc000, source: "", bytes: [0xea, 0xea] }], verdict: { state: "done", identical: false, changes: ["ram: 2 bytes"], cycles: 100000, registers: { pc: 0x0810 }, ranAt: new Date().toISOString() } },
      { name: "v2", targets: [{ space: "ram", addr: 0xc100, source: "", bytes: old }], verdict: { state: "done", identical: true, cycles: 100000, registers: { pc: 0x0810 }, ranAt: new Date().toISOString() } },
    ],
  });
  const ol = await m.call("runtime_candidate_list", {});
  check(/cand-old/.test(ol) && /an older record/.test(ol), "the old record is listed, and called an older record", ol);
  const od = await m.call("runtime_candidate_list", { id: "cand-old" });
  check(/100000 cycles/.test(od) && /1 input/.test(od) && /variant "v1"/.test(od) && /DIFFERS/.test(od), "…shown in full with its inputs, its budget and its verdicts", od);
  svc.saveProjectProfile({ build: { command: "node build.mjs", outputs: ["out/game.prg"] } });
  check(/"v2" chosen/.test(await m.call("runtime_candidate_choose", { id: "cand-old", variant: "v2" })), "…and can still be chosen");
  check(/Delta of "v2" written/.test(await m.call("runtime_candidate_derive_delta", { id: "cand-old" })), "…have its delta derived");
  wired({ parts: [{ addr: 0xc100, bytes: old }] });
  check(/^GREEN/.test(await m.call("runtime_candidate_verify_build", { id: "cand-old" })), "…and its build verified: GREEN");
  wired({ parts: [{ addr: 0xc100, bytes: [0xa9, 0x01, 0x8d, 0x00, 0xc1, 0xea] }] });
  check(/^RED/.test(await m.call("runtime_candidate_verify_build", { id: "cand-old" })), "…and RED on a build without it");
  check(/Nothing was done/.test(await m.call("runtime_candidate_export", {})), "the retired runtime_candidate_export still answers, by pointing at the list");

  const sharedNow = await pin.unchanged();
  check(sharedNow.ok, "S7: the shared session (a paused stand-in) is unchanged across the whole run: same cycle, same PC, still paused", sharedNow.text);
  sharedWs.close();
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
