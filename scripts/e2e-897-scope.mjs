#!/usr/bin/env node
// Spec 897 — the contract says which files it is about.
//
// The fixture is issue #39 in miniature: one loadable game that is well named and one
// loadable reference that is not. Every number below is computed from the records, then
// the same records are measured again under a scope.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { saveContract, loadContract, formatContract, KICKOFF_QUESTIONS } = await import("../dist/contract/contract.js");
const { slotReport, formatSlotReport } = await import("../dist/slots/state.js");
const { critique } = await import("../dist/critic/run.js");
const { contractPromises } = await import("../dist/contract/promises.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { registerContractTools } = await import("../dist/server-tools/contract.js");
const { assertBoundary } = await import("../dist/model/store.js");
const { activeWaivers, resetStanding } = await import("../dist/contract/standing.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "scopegame";
const dirs = [];
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "c64re-897-"));
  dirs.push(dir);
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  // game: 1000 loadable bytes; reference: 4000.
  writeFileSync(join(dir, "knowledge", "artifacts.json"), JSON.stringify({ items: [
    { id: "a-game", kind: "prg", title: "game.prg", path: "game.prg", relativePath: "game.prg", scope: "input", fileSize: 1002, tags: [] },
    { id: "a-ref", kind: "prg", title: "reference.prg", path: "reference.prg", relativePath: "reference.prg", scope: "input", fileSize: 4002, tags: [] },
  ] }, null, 2));
  const rid = (owner, kind, a) => `${SLUG}:ram/${owner}:${kind}:${a.toString(16).padStart(4, "0")}`;
  const store = GraphStore.open(dir);
  store.replaceGenerated("test", null, [
    { id: rid("game", "routine", 0x2000), kind: "routine", name: "W2000", endAddress: 0x20ff, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x2100), kind: "routine", name: "W2100", endAddress: 0x21ff, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x2200), kind: "routine", name: "W2200", endAddress: 0x22ff, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x2300), kind: "routine", name: "W2300", endAddress: 0x2340, origin: "static", confidence: "certain" },
    { id: rid("reference", "routine", 0x3000), kind: "routine", name: "W3000", endAddress: 0x30ff, origin: "static", confidence: "certain" },
    { id: rid("reference", "routine", 0x3100), kind: "routine", name: "W3100", endAddress: 0x31ff, origin: "static", confidence: "certain" },
  ], []);
  for (const a of [0x2000, 0x2100, 0x2200]) {
    store.upsertHuman({ id: rid("game", "routine", a), kind: "routine", name: `game_routine_${a.toString(16)}`, origin: "user", confidence: "user_asserted" });
  }
  store.close();
  return dir;
}

function tools(dir) {
  const handlers = new Map();
  registerContractTools({ tool: (name, _d, _s, h) => handlers.set(name, h) }, { projectDir: () => dir });
  return {
    set: async (args) => (await handlers.get("contract_set")(args)).content[0].text,
    show: async (args = {}) => (await handlers.get("contract_show")(args)).content[0].text,
  };
}

const pct = (x) => (x * 100).toFixed(1);
const GOAL = "port the game to a cartridge";

try {
  const d = newProject();
  await assertBoundary(d, { name: "game code", level: "container", start: 0x2000, end: 0x22ff,
    description: "the game", evidence: ["fixture"], owner: "game" });

  // ---- (a) no scope = today's numbers
  saveContract(d, { goal: GOAL, deliver: { namedRatio: 0.9, coverageRatio: 0.9 }, limits: { orphanRatio: 0.4 } });
  const flat = await slotReport(d);
  check("(a) no scope: coverage counts every loadable file",
    flat.coverage.total === 5000 && flat.coverage.covered === 768 && flat.scope === undefined,
    `${flat.coverage.covered}/${flat.coverage.total} = ${pct(flat.coverage.ratio)} %`);
  check("(a) no scope: naming counts every owner", flat.naming.members === 6 && flat.naming.named === 3,
    `${flat.naming.named}/${flat.naming.members}`);
  const flatCrit = await critique(d);
  const flatOrphan = flatCrit.findings.find((f) => f.check === "orphan-ratio");
  check("(a) no scope: orphans counted over both owners (3 of 6 = 50 % > 40 %)",
    !!flatOrphan && /3 of 6/.test(flatOrphan.title) && !/scope/.test(flatOrphan.proof), flatOrphan?.title);

  // ---- (b) scope = game
  saveContract(d, { goal: GOAL, deliver: { scope: [{ file: "game.prg", why: "the shipped image" }], namedRatio: 0.9, coverageRatio: 0.9 }, limits: { orphanRatio: 0.4 } });
  const sc = await slotReport(d);
  check("(b) scope = game: coverage is the game's own",
    sc.coverage.total === 1000 && sc.coverage.covered === 768 && Math.abs(sc.coverage.ratio - 0.768) < 1e-9,
    `${sc.coverage.covered}/${sc.coverage.total} = ${pct(sc.coverage.ratio)} %`);
  check("(b) scope = game: naming is the game's own", sc.naming.members === 4 && sc.naming.named === 3,
    `${sc.naming.named}/${sc.naming.members}`);
  const aside = sc.scope?.outOfScope ?? [];
  check("(b) the reference is reported on its own line with its own numbers",
    aside.length === 1 && aside[0].owner === "reference" && aside[0].bytes === 4000 && aside[0].covered === 0
      && aside[0].members === 2 && aside[0].named === 0,
    JSON.stringify(aside));
  const text = formatSlotReport(sc);
  check("(b) the slot report prints the scope and the set-aside owner, not counted",
    /Scope \(contract\): game\.prg/.test(text) && /out of scope — reported, not counted/.test(text) && /reference\.prg \[reference\]: 0\.0 % covered \(0\/4000 bytes\); 0\.0 % named \(0\/2 nodes\)/.test(text),
    text.split("\n").filter((l) => /cope|reference/.test(l)).join(" | "));
  const promises = await contractPromises(d);
  const named = promises.find((p) => p.id === "namedRatio");
  check("(b) the promise measures the scope and says so",
    !!named && /75\.0 % \(3\/4 nodes/.test(named.now) && /set aside, not counted/.test(named.now), named?.now);

  // ---- (d) orphanRatio follows the scope
  const scCrit = await critique(d);
  check("(d) orphan limit follows the scope: 1 of 4 = 25 % <= 40 % so it no longer fires",
    !scCrit.findings.some((f) => f.check === "orphan-ratio"),
    scCrit.findings.filter((f) => f.check === "orphan-ratio").map((f) => `${f.title} / ${f.proof}`).join(" ; ") || "(none)");
  saveContract(d, { goal: GOAL, deliver: { scope: ["game.prg"] }, limits: { orphanRatio: 0.2 } });
  const tight = (await critique(d)).findings.find((f) => f.check === "orphan-ratio");
  check("(d) and over a tighter limit it counts the game alone and says what it set aside",
    !!tight && /1 of 4/.test(tight.title) && /1 owner\(s\) in the contract's scope, 2 node\(s\) of other owners set aside/.test(tight.proof),
    tight ? `${tight.title} / ${tight.proof}` : "(none)");

  // a payload name and an owner key resolve too; an artifact id does
  for (const entry of ["a-game", "game", "analysis/x/game.prg"]) {
    saveContract(d, { goal: GOAL, deliver: { scope: [entry] } });
    const r = await slotReport(d);
    check(`entry "${entry}" resolves to the game`, r.coverage.total === 1000, `${r.coverage.total}`);
  }

  // ---- (c) an unresolvable entry is refused with candidates, contract.json unchanged
  saveContract(d, { goal: GOAL, deliver: { scope: [{ file: "game.prg", why: "the shipped image" }] } });
  const before = readFileSync(join(d, "knowledge", "contract.json"), "utf8");
  const t = tools(d);
  const refused = await t.set({ goal: GOAL, scope: ["game.prg", "gamme.prg"], coverage_ratio: 0.9 });
  check("(c) contract_set refuses an entry that resolves to no owner",
    /refused/.test(refused) && /no owner answers to: gamme\.prg/.test(refused), refused.split("\n")[0]);
  check("(c) the refusal lists the candidates", /game\.prg/.test(refused) && /reference\.prg/.test(refused));
  check("(c) contract.json is unchanged", readFileSync(join(d, "knowledge", "contract.json"), "utf8") === before);
  // a promise IS owed here, so the waiver would succeed if the scope refusal did not come first
  saveContract(d, { goal: GOAL, deliver: { scope: ["game.prg"], namedRatio: 0.9 } });
  const waiveRefused = await t.set({ scope: ["nope"], waive: ["namedRatio"], waive_reason: "x", waived_by: "me" });
  check("(c) a refused scope records no waiver either", /refused/.test(waiveRefused) && !existsSync(join(d, "knowledge", "contract-standing.json")),
    waiveRefused.split("\n")[0]);

  saveContract(d, { goal: GOAL, deliver: { scope: [{ file: "game.prg", why: "the shipped image" }] } });
  // the tool accepts a good scope, and writes it with its why
  const ok = await t.set({ goal: GOAL, scope: [{ file: "game.prg", why: "the shipped image" }, "reference.prg"], coverage_ratio: 0.9 });
  check("contract_set writes a resolvable scope", /Written:/.test(ok) && loadContract(d).contract.deliver.scope?.length === 2, ok.split("\n")[0]);

  // ---- (f) why is shown
  const shown = await t.show();
  check("(f) formatContract shows the why", /game\.prg — the shipped image/.test(formatContract(loadContract(d).contract, true)));
  check("(f) contract_show shows the why and the set-aside numbers", /game\.prg — the shipped image/.test(shown) && /Scope \(contract\)/.test(shown));

  // ---- (e) D5 hint
  const annotated = formatContract({ goal: GOAL, deliver: { annotate: ["mc_orig_unpacked.prg (game image)"] } }, true);
  check("(e) annotate without a scope says every loadable file is counted",
    annotated.includes("annotate names mc_orig_unpacked.prg (game image); no scope set — every loadable file is counted"), annotated);
  const both = formatContract({ goal: GOAL, deliver: { annotate: ["x"], scope: ["game.prg"] } }, true);
  check("(e) with a scope the hint is not printed", !/no scope set/.test(both));
  check("(e) annotate does not change what is counted", (() => {
    saveContract(d, { goal: GOAL, deliver: { annotate: ["game.prg"] } });
    return true;
  })() && (await slotReport(d)).coverage.total === 5000);

  // ---- no contract: unchanged
  const none = newProject();
  const rn = await slotReport(none);
  check("no contract: default threshold, every file counted, no scope",
    rn.coverage.total === 5000 && rn.coverage.threshold === 0.6 && rn.scope === undefined);

  // ---- (D6/D7) The Magician's Curse in miniature: the file the tools read is not the stem
  // the names sit under, and the low-RAM block is a payload stored in it.
  {
    const dir = mkdtempSync(join(tmpdir(), "c64re-897-mc-"));
    dirs.push(dir);
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
    writeFileSync(join(dir, "knowledge", "artifacts.json"), JSON.stringify({ items: [
      { id: "a-orig", kind: "prg", title: "mc_orig_unpacked.prg", path: "analysis/depack/mc_orig_unpacked.prg", relativePath: "analysis/depack/mc_orig_unpacked.prg", scope: "input", fileSize: 1002, contentHash: "HX", tags: [] },
      { id: "a-game", kind: "prg", title: "mc_game.prg", path: "mc_game.prg", relativePath: "mc_game.prg", scope: "input", fileSize: 1002, contentHash: "HX", tags: [] },
      { id: "a-ref", kind: "prg", title: "reference.prg", path: "reference.prg", relativePath: "reference.prg", scope: "input", fileSize: 4002, contentHash: "HR", tags: [] },
    ] }, null, 2));
    const rid = (owner, kind, a) => `${SLUG}:ram/${owner}:${kind}:${a.toString(16).padStart(4, "0")}`;
    const store = GraphStore.open(dir);
    const payload = (owner, src) => ({ id: rid(owner, "payload", 0x200), kind: "payload", name: owner, endAddress: 0x21f, origin: "static", confidence: "certain", attrs: src ? { payload: { source_artifact_id: src } } : {} });
    store.replaceGenerated("test", null, [
      { id: rid("mc_game", "routine", 0x2000), kind: "routine", name: "W2000", endAddress: 0x20ff, origin: "static", confidence: "certain" },
      { id: rid("mc_game", "routine", 0x2100), kind: "routine", name: "W2100", endAddress: 0x21ff, origin: "static", confidence: "certain" },
      { id: rid("mc_game", "routine", 0x2200), kind: "routine", name: "W2200", endAddress: 0x22ff, origin: "static", confidence: "certain" },
      payload("mc_lowram", "a-orig"),
      { id: rid("mc_lowram", "routine", 0x200), kind: "routine", name: "L0200", endAddress: 0x20f, origin: "static", confidence: "certain" },
      payload("other_blob", undefined),
      { id: rid("other_blob", "routine", 0x200), kind: "routine", name: "O0200", endAddress: 0x20f, origin: "static", confidence: "certain" },
      { id: rid("reference", "routine", 0x3000), kind: "routine", name: "W3000", endAddress: 0x30ff, origin: "static", confidence: "certain" },
    ], []);
    for (const [o, a] of [["mc_game", 0x2000], ["mc_game", 0x2100], ["mc_game", 0x2200], ["mc_lowram", 0x200]]) {
      store.upsertHuman({ id: rid(o, "routine", a), kind: "routine", name: `${o}_routine_${a.toString(16)}`, origin: "user", confidence: "user_asserted" });
    }
    store.close();

    // D6 — the entry names the file the tools read; the names live under its twin.
    saveContract(dir, { goal: GOAL, deliver: { scope: ["mc_orig_unpacked.prg"], coverageRatio: 0.9, namedRatio: 0.9 } });
    const mc = await slotReport(dir);
    check("(D6) scope = the file the tools read counts its twin's ranges, once",
      mc.coverage.total === 1000 && mc.coverage.covered === 768 && mc.coverage.artifacts === 1,
      `${mc.coverage.covered}/${mc.coverage.total}, artifacts ${mc.coverage.artifacts}`);
    check("(D6) the twin's owner is in scope, named by its link",
      (mc.scope?.pulledIn ?? []).some((p) => p.owner === "mc_game" && /^same bytes as mc_orig_unpacked\.prg/.test(p.link)),
      JSON.stringify(mc.scope?.pulledIn));
    check("(D6) the twin's names count; the reference stays out",
      mc.naming.members > 0 && mc.naming.named > 0 && mc.scope?.outOfScope.length === 2
        && mc.scope.outOfScope.some((o) => o.owner === "reference") , JSON.stringify({ n: mc.naming, aside: mc.scope?.outOfScope.map((o) => o.owner) }));
    const mcText = formatSlotReport(mc);
    check("(D6) the report says 'same bytes as'", /same bytes as mc_orig_unpacked\.prg/.test(mcText),
      mcText.split("\n").filter((l) => /same bytes|payload/.test(l)).join(" | "));

    // D7 — the recorded link brings mc_lowram in; the unlinked payload at the same range stays out.
    check("(D7) a payload recorded as stored in the scoped file joins, and the report names the link",
      (mc.scope?.pulledIn ?? []).some((p) => p.owner === "mc_lowram" && /^payload stored in mc_orig_unpacked\.prg/.test(p.link)),
      JSON.stringify(mc.scope?.pulledIn));
    check("(D7) a payload with no recorded link stays out, same address range or not",
      !(mc.scope?.pulledIn ?? []).some((p) => p.owner === "other_blob")
        && (mc.scope?.outOfScope ?? []).some((o) => o.owner === "other_blob" && o.members > 0),
      JSON.stringify(mc.scope?.outOfScope.map((o) => o.owner)));
    // the same link through the twin artifact (D6 + D7), and through a depacked artifact
    const aRaw = JSON.parse(readFileSync(join(dir, "knowledge", "artifacts.json"), "utf8"));
    const viaTwin = await (await import("../dist/contract/scope.js")).resolveScope(dir, ["mc_game.prg"]);
    check("(D6) the entry may name the twin instead: same owners",
      viaTwin.owners.has("mc_game") && viaTwin.owners.has("mc_lowram") && !viaTwin.owners.has("other_blob") && !viaTwin.owners.has("reference"),
      [...viaTwin.owners].join(","));
    check("(D7) the scope without the payload's file does not pull it in",
      !(await (await import("../dist/contract/scope.js")).resolveScope(dir, ["reference.prg"])).owners.has("mc_lowram"));
    void aRaw;
    check("(D6/D7) contract_show prints the links", /also in scope — brought in by a recorded link/.test(await tools(dir).show()));
  }

  // ---- (D8) a waiver whose number moved is listed as lapsed, never under Waived
  {
    const dir = newProject();
    saveContract(dir, { goal: GOAL, deliver: { scope: ["game.prg"], namedRatio: 0.9 } });
    const tt = tools(dir);
    const w = await tt.set({ waive: ["namedRatio"], waive_reason: "demo tonight", waived_by: "Alex" });
    check("(D8) the waiver is recorded", /aiv/.test(w), w.split("\n")[0]);
    const live = await tt.show();
    check("(D8) while the number stands it is listed under Waived, not as lapsed",
      /Waived — the human overruled/.test(live) && !/Lapsed/.test(live), live.split("\n").filter((l) => /Waived|Lapsed|namedRatio/.test(l)).join(" | "));
    saveContract(dir, { goal: GOAL, deliver: { scope: ["game.prg"], namedRatio: 0.85 } });
    const moved = await tt.show();
    check("(D8) after the number changed it is listed as lapsed, not under Waived",
      /Lapsed — recorded, no longer holding:/.test(moved) && /the number changed: waived at .*, the contract now asks/.test(moved) && !/Waived — the human overruled/.test(moved),
      moved.split("\n").filter((l) => /Waived|Lapsed|lapsed/.test(l)).join(" | "));
  }

  // ---- (D9) a waiver is withdrawn explicitly, on the record
  {
    const dir = newProject();
    saveContract(dir, { goal: GOAL, deliver: { scope: ["game.prg"], namedRatio: 0.9 } });
    const tt = tools(dir);
    const ledger = () => readFileSync(join(dir, "knowledge", "contract-standing.json"), "utf8");
    const noWaiver = await tt.set({ unwaive: ["namedRatio"], waive_reason: "changed my mind", waived_by: "Alex" });
    check("(D9) unwaive with no active waiver is refused by name, nothing written",
      /unwaive refused/.test(noWaiver) && /"namedRatio" has no active waiver/.test(noWaiver) && !existsSync(join(dir, "knowledge", "contract-standing.json")),
      noWaiver.split("\n")[0]);
    await tt.set({ waive: ["namedRatio"], waive_reason: "demo tonight", waived_by: "Alex" });
    const afterWaive = ledger();
    check("(D9) the promise is waived before the withdrawal", activeWaivers(dir, await contractPromises(dir)).length === 1);
    const missing = await tt.set({ unwaive: ["namedRatio"], waive_reason: "short", waived_by: "Alex" });
    check("(D9) a withdrawal needs a reason, record unchanged", /unwaive refused/.test(missing) && ledger() === afterWaive, missing.split("\n")[0]);
    const wrongOne = await tt.set({ unwaive: ["coverageRatio"], waive_reason: "changed my mind", waived_by: "Alex" });
    check("(D9) unwaiving another promise is refused, record unchanged", /"coverageRatio" has no active waiver/.test(wrongOne) && ledger() === afterWaive);
    const done = await tt.set({ unwaive: ["namedRatio"], waive_reason: "the bar stands after all", waived_by: "Alex" });
    check("(D9) unwaive is recorded", /Waiver withdrawn by Alex: namedRatio/.test(done), done.split("\n")[0]);
    const rec = JSON.parse(ledger());
    check("(D9) the waiver is still in the record, the withdrawal appended with who/when/why/via",
      rec.waivers?.length === 1 && rec.withdrawals?.length === 1
        && rec.withdrawals[0].by === "Alex" && rec.withdrawals[0].reason === "the bar stands after all"
        && rec.withdrawals[0].via === "contract_set" && !!rec.withdrawals[0].at,
      JSON.stringify(rec.withdrawals));
    const shown = await tt.show();
    check("(D9) contract_show lists it as withdrawn, not under Waived",
      /Lapsed — recorded, no longer holding:/.test(shown) && /withdrawn by Alex, .*: the bar stands after all/.test(shown) && !/Waived — the human overruled/.test(shown),
      shown.split("\n").filter((l) => /Waived|Lapsed|withdrawn/.test(l)).join(" | "));
    check("(D9) the promise blocks again", activeWaivers(dir, await contractPromises(dir)).length === 0
      && (await contractPromises(dir)).some((p) => p.id === "namedRatio"));
    resetStanding(dir);
    check("(D9) the withdrawal survives resetStanding", activeWaivers(dir, await contractPromises(dir)).length === 0 && JSON.parse(ledger()).withdrawals?.length === 1);
    await tt.set({ waive: ["namedRatio"], waive_reason: "demo again, really", waived_by: "Alex" });
    const again = await tt.show();
    check("(D9) re-waive after unwaive is active again; the withdrawn one stays listed",
      activeWaivers(dir, await contractPromises(dir)).length === 1 && /Waived — the human overruled/.test(again) && /withdrawn by Alex/.test(again),
      again.split("\n").filter((l) => /Waived|Lapsed|withdrawn/.test(l)).join(" | "));
    saveContract(dir, { goal: GOAL, deliver: { scope: ["game.prg", "reference.prg"], namedRatio: 0.9 } });
    check("(D9) a scope change retires nothing by itself", activeWaivers(dir, await contractPromises(dir)).length === 1);
  }

  check("the kickoff asks about the scope, as a deliverable", KICKOFF_QUESTIONS.some((q) => q.field === "deliver.scope"));
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
