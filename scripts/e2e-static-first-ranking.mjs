// Static-first next-step ranking — the §9 ladder guard must NOT propose a runtime trace
// before the loader is read+annotated AND a read-derived hypothesis is on record. This is
// the ranking-time half of the read-before-runtime discipline gate (the runtime tools
// already refuse at call time); it stops the engine from PROPOSING runtime, so a session
// no longer has to override the suggestion by hand (Winter Games, 2026-07-06). Run after
// build:mcp.
import { pickPrimary } from "../dist/server-tools/agent-step.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("static-first ranking — §9 runtime-trace gate\n");

// A signals object tuned to fall THROUGH ladder §1–§8 and land on §9 (open questions,
// no trace yet): initialized, inventory clean, payload+analysis+source+annotations present,
// grounded. Only the two static-first signals are toggled per case.
const base = {
  initialized: true,
  unregisteredFiles: 0, unregisteredExamples: [], unimportedManifests: 0, staleViews: 0,
  mediaArtifacts: 0, hasG64: false, hasCrt: false, extractedPayloads: 1,
  analysisArtifacts: 1, sourceArtifacts: 1, annotationArtifacts: 1, traceArtifacts: 0,
  openQuestions: 1, unsavedHint: false, findings: 1, ungroundedFindings: 0,
  loaderReadAnnotated: false, hasReadHypothesis: false,
};
const pick = (over) => pickPrimary({ ...base, ...over }, "/tmp/x").primary.stepId;

// Open questions but the loader is NOT read → static redirect, NOT runtime.
ok(pick({}) === "semantic-annotate",
  "loader not read + no hypothesis → semantic-annotate, NOT runtime-trace", pick({}));
ok(pick({ hasReadHypothesis: true }) === "semantic-annotate",
  "hypothesis but loader not read → still semantic-annotate", pick({ hasReadHypothesis: true }));

// Loader read but no hypothesis on record → record a hypothesis, NOT runtime.
ok(pick({ loaderReadAnnotated: true }) === "record-knowledge",
  "loader read but no hypothesis → record-knowledge, NOT runtime-trace", pick({ loaderReadAnnotated: true }));

// BOTH preconditions met → runtime-trace is finally the proposed step (to CONFIRM).
ok(pick({ loaderReadAnnotated: true, hasReadHypothesis: true }) === "runtime-trace",
  "loader read + hypothesis → runtime-trace (confirm)", pick({ loaderReadAnnotated: true, hasReadHypothesis: true }));

// Sanity: no open questions → §9 does not fire at all, never runtime.
ok(pick({ openQuestions: 0, loaderReadAnnotated: true, hasReadHypothesis: true }) !== "runtime-trace",
  "no open questions → not runtime-trace", pick({ openQuestions: 0, loaderReadAnnotated: true, hasReadHypothesis: true }));

// Sanity: an ungrounded finding still outranks everything (§7b), unchanged by this gate.
ok(pick({ ungroundedFindings: 1, loaderReadAnnotated: true, hasReadHypothesis: true }) === "static-analyze",
  "ungrounded finding still wins (§7b unchanged)", pick({ ungroundedFindings: 1, loaderReadAnnotated: true, hasReadHypothesis: true }));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  static-first ranking: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
