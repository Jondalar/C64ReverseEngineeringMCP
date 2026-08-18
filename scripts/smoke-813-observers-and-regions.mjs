// Spec 813 — waiting on a STATE instead of a cycle, and checking one.
//
// 812 anchors on absolute cycles. Exact, and it fails SILENTLY: change the runtime
// and the same number lands somewhere else with nothing reported. A state anchor
// heals itself and cannot drift, so the state is the anchor and the cycle budget is
// the ripcord. This gate drives a real scenario against a sandbox machine and
// checks both halves: that the predicates fire on the right state, and that the
// report still says which cycle they fired on.
//
// Run after build:mcp.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeature, classifyCriterion } from "../dist/project-knowledge/scenario-gherkin.js";
import {
  screenCodeToChar, screenShows, screenCodesToRows, screenRectRanges, resolveRegions,
  normalizeScreenText,
} from "../dist/project-knowledge/region.js";
import { runScenario } from "../dist/reel/run-scenario.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("spec 813 — observers and regions\n");

// ── §3 screen codes ──────────────────────────────────────────────────────────
ok(screenCodeToChar(0x01) === "A" && screenCodeToChar(0x1a) === "Z", "1 screen codes 1-26 are A-Z");
ok(screenCodeToChar(0x20) === " " && screenCodeToChar(0x30) === "0", "2 32-63 are ASCII: space and digits");
ok(screenCodeToChar(0x81) === "A", "3 reverse video draws the same character");
ok(screenCodeToChar(0x60) === " ", "4 a graphics code is not a letter, so it never joins two words");
{
  const row = new Uint8Array(40).fill(0x20);
  "PRESS FIRE".split("").forEach((ch, i) => { row[10 + i] = ch === " " ? 0x20 : ch.charCodeAt(0) - 64; });
  ok(screenShows(row, "PRESS FIRE", 40), "5 the screen shows what a human reads off it");
  ok(screenShows(row, "press fire", 40), "6 case does not matter");
  ok(!screenShows(row, "PRESS START", 40), "7 and a different string does not match");
}
{
  // A needle split over the right edge is not the word.
  const two = new Uint8Array(80).fill(0x20);
  "PRE".split("").forEach((ch, i) => { two[37 + i] = ch.charCodeAt(0) - 64; });
  "SS".split("").forEach((ch, i) => { two[40 + i] = ch.charCodeAt(0) - 64; });
  ok(!screenShows(two, "PRESS", 40), "8 a match never runs across a line break");
  ok(screenCodesToRows(two, 40).length === 2, "9 rows come back per row");
  ok(normalizeScreenText("  A   B  ") === "A B", "10 runs of spaces collapse, so padded menus match");
}

// ── §2 a rectangle is an address set, one range per row ──────────────────────
{
  const r = screenRectRanges({ col: 30, row: 1, cols: 8, rows: 2 }, { screenBase: 0x0400, colorBase: 0xd800 });
  ok(r.length === 4, "11 two rows with colour = four ranges, not one bounding span", `${r.length}`);
  ok(r[0].addr === 0x0400 + 40 + 30 && r[0].len === 8, "12 row 1 starts at screenBase + row*40 + col",
     `$${r[0].addr.toString(16)}`);
  ok(r[1].addr === 0xd800 + 40 + 30 && r[1].lens === "io", "13 colour RAM comes through the io lens");
  ok(r[2].addr === r[0].addr + 40, "14 the next row is 40 further on, not contiguous with the first");
}
{
  // The bases come from the machine, never re-derived here (BUG-051's lesson).
  const r = screenRectRanges({ col: 0, row: 0, cols: 4, rows: 1 }, { screenBase: 0x4400 });
  ok(r.length === 1 && r[0].addr === 0x4400, "15 a different VIC bank moves the region with it");
}

// ── §5 local shadows store, and the run says so ──────────────────────────────
{
  const stored = { entityId: "e-1", name: "score", ranges: [{ addr: 0x0500, len: 8, lens: "ram" }] };
  const res = resolveRegions(
    [{ name: "score", rect: { col: 30, row: 1, cols: 8, rows: 1 } }, { name: "lives" }],
    { screenBase: 0x0400 },
    (n) => (n === "score" ? stored : n === "lives" ? { ...stored, entityId: "e-2", name: "lives" } : undefined),
  );
  ok(res.regions.get("score")?.source === "local", "16 a local definition wins over a store entity");
  ok(res.regions.get("score")?.shadowsEntity === "e-1", "17 and the shadowed entity is named");
  ok(res.lines.some((l) => /shadows entity e-1/.test(l)), "18 the report says it out loud",
     res.lines.find((l) => /score/.test(l))?.trim());
  ok(res.regions.get("lives")?.source === "entity", "19 a bare name resolves from the store");
}
{
  const res = resolveRegions([{ name: "ghost" }], { screenBase: 0x0400 });
  ok(res.errors.length === 1 && /never/.test(res.errors[0]) === false && /store has no region/.test(res.errors[0]),
     "20 an undefined region is an error that says what to do", res.errors[0]?.slice(0, 60));
}
{
  // 810's rule: a moved target is REPORTED, never followed.
  const moved = {
    entityId: "e-9", name: "score",
    ranges: [{ addr: 0x0600, len: 8, lens: "ram" }],
    frozenRanges: [{ addr: 0x0500, len: 8, lens: "ram" }],
  };
  const res = resolveRegions([{ name: "score" }], { screenBase: 0x0400 }, () => moved);
  ok(res.moved.length === 1 && res.regions.size === 0, "21 a region that moved since acceptance is not followed");
  ok(/frozen at \$0500\+8, now \$0600\+8/.test(res.moved[0]), "22 and the report says where it went",
     res.moved[0]?.slice(0, 70));
}

// ── §4 the parser ────────────────────────────────────────────────────────────
{
  const src = [
    'Scenario: predicates',
    '  Given the disk "x.d64"',
    '  And the region "score" covers 30,1 to 37,1',
    '  When I wait until the screen shows "READY." within 300 frames',
    '  And I wait until "score" shows "0000" within 60 frames',
    '  And I wait until "score" changes within 600 frames',
    '  And I wait until $C05F is $03 within 600 frames',
    '  And I capture "a"',
    '  Then "score" is unchanged',
    '',
  ].join("\n");
  const { scenarios, issues } = parseFeature(src);
  ok(issues.length === 0, "23 the new forms parse clean", issues.map((i) => i.message).join(" | "));
  const sc = scenarios[0];
  const kinds = sc.steps.filter((s) => s.kind === "waitUntil").map((s) => s.predicate.kind);
  ok(kinds.join(",") === "screenShows,regionShows,regionChanges,memoryIs", "24 all four predicates", kinds.join(","));
  ok(sc.regions.length === 1 && sc.regions[0].rect.cols === 8, "25 the region Given carries its rectangle");
  ok(sc.origin.kind === "medium", "26 a region Given is not an origin — the scenario still starts from the disk");
}
{
  const bad = parseFeature([
    'Scenario: x', '  Given the disk "x.d64"',
    '  And the region "score" covers 99,1 to 100,1',
    '  When I wait 1 frames', '  And I capture "a"', '  Then it booted', '',
  ].join("\n"));
  ok(bad.issues.some((i) => /40x25/.test(i.message)), "27 a rectangle off the screen is refused",
     bad.issues[0]?.message?.slice(0, 60));
}
{
  const bad = parseFeature([
    'Scenario: x', '  Given the disk "x.d64"',
    '  When I wait until the screen glows within 60 frames',
    '  And I capture "a"', '  Then it booted', '',
  ].join("\n"));
  ok(bad.issues.some((i) => /the screen shows/.test(i.message)),
     "28 an unknown predicate lists the ones that exist");
}

// ── 810's classifier: a region criterion is byte-exact by construction ───────
ok(classifyCriterion('"score" is unchanged').kind === "byte-exact", "29 a region criterion is byte-exact");
ok(classifyCriterion('"score" is unchanged').names === "score", "30 and it names the region it resolves");
ok(classifyCriterion('the screen shows "GAME OVER"').kind === "byte-exact", "31 so is a screen-text criterion");
ok(classifyCriterion("the intro plays").kind === "verbal", "32 and prose is still verbal");

// ── behavioural: a real machine, a real predicate ────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "spec813-"));
try {
  const feature = [
    "Scenario: boot to READY, anchored on the state",
    "  Given a bare machine",
    '  And the region "topline" covers 0,1 to 20,1',
    "  When I wait until the screen shows \"READY.\" within 600 frames",
    '  And I capture "ready"',
    "  Then the reel has at least 1 screens",
    "",
  ].join("\n");
  const { scenarios } = parseFeature(feature);
  const run = await runScenario(scenarios[0], { budgetSeconds: 300 });

  ok(run.shots.length === 1, "33 the scenario captured on the state it was waiting for");
  ok(run.waits.length === 1, "34 the wait is recorded");
  ok(run.waits[0].frames > 0 && run.waits[0].frames < 600, "35 READY. arrived inside the budget",
     `${run.waits[0].frames} of ${run.waits[0].budget} frames`);
  ok(run.waits[0].cycle > 0, "36 and the report carries the CYCLE it fired on — the drift signal",
     `cycle ${run.waits[0].cycle}`);
  ok(run.regions.some((l) => /topline/.test(l) && /local/.test(l)), "37 the region resolved locally and is reported",
     run.regions[0]?.trim());

  // The same predicate that cannot be met fails with what was on screen instead.
  const missSrc = [
    "Scenario: a text that never appears",
    "  Given a bare machine",
    '  When I wait until the screen shows "INSERT COIN" within 200 frames',
    '  And I capture "x"',
    "  Then the reel has at least 1 screens",
    "",
  ].join("\n");
  let msg = "";
  try {
    await runScenario(parseFeature(missSrc).scenarios[0], { budgetSeconds: 300 });
  } catch (e) { msg = String(e && e.message); }
  ok(/did not happen within 200 frames/.test(msg), "38 a predicate that never fires FAILS, it does not hang",
     msg.slice(0, 60));
  ok(/what it showed instead/.test(msg), "39 and the failure says what the screen actually showed",
     msg.slice(msg.indexOf("what it showed"), msg.indexOf("what it showed") + 60));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "RED" : "GREEN"} spec 813: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
