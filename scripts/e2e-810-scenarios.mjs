#!/usr/bin/env node
/**
 * Spec 810 — scenario goals and acceptance.
 *
 * The load-bearing claim is §1: ACCEPTANCE CONVERTS A VERBAL GOAL INTO A BYTE-EXACT ONE.
 * A human looks once, that state is frozen, and from then on the same criterion is a diff
 * with nobody present. So the BDD layer never evaluates — it names the goal, presents the
 * run, and freezes the answer. These checks pin that, plus the two decisions the spec
 * owns: the mask belongs to the criterion, and a named target's resolution freezes with
 * the acceptance.
 */
import { parseFeature, classifyCriterion, divergedTargets } from "../dist/project-knowledge/scenario-gherkin.js";

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL  ${what}`); } };

// ── 1. The notation is a notation over the model that already exists ────────────
const FEATURE = `
# targets: finding/f-2091, payload/level-loader
# mask: cpu.cycles, vic.raster
Scenario: the lives counter stops decrementing
  Given the mark "before-death"
  When branch "patch-dec" runs for 2 frames
  Then $DC08 is unchanged
  And the screen is accepted
`;
{
  const r = parseFeature(FEATURE, "lives.feature");
  ok(r.issues.length === 0, `a well-formed feature parses clean (got ${JSON.stringify(r.issues)})`);
  const s = r.scenarios[0];
  ok(s?.name === "the lives counter stops decrementing", "the scenario is named");
  ok(s?.mark === "before-death", "Given binds a MARK — 809's object, named not created");
  ok(s?.branch === "patch-dec" && s?.frames === 2, "When names a branch and a budget");
  ok(s?.criteria.length === 2, "Then + And are two criteria");
  ok(s?.targets.length === 2, "the targets header is captured for the indexer");
  ok(s?.mask.join(",") === "cpu.cycles,vic.raster", "§3 — the mask travels with the CRITERION, not the run");
}

// ── 2. The two goal kinds, which are NOT two systems ────────────────────────────
ok(classifyCriterion("$DC08 is unchanged").kind === "byte-exact", "an address is machine-checkable from run one");
ok(classifyCriterion("SID is unchanged").kind === "byte-exact", "so is a component 794 can diff");
ok(classifyCriterion("the intro plays").kind === "verbal", "prose needs a human ONCE");
{
  // §8 — a criterion may name C64RE's own vocabulary, so it reads like what you mean.
  const c = classifyCriterion(`payload "level-loader" is unchanged`);
  ok(c.kind === "byte-exact" && c.names === "level-loader", "a named payload is a target, not prose");
  const f = classifyCriterion("finding f-2091 is unchanged");
  ok(f.names === "f-2091", "and so is a finding");
}

// ── 3. A malformed scenario is REPORTED, never guessed at ───────────────────────
{
  const r = parseFeature(`Scenario: no mark\n  When branch "x" runs for 1 frame\n  Then $D020 is unchanged\n`);
  ok(r.scenarios.length === 0 && /no Given/.test(r.issues[0]?.message ?? ""), "no Given is an issue, not a default mark");
}
{
  const r = parseFeature(`Scenario: nothing asserted\n  Given the mark "m"\n  When branch "b" runs for 1 frame\n`);
  ok(/no Then/.test(r.issues[0]?.message ?? ""), "a scenario without a criterion cannot pass or fail, and says so");
}
{
  const r = parseFeature(`Given the mark "m"\n`);
  ok(/outside any Scenario/.test(r.issues[0]?.message ?? ""), "a stray step is reported rather than attached to nothing");
}

// ── 4. §8 — a moved target is REPORTED, not followed ────────────────────────────
{
  const acceptance = {
    scenario: "the lives counter stops decrementing",
    by: "alex", at: "2026-08-14T10:00:00Z",
    baselinePath: "/p/accepted.c64re",
    mask: ["cpu.cycles"],
    frozen: [{ name: "f-2091", address: 0x8500, frozenAt: "2026-08-14T10:00:00Z" }],
  };
  ok(divergedTargets(acceptance, () => 0x8500).length === 0, "unchanged target: nothing to report");

  const moved = divergedTargets(acceptance, () => 0x8520);
  ok(moved.length === 1 && moved[0].frozen === 0x8500 && moved[0].now === 0x8520,
     "a MOVED finding is reported with both addresses — following it silently would stay GREEN while testing something else");

  const gone = divergedTargets(acceptance, () => undefined);
  ok(gone.length === 1 && gone[0].now === undefined, "and a target that vanished is a divergence too, not a pass");
}

console.log(`\ne2e-810-scenarios: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
