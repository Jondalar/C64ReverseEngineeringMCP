#!/usr/bin/env node
// Spec 848 — the contract, named-ness, and the recommender invariant.
//
// Every case here exists because the first unattended run produced it. The signal fixture
// below is that run's actual shape: 21 payloads, 2 sources, 0 annotations, 209 findings,
// 9 of them ungrounded — every one of those nine written by slot_record while the agent
// was CORRECTLY complying with Spec 844's S4 gate.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadContract, saveContract, KICKOFF_QUESTIONS, formatContract } = await import("../dist/contract/contract.js");
const { slotReport, isMachineName } = await import("../dist/slots/state.js");
const { pickPrimary } = await import("../dist/server-tools/agent-step.js");
const { verdict } = await import("../dist/critic/run.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
const { DEFAULT_TOOLS } = await import("../dist/server-tools/tier-tools.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "testgame";
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "c64re-848-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  return dir;
}

/** The signal shape of the real unattended run, at the moment it jammed. */
const TRIAL = {
  initialized: true, unregisteredFiles: 0, unregisteredExamples: [], unimportedManifests: 0, staleViews: 0,
  mediaArtifacts: 4, hasG64: true, hasCrt: false,
  extractedPayloads: 21, analysisArtifacts: 1, sourceArtifacts: 2, annotationArtifacts: 0,
  traceArtifacts: 0, openQuestions: 2, unsavedHint: false,
  findings: 209, ungroundedFindings: 9,
  loaderReadAnnotated: true, hasReadHypothesis: true,
};

const dirs = [];
try {
  // ------------------------------------------- the recommender: blockers may not decide
  {
    const jammed = pickPrimary(TRIAL, "/tmp/x");
    check("the real jam now recommends SEMANTIC ANNOTATION, not another analysis pass",
      jammed.primary.phase === "semantic-annotation",
      `phase=${jammed.primary.phase} — it said static-analyze for 27 minutes`);
    check("the ungrounded findings are a BLOCKER, not the primary",
      jammed.blockedBy.some((b) => b.id === "ungrounded-findings"),
      jammed.blockedBy.map((b) => b.id).join(",") || "(none)");
    check("the blocker names the cure rather than repeating the trigger",
      /re-save each with artifact_ids/i.test(jammed.blockedBy[0]?.prompt ?? ""),
      "a rule whose action cannot repair its own trigger is an infinite loop by construction");

    // The invariant this whole refactor buys.
    check("INVARIANT: while a step can advance, the primary is a step and not a complaint",
      !!jammed.primary.step || !!jammed.primary.phase,
      `primary phase=${jammed.primary.phase}`);

    // 752's actual intent survives: the runtime arm stays shut.
    const withQuestions = pickPrimary({ ...TRIAL, annotationArtifacts: 3, openQuestions: 4 }, "/tmp/x");
    check("752's intent survives: the runtime step is NOT offered while something is ungrounded",
      withQuestions.primary.phase !== "runtime-trace",
      `phase=${withQuestions.primary.phase}`);
    const grounded = pickPrimary({ ...TRIAL, annotationArtifacts: 3, openQuestions: 4, ungroundedFindings: 0 }, "/tmp/x");
    check("and it opens once the grounding is fixed",
      grounded.primary.phase === "runtime-trace", `phase=${grounded.primary.phase}`);
  }

  // ------------------------------------------------- the saturation guard
  {
    const d = newProject(); dirs.push(d);
    const { noteRecommendation } = await import("../dist/agent-orchestrator/saturation.js");
    const none = new Set();

    const first3 = [1, 2, 3].map(() => noteRecommendation(d, "static-analyze", ["analysis-present"], none));
    check("a repeated answer is ordinary for the first few turns",
      first3.every((x) => x === undefined), "a step is usually the answer more than once");

    const fourth = noteRecommendation(d, "static-analyze", ["analysis-present"], none);
    check("past the threshold it says how long it has been standing",
      /4th time in a row/.test(fourth ?? "") && /analysis-present. has/.test(fourth ?? ""),
      fourth?.slice(0, 80));
    check("and it names the real possibility, not just the count",
      /running it cannot satisfy that check/.test(fourth ?? ""),
      "that is what the 27-minute jam actually was");

    check("the streak resets when the awaited check is met",
      noteRecommendation(d, "static-analyze", ["analysis-present"], new Set(["analysis-present"])) === undefined,
      "repeating while the world changes is progress; repeating while nothing moves is not");
    check("a different step also resets it",
      noteRecommendation(d, "semantic-annotate", ["annotations-present"], none) === undefined);

    // It must never become a refusal.
    check("it is a NOTE, never a block", typeof (fourth ?? "") === "string" && /^NOTE:/.test(fourth ?? ""),
      "a recommender that refuses to recommend is absurd");
  }

  // ------------------------------------------------------------- named-ness
  {
    check("a machine name is recognised",
      ["unknown_3E00_41D8", "addr_0006", "W9000", "code_1234", "entry_0300"].every(isMachineName));
    check("a real name is not",
      ["build_new_character", "drv_command_loop", "fastloader_transfer", "disk_gateway"].every((n) => !isMachineName(n)));

    const d = newProject(); dirs.push(d);
    const store = GraphStore.open(d);
    const rid = (owner, kind, addr) => `${SLUG}:ram/${owner}:${kind}:${addr.toString(16).padStart(4, "0")}`;
    store.replaceGenerated("test", null, [
      { id: rid("game", "routine", 0x2000), kind: "routine", name: "W2000", endAddress: 0x2040, origin: "static", confidence: "certain" },
      { id: rid("game", "routine", 0x2100), kind: "routine", name: "W2100", endAddress: 0x2140, origin: "static", confidence: "certain" },
      { id: rid("game", "routine", 0x2200), kind: "routine", name: "W2200", endAddress: 0x2240, origin: "static", confidence: "certain" },
      // a payload named after its directory entry — must NOT count as naming
      { id: rid("game", "payload", 0x2000), kind: "payload", name: "01_game", endAddress: 0x3fff, origin: "static", confidence: "certain" },
    ], []);
    // the human layer carries the NAME and no extent, exactly as annotations produce it
    store.upsertHuman({ id: rid("game", "routine", 0x2000), kind: "routine", name: "fastloader_transfer", origin: "user", confidence: "user_asserted" });
    store.close();

    let r = await slotReport(d);
    check("named-ness merges the layers by id", r.naming.named === 1 && r.naming.members === 3,
      `${r.naming.named}/${r.naming.members} — the name is on the human row, the extent on the generated one`);
    check("a payload named after its disk file does not count as naming",
      r.naming.members === 3, "one such node once painted a whole project 100 % named");
    check("the ratio is per node, not per byte", Math.abs(r.naming.ratio - 1 / 3) < 0.01,
      `${(r.naming.ratio * 100).toFixed(1)} % — an annotation gives a name and a start, never an extent`);
  }

  // ---------------------------------------------------------------- the contract
  {
    const d = newProject(); dirs.push(d);
    const { present } = loadContract(d);
    check("no contract = defaults, never a refusal", present === false);
    check("the kickoff questions ask for DELIVERY, not for facts",
      KICKOFF_QUESTIONS.length >= 4 && KICKOFF_QUESTIONS.every((q) => !/^does |^is |^how many .* are/i.test(q.ask)),
      KICKOFF_QUESTIONS.map((q) => q.field).join(", "));

    saveContract(d, {
      goal: "judge whether this can be ported to an EasyFlash cartridge",
      deliver: { slots: ["S1", "S3", "S4"], namedRatio: 0.5 },
      limits: { runtimeRatchet: 2 },
    });
    const loaded = loadContract(d);
    check("the contract round-trips", loaded.present && loaded.contract.deliver.slots.length === 3);

    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    const rep = await slotReport(d);
    const na = rep.states.filter((s) => s.status === "n/a" && /contract does not ask/.test(s.detail));
    check("a contract may demand FEWER slots than the default fourteen", na.length === 11,
      `${na.length} slots marked n/a by the contract — 844 is a template, not a law`);
  }

  // -------------------------------------------------- the verdict reads the contract
  {
    const d = newProject(); dirs.push(d);
    const store = GraphStore.open(d);
    const rid = (a) => `${SLUG}:ram/game:routine:${a.toString(16).padStart(4, "0")}`;
    store.replaceGenerated("test", null, [
      { id: rid(0x2000), kind: "routine", name: "W2000", endAddress: 0x2040, origin: "static", confidence: "certain" },
      { id: rid(0x2100), kind: "routine", name: "W2100", endAddress: 0x2140, origin: "static", confidence: "certain" },
    ], []);
    store.close();
    new KnowledgeRecords(d).saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x2000, end: 0x2040 } });

    saveContract(d, { goal: "understand the loader well enough to port it", deliver: { slots: ["S1"], namedRatio: 0.5 } });
    const v = await verdict(d);
    check("the verdict blocks on the contract's naming demand",
      v.blockers.some((b) => /named 0\.0 %.*below the 50 %/.test(b)),
      v.blockers.find((b) => /named/.test(b)) ?? v.blockers.join(" ; "));
    check("and it says what the number MEANS, not just that it is low",
      v.blockers.some((b) => /counts things with a name/.test(b)));

    // annotate resolves against the MODEL, not against filenames — a contract is written
    // at kickoff, when no address and no payload name is known yet.
    saveContract(d, { goal: "annotate the loader wherever it turns out to be", deliver: { slots: ["S1"], annotate: ["loader"] } });
    const vA = await verdict(d);
    check("an annotate demand with no boundary yet says so, and names the cure",
      vA.blockers.some((b) => /no model boundary is named for it yet \(model_assert\)/.test(b)),
      vA.blockers.find((b) => /loader/.test(b)));

    const { assertBoundary } = await import("../dist/model/store.js");
    await assertBoundary(d, { name: "stage 2 loader", level: "container", start: 0x2000, end: 0x2200,
      description: "the resident loader", evidence: ["header"], owner: "game" });
    const vB = await verdict(d);
    check("with the boundary asserted it reports how much of it carries names",
      vB.blockers.some((b) => /"stage 2 loader" \(asked for as "loader"\) holds 2 routines\/tables and not one carries a human name/.test(b)),
      vB.blockers.find((b) => /stage 2 loader/.test(b)));

    saveContract(d, { goal: "x and then some more words", deliver: { slots: ["S1"], documents: [{ covers: "$2000-$2040", why: "the loader" }] } });
    const v2 = await verdict(d);
    check("the verdict blocks on a demanded document that nobody declared",
      v2.blockers.some((b) => /asks for a document covering \$2000/.test(b)),
      v2.blockers.find((b) => /document/.test(b)));
  }

  // ------------------------------------------------------------------- the surface
  {
    check("the contract tools are on the DEFAULT surface",
      DEFAULT_TOOLS.has("contract_show") && DEFAULT_TOOLS.has("contract_set"));
    check("formatContract says plainly when there is none",
      /No contract set/.test(formatContract(loadContract("/nonexistent").contract, false)));
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe contract holds" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
