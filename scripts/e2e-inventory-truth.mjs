// BUG-054 follow-up — three defects an autonomous RE run hit around inventory sync,
// registration debt and version-tie questions. One gate over all three, hermetic:
// temp projects, files of a few bytes, no ROMs, no media, no assembler, no daemon.
//
//  1. One `project_inventory_sync` raised 220 open questions, because every rank tie
//     was treated as a decision a human owes an answer to. A project holding four real
//     open questions ended the call holding 224.
//  2. The leftovers rotated: four runs each named a different handful of files that
//     "no inventory pattern covers", including files a shipped or declared pattern
//     plainly matched. Nothing capped registration — the artifact store's content-hash
//     dedup moved a row onto whichever duplicate path was saved last, so the path that
//     lost its row was unregistered again by the next scan.
//  3. `agent_record_step` warned about 840 unregistered files for exactly the files
//     `project_inventory_sync` reported as 831 declared intentional. One project, two
//     answers — the declaration was read by the sync tool and by nothing else.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (c, m, d = "") => { (c ? pass++ : failCount++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const head = (n, t) => console.log(`\n${n} — ${t}`);

console.log("BUG-054 follow-up — inventory sync, registration debt, version ties\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

const { ProjectKnowledgeService, VERSION_TIE_QUESTION_CAP, VERSION_TIE_CLASS_TITLE } =
  await import(join(ROOT, "dist/project-knowledge/service.js"));
const { runProjectInventorySync } = await import(join(ROOT, "dist/server-tools/inventory-sync.js"));
const { classifyTopRankTie, rankCandidate } = await import(join(ROOT, "dist/project-knowledge/artifact-versions.js"));
const { matchesGlob, scanRegistrationDelta } = await import(join(ROOT, "dist/lib/registration-delta.js"));
const { readInventoryDeclaration, howToDeclare, INVENTORY_PATTERNS_FILE, suggestedKindFor } =
  await import(join(ROOT, "dist/project-knowledge/inventory-patterns.js"));

const tmpProject = (prefix) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(p, "knowledge"), { recursive: true });
  return p;
};
const write = (root, rel, body) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const readJson = (root, rel) => {
  const p = join(root, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).items ?? [] : [];
};
// Since Spec 822.2 the questions live in the graph, not in a JSON file — ask the
// service, which is what every reader does.
const openVersionQuestions = (svc) =>
  svc.listOpenQuestions({ status: "open" }).filter((q) => q.kind === "version-decision");

// ───────────────────────────────────────────────── 1 — what a tie actually is
{
  head(1, "a rank tie is only a decision when a person's answer could differ");

  const art = (id, relativePath, role, contentHash) => ({
    id, relativePath, path: relativePath, title: relativePath.split("/").pop(),
    kind: "generated-source", scope: "analysis", role, contentHash,
    updatedAt: "2026-09-20T10:00:00.000Z",
  });

  const sameBytes = [
    rankCandidate(art("a", "analysis/disk/CRAZY1/deep/04_pack2_semantic.asm", "semantic-source", "hhh")),
    rankCandidate(art("b", "analysis/disk/C2/04_pack2_semantic.asm", "semantic-source", "hhh")),
  ];
  const v1 = classifyTopRankTie(sameBytes);
  check(v1.kind === "resolved" && v1.rule === "same-bytes", "identical bytes at two paths are one listing, not a question", v1.kind + "/" + (v1.rule ?? ""));
  check(v1.kind === "resolved" && v1.winner.artifact.id === "b", "and the winner is deterministic (shortest path), not whichever sorted first", v1.kind === "resolved" ? v1.winner.artifact.id : "");
  check(v1.kind === "resolved" && /04_pack2_semantic\.asm/.test(v1.reason), "and the rule says which file it picked", v1.kind === "resolved" ? v1.reason : "");

  const generated = [
    rankCandidate(art("c", "analysis/disk/CRAZY1/04_pack2_disasm.asm", "disasm", "h1")),
    rankCandidate(art("d", "analysis/disk/CRAZY2/04_pack2_disasm.asm", "disasm", "h2")),
  ];
  const v2 = classifyTopRankTie(generated);
  check(v2.kind === "resolved" && v2.rule === "machine-output", "two generated dumps are a deterministic run, not a decision", v2.kind + "/" + (v2.rule ?? ""));

  const handAuthored = [
    rankCandidate(art("e", "analysis/disk/CRAZY1/04_pack2_semantic.asm", "semantic-source", "h1")),
    rankCandidate(art("f", "analysis/disk/CRAZY1/04_pack2_curated.tass", "semantic-source", "h2")),
  ];
  const v3 = classifyTopRankTie(handAuthored);
  check(v3.kind === "decision", "two different hand-authored sources still ask, because guessing overwrites somebody's work", v3.kind);

  check(classifyTopRankTie([rankCandidate(art("g", "analysis/x_semantic.asm", "semantic-source", "h1"))]).kind === "no-tie",
    "a lone candidate is not a tie");
}

// ───────────────────────────────────────── 2 — 220 generated ties raise no questions
{
  head(2, "a sync cannot bury a project's real open questions");
  const proj = tmpProject("c64re-tie-generated-");
  for (const disk of ["CRAZY1", "CRAZY2", "CRAZY3"]) {
    for (let i = 0; i < 8; i++) {
      write(proj, `analysis/disk/${disk}/pl${i}_disasm.asm`, `; ${disk} listing ${i}\n rts\n`);
    }
  }
  const svc = new ProjectKnowledgeService(proj);
  const r = await runProjectInventorySync(svc, proj);
  // The 220 questions came from two defects stacked on each other. The tie
  // rules were the first half; the second is that these 24 listings never had
  // anything to tie ABOUT. They are three disks' worth of payloads that happen
  // to share eight filenames, and a subject is where a listing lives plus its
  // stem — so there are 24 subjects here, each holding its own single listing.
  check(r.versionGroupsCreated === 24, "24 listings under three disks are 24 subjects, not eight", String(r.versionGroupsCreated));
  check(r.versionTiesAutoResolved === 0, "and there is no tie left to settle by rule", String(r.versionTiesAutoResolved));
  check(r.versionGroupsNeedDecision === 0, "so not one of them becomes a question", String(r.versionGroupsNeedDecision));
  check(openVersionQuestions(svc).length === 0, "and the project's question list stays empty", String(openVersionQuestions(svc).length));
  const groups = readJson(proj, "knowledge/artifact-versions.json");
  check(groups.every((g) => g.needsDecision === undefined), "no group is left flagged for a decision either");
  check(groups.every((g) => g.versions.length === 1), "no group holds another disk's listing",
    String(Math.max(...groups.map((g) => g.versions.length))));
}

// ───────────────────────────────────── 3 — real ties: a few by name, many as a class
{
  head(3, "genuine ties are asked — capped, and closed when they are answered");
  const proj = tmpProject("c64re-tie-real-");
  const subjects = 3;
  for (let i = 0; i < subjects; i++) {
    write(proj, `analysis/disk/D1/s${i}_semantic.asm`, `; kickass hand-written ${i}\n rts\n`);
    write(proj, `analysis/disk/D1/s${i}_curated.tass`, `; 64tass hand-written ${i}\n nop\n`);
  }
  const svc = new ProjectKnowledgeService(proj);
  const r = await runProjectInventorySync(svc, proj);
  check(r.versionGroupsNeedDecision === subjects, `${subjects} hand-authored ties are real decisions`, String(r.versionGroupsNeedDecision));
  check(r.versionQuestionsFiled === subjects, "few enough to name one by one", String(r.versionQuestionsFiled));
  const qs = openVersionQuestions(svc);
  check(qs.length === subjects, "one question per subject while there are few", String(qs.length));
  check(qs.every((q) => /set_current_artifact_version\(subject_id=/.test(q.description ?? "")),
    "each names the call that settles it, with the argument filled in");

  // Answering one closes it. Nothing closed a version-decision question before, so the
  // remedy the tool recommended never removed the item it was recommended for.
  const arts = readJson(proj, "knowledge/artifacts.json");
  const pick = arts.find((a) => (a.relativePath ?? "").endsWith("s0_semantic.asm"));
  svc.setCurrentArtifactVersion("s0", pick.id);
  check(openVersionQuestions(svc).length === subjects - 1,
    "answering one with set_current_artifact_version closes its question", String(openVersionQuestions(svc).length));
  const after = await runProjectInventorySync(svc, proj);
  check(after.versionGroupsNeedDecision === subjects - 1, "and a later sync does not re-open it", String(after.versionGroupsNeedDecision));
  check(openVersionQuestions(svc).length === subjects - 1, "nor file it again", String(openVersionQuestions(svc).length));
}

{
  head(4, "past the cap it is one question about the class, not one per instance");
  const proj = tmpProject("c64re-tie-class-");
  const subjects = VERSION_TIE_QUESTION_CAP + 4;
  for (let i = 0; i < subjects; i++) {
    write(proj, `analysis/disk/D1/s${i}_semantic.asm`, `; kickass hand-written ${i}\n rts\n`);
    write(proj, `analysis/disk/D1/s${i}_curated.tass`, `; 64tass hand-written ${i}\n nop\n`);
  }
  // A real question, of the kind the 220 buried.
  const svc = new ProjectKnowledgeService(proj);
  svc.saveOpenQuestion({ kind: "loader", title: "Where does the fastloader hand control back?", status: "open", source: "static-analysis" });
  const r = await runProjectInventorySync(svc, proj);
  check(r.versionGroupsNeedDecision === subjects, `${subjects} subjects tie`, String(r.versionGroupsNeedDecision));
  check(r.versionQuestionsFiled === 1, "and exactly one question is filed", String(r.versionQuestionsFiled));
  const qs = openVersionQuestions(svc);
  check(qs.length === 1 && qs[0].title === VERSION_TIE_CLASS_TITLE, "which is the class question", qs.map((q) => q.title).join(" | "));
  check(new RegExp(`${subjects} subjects`).test(qs[0].description ?? ""), "it states how many, and names a sample", (qs[0].description ?? "").slice(0, 80));
  const allOpen = svc.listOpenQuestions({ status: "open" });
  check(allOpen.length === 2, "the project's real question is still one of two, not one of ten", String(allOpen.length));
  const text = r.remainingProblems.join("\n");
  void text;
}

// ─────────────────────────────────────────────── 5 — the leftovers stop rotating
{
  head(5, "two files with the same bytes are two files");
  check(matchesGlob("analysis/payloads/CRAZY2/94_pcngfx_titel1.prg", "analysis/payloads/*/*.prg"),
    "analysis/payloads/*/*.prg matches a payload one directory down");
  check(matchesGlob("analysis/payloads/94_top.prg", "analysis/payloads/**/*.prg"),
    "and **/ still matches a file at the top of its directory");
  check(!matchesGlob("analysis/payloads/A/B/deep.prg", "analysis/payloads/*/*.prg"),
    "while a single * does not cross a directory boundary");

  const proj = tmpProject("c64re-rotate-");
  for (const disk of ["CRAZY1", "CRAZY2"]) {
    for (let i = 0; i < 6; i++) {
      // 0..2 are byte-identical across the two disks (the same title screen twice).
      write(proj, `analysis/payloads/${disk}/${i}_thing.prg`, i < 3 ? `SHARED${i}` : `${disk}-${i}`);
    }
  }
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [{ glob: "analysis/payloads/*/*.prg", kind: "prg", scope: "analysis", role: "payload" }],
    intentional: [],
  }));
  const svc = new ProjectKnowledgeService(proj);
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await runProjectInventorySync(svc, proj));
  check(runs[0].registered === 12, "the first run registers all twelve", String(runs[0].registered));
  check(readJson(proj, "knowledge/artifacts.json").length === 12,
    "twelve files on disk are twelve rows, duplicates included", String(readJson(proj, "knowledge/artifacts.json").length));
  check(runs.slice(1).every((r) => r.registered === 0),
    "and the next three runs register nothing — the store is settled", runs.map((r) => r.registered).join(","));
  const unexplained = runs.flatMap((r) => r.skipped.filter((s) => /no inventory pattern/.test(s.reason)).map((s) => s.path));
  check(unexplained.length === 0, "no run reports a file a declared pattern plainly matches", unexplained.slice(0, 3).join(", "));
}

// ───────────────────────────────────── 6 — the declaration's own errors are legible
{
  head(6, "a declaration that is wrong says so, in its own words");
  const proj = tmpProject("c64re-decl-");
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [
      { glob: "analysis/payloads/*/*.prg", kind: "annotations", scope: "analysis" },
      { glob: "analysis/notes/*.md", kind: "other", scope: "everywhere" },
      { kind: "prg", scope: "analysis" },
      { glob: "analysis/ok/*.prg", kind: "prg", scope: "analysis", role: "payload" },
    ],
    intentional: ["analysis/rebuild/verify-*.json"],
    patterns_typo: [],
  }));
  const d = readInventoryDeclaration(proj);
  check(d.patterns.length === 1 && d.patterns[0].glob === "analysis/ok/*.prg",
    "the three broken entries are dropped and the good one is kept", String(d.patterns.length));
  const all = d.problems.join("\n");
  check(/patterns\[0\]\.kind = "annotations" is not a known artifact kind/.test(all),
    "the bad kind is named with its index and its value", d.problems.find((p) => /annotations/.test(p)) ?? "");
  check(/Did you mean "report"\?/.test(all), "and the near miss is offered");
  check(/prg, crt, d64/.test(all), "with the vocabulary that is allowed");
  check(/patterns\[1\]\.scope = "everywhere"/.test(all), "the bad scope likewise");
  check(/patterns\[2\]\.glob is required/.test(all), "a missing glob is a problem, not a silent drop");
  check(/unknown top-level key "patterns_typo"/.test(all), "and a mistyped top-level key is called out");
  check(d.intentional.length === 1, "while the intentional list still applies");

  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), "{ not json");
  const broken = readInventoryDeclaration(proj);
  check(typeof broken.error === "string" && /could not be read/.test(broken.error), "an unparseable file is reported, never swallowed", broken.error);
}

{
  head(7, "the suggested declaration fits the files it is suggested for");
  check(suggestedKindFor("analysis/sym/thing.sym") === "other", "a .sym is not a prg", suggestedKindFor("analysis/sym/thing.sym"));
  check(suggestedKindFor("analysis/x/thing_analysis.json") === "analysis-run", "an analysis JSON is an analysis run", suggestedKindFor("analysis/x/thing_analysis.json"));
  check(suggestedKindFor("analysis/payloads/D/94_titel.prg") === "prg", "a payload is a prg");
  const examples = [
    "analysis/payloads/CRAZY1/94_titel.prg",
    "analysis/payloads/CRAZY2/95_music.prg",
    "analysis/payloads/CRAZY2/96_pic.sym",
  ];
  const lines = howToDeclare(examples).join("\n");
  const globs = [...lines.matchAll(/"glob":"([^"]+)"/g)].map((m) => m[1]);
  check(globs.length === 2, "one entry per file type present, not one guess for all of them", globs.join(" | "));
  check(globs.some((g) => matchesGlob(examples[0], g)), "and the suggested glob actually matches the files it was derived from", globs.join(" | "));
  check(/"kind":"other"/.test(lines), "the .sym group is offered the kind that fits it", lines.split("\n").find((l) => /sym/.test(l)) ?? "");
  check(/Allowed kind:/.test(lines) && /Allowed scope:/.test(lines), "and the allowed vocabularies are stated where the mistake is made");
}

// ────────────────────────── 8 — one project, one answer about the same files
{
  head(8, "the shared scan knows what the project declared");
  const proj = tmpProject("c64re-shared-scan-");
  for (let i = 0; i < 5; i++) write(proj, `analysis/rebuild/verify-${i}.json`, `{"ok":${i}}`);
  write(proj, "analysis/stray/loose.bin", "xx");
  const before = scanRegistrationDelta(proj, 50);
  check(before.unregisteredCount === 6, "with no declaration, all six are debt", String(before.unregisteredCount));
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [], intentional: ["analysis/rebuild/verify-*.json"],
  }));
  const after = scanRegistrationDelta(proj, 50);
  check(after.unregisteredCount === 1, "the declared five leave the debt count", String(after.unregisteredCount));
  check(after.declaredIntentionalCount === 5, "and are reported as the project's own statement", String(after.declaredIntentionalCount));
  check(!Object.keys(after.unregisteredByExt).includes(".json"), "the by-extension breakdown agrees with the count", JSON.stringify(after.unregisteredByExt));
}

// ───────────────────────────────────────────── live, through the real MCP server
{
  head(9, "agent_record_step and project_inventory_sync answer the same about the same files");
  const proj = tmpProject("c64re-live-inv-");
  const server = spawn(process.execPath, [cli], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d.toString(); });
  let buf = "";
  const pending = new Map();
  server.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    return (res.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-inventory-truth", version: "1.0" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: proj, name: "Inventory Truth" });
    await call("agent_onboard", { project_dir: proj });

    // Nine files the project declares intentional, three it does not.
    for (let i = 0; i < 9; i++) write(proj, `analysis/rebuild/verify-${i}.json`, `{"ok":${i}}`);
    for (let i = 0; i < 3; i++) write(proj, `analysis/stray/loose-${i}.bin`, `x${i}`);
    writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
      patterns: [], intentional: ["analysis/rebuild/verify-*.json"],
    }));

    const sync = await call("project_inventory_sync", { project_dir: proj });
    const syncDebt = Number(/(\d+) file\(s\) on disk match no registration pattern/.exec(sync)?.[1] ?? "-1");
    const syncIntentional = Number(/(\d+) further file\(s\) are declared intentional/.exec(sync)?.[1] ?? "-1");
    check(syncDebt === 3, "the sync counts three files as debt", String(syncDebt));
    check(syncIntentional === 9, "and nine as the project's own statement", String(syncIntentional));

    const step = await call("agent_record_step", { project_dir: proj, step: "declared the rebuild receipts" });
    const stepDebt = Number(/⚠ (\d+) files on disk are NOT registered/.exec(step)?.[1] ?? "0");
    const stepIntentional = Number(/\((\d+) further file\(s\) are declared intentional/.exec(step)?.[1] ?? "-1");
    check(stepDebt === syncDebt, "agent_record_step warns about the same three, not about all twelve", `${stepDebt} vs ${syncDebt}`);
    check(stepIntentional === syncIntentional, "and names the same nine as declared", `${stepIntentional} vs ${syncIntentional}`);

    // A declaration mistake reaches the step recorder too, from the one reader.
    writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
      patterns: [{ glob: "analysis/stray/*.bin", kind: "annotations", scope: "analysis" }], intentional: [],
    }));
    const step2 = await call("agent_record_step", { project_dir: proj, step: "broke the declaration" });
    check(/is not a known artifact kind/.test(step2), "a broken declaration is legible wherever the count is reported",
      (step2.split("\n").find((l) => /not a known artifact kind/.test(l)) ?? "").slice(0, 90));
    const sync2 = await call("project_inventory_sync", { project_dir: proj });
    check(/is not a known artifact kind/.test(sync2), "and in the sync's own remaining problems");

    // ─────────── BUG-059 defect 4: a readable answer, and a glob that matched nothing
    //
    // One `project_inventory_sync` came back at 146 728 characters over 5 833
    // lines and blew the client's tool-result limit. And a well-formed declared
    // pattern that matched nothing was accepted in silence — a project declared
    // `analysis/overlays/*.prg`, saw no complaint, and 207 outputs stayed
    // unregistered with nothing anywhere saying why.
    //
    // 400 files under a directory no shipped pattern covers, at a depth the
    // project's own declaration does not reach.
    for (let i = 0; i < 400; i += 1) {
      write(proj, `analysis/overlays/set${i % 8}/ov${i}.prg`, Buffer.from([0x00, 0x20, 0xea]));
    }
    // …and 60 in a directory a TOOL owns. Those are not human debt, so they were
    // held out of the debt list — and then reported nowhere at all, which is how
    // a run's own outputs stay unregistered with the sync saying nothing.
    for (let i = 0; i < 60; i += 1) {
      write(proj, `analysis/depack/out${i}.bin`, Buffer.from([0xea, 0xea]));
    }
    writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
      patterns: [{ glob: "analysis/overlays/*.prg", kind: "prg", scope: "analysis", role: "overlay" }],
      intentional: [],
    }, null, 2));
    const bigSync = await call("project_inventory_sync", { project_dir: proj });
    check(bigSync.length <= 8000, "the answer fits in something a client will show",
      `${bigSync.length} chars, ${bigSync.split("\n").length} lines`);
    check(/Full detail: knowledge\/inventory-sync-report\.md/.test(bigSync),
      "…and names where the rest of it is", bigSync.split("\n").find((l) => /Full detail/.test(l)));
    check(existsSync(join(proj, "knowledge", "inventory-sync-report.md")), "…which exists on disk");
    const reportAbs = join(proj, "knowledge", "inventory-sync-report.md");
    const report = existsSync(reportAbs) ? readFileSync(reportAbs, "utf8") : "";
    check(/# Inventory sync/.test(report) && report.length > bigSync.length,
      "…and holds more than the answer did", `${report.length} vs ${bigSync.length} chars`);
    check(/matched no file/.test(bigSync),
      "a declared pattern that matched nothing is NAMED", bigSync.split("\n").find((l) => /matched no file/.test(l)));
    check(/analysis\/overlays\/ holds 400 file\(s\)/.test(bigSync),
      "…with what is actually in that directory", bigSync.split("\n").find((l) => /holds 400/.test(l)));
    check(/`\*` stops at a path separator/.test(bigSync) && /analysis\/overlays\/\*\*\/\*\.prg/.test(bigSync),
      "…and the reason it missed, with a pattern that would not",
      bigSync.split("\n").find((l) => /stops at a path separator/.test(l)));
    check(/tool-produced file\(s\) are on disk and registered by nothing/.test(bigSync),
      "outputs nothing registered are reported, not silently dropped",
      bigSync.split("\n").find((l) => /registered by nothing/.test(l)));
    // The 146 728-character answer, reproduced by the path that could actually
    // run away: every problem line was printed, unbounded, at full length. 400
    // malformed declaration entries each produce a named problem carrying the
    // whole allowed vocabulary.
    writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
      patterns: Array.from({ length: 400 }, (_, i) => ({ glob: `analysis/x${i}/*.prg`, kind: "annotations", scope: "analysis" })),
      intentional: [],
    }, null, 2));
    const floodSync = await call("project_inventory_sync", { project_dir: proj });
    check(floodSync.length <= 8000, "400 malformed declaration entries still come back readable",
      `${floodSync.length} chars, ${floodSync.split("\n").length} lines`);
    check(/more, in the report file named below/.test(floodSync) && /Full detail:/.test(floodSync),
      "…saying how many were elided and where they are",
      floodSync.split("\n").find((l) => /more, in the report file/.test(l)));
    const floodReport = existsSync(reportAbs) ? readFileSync(reportAbs, "utf8") : "";
    check((floodReport.match(/is not a known artifact kind/g) ?? []).length === 400,
      "…and the report file holds every one of them",
      `${(floodReport.match(/is not a known artifact kind/g) ?? []).length} of 400`);

    writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
      patterns: [{ glob: "analysis/overlays/**/*.prg", kind: "prg", scope: "analysis", role: "overlay" }],
      intentional: [],
    }, null, 2));
    const fixedSync = await call("project_inventory_sync", { project_dir: proj });
    const registered = Number(/Files registered: (\d+)/.exec(fixedSync)?.[1] ?? "0");
    check(registered >= 400, "and the corrected pattern registers all 400", `${registered}`);
    check(!/matched no file/.test(fixedSync), "…with no empty-pattern complaint left");
  } catch (e) {
    failCount += 1;
    console.log(`  FAIL  live phase threw: ${e.message}${stderr ? " | stderr: " + stderr.slice(-300) : ""}`);
  } finally {
    server.stdin.end();
    server.kill();
  }
}

// ───────── 10 — BUG-060 defect 1: a tool's bulk is not knowledge, and there is a way back
//
// `project_inventory_sync` reported "2747 tool-produced file(s) are on disk and
// registered by nothing" in the same answer as an inventory-patterns.json skeleton.
// The caller did the obvious thing: it wrote a `patterns` entry for the bulk and
// registered 2732 per-sector .bin dumps. Coverage fell from 22.2 % to 7.6 % without a
// single byte becoming less understood, and moving the glob to `intentional` afterwards
// only stopped NEW registrations — the rows stayed, the next sync said
// "Files registered: 0", and there was no door that takes a row back out.
{
  head(10, "a bulk a tool wrote costs something to register, and can be taken back out");
  const { slotReport } = await import(join(ROOT, "dist/slots/state.js"));
  let unregisterProjectFiles;
  try {
    ({ unregisterProjectFiles } = await import(join(ROOT, "dist/server-tools/registration.js")));
  } catch (e) { check(false, "the registration module loads", e.message); }

  const proj = tmpProject("c64re-toolbulk-");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Tool bulk" });

  // One real payload — the material coverage is actually about.
  const payload = Buffer.alloc(4098);
  payload[0] = 0x00; payload[1] = 0x20;
  for (let i = 2; i < payload.length; i += 1) payload[i] = 0xea;
  write(proj, "analysis/payloads/01_loader.prg", payload);
  // …and 120 per-sector dumps a tool wrote into a directory it owns. Distinct bytes:
  // identical files collapse to one row and the cost would not show.
  const SECTORS = 120;
  for (let i = 0; i < SECTORS; i += 1) {
    const b = Buffer.alloc(254, i & 0xff);
    b.writeUInt16LE(i, 0);
    write(proj, `analysis/g64/side1/track-${18 + Math.floor(i / 40)}/s${i % 40}.bin`, b);
  }
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [{ glob: "analysis/payloads/*.prg", kind: "prg", scope: "analysis", role: "payload" }],
    intentional: [],
  }, null, 2));

  const r = await runProjectInventorySync(svc, proj);
  const text = r.remainingProblems.join("\n");
  check(r.unregisteredToolOutput === SECTORS, `all ${SECTORS} dumps are seen as tool output`, String(r.unregisteredToolOutput));
  check(/analysis\/g64/.test(text), "the bulk is named by the directory that holds it",
    text.split("\n").find((l) => /analysis\/g64/.test(l)) ?? "");
  check(/machine output/i.test(text), "…and the report says what they ARE — machine output, not debt",
    text.split("\n").find((l) => /machine output/i.test(l)) ?? "");
  check(/coverage/i.test(text) && new RegExp(String(SECTORS * 254)).test(text),
    "…and what registering them would cost, in bytes and in coverage",
    text.split("\n").find((l) => /coverage/i.test(l)) ?? "");
  check(/"intentional":\s*\[\s*"analysis\/g64/.test(text),
    "the remedy offered for a tool's bulk is `intentional`, which only silences",
    text.split("\n").find((l) => /intentional/.test(l)) ?? "");
  check(!/"glob"\s*:\s*"analysis\/g64/.test(text),
    "…and NOT a `patterns` entry, which would register every one of them",
    text.split("\n").find((l) => /"glob"\s*:\s*"analysis\/g64/.test(l)) ?? "");
  check(/unregister_files/.test(text), "…and the way back is named where the mistake is made",
    text.split("\n").find((l) => /unregister_files/.test(l)) ?? "");

  // The cost, measured rather than asserted.
  const before = await slotReport(proj);
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [
      { glob: "analysis/payloads/*.prg", kind: "prg", scope: "analysis", role: "payload" },
      { glob: "analysis/g64/**/*.bin", kind: "raw", scope: "analysis", role: "raw-block" },
    ],
    intentional: [],
  }, null, 2));
  const r2 = await runProjectInventorySync(svc, proj);
  check(r2.registered === SECTORS, "taking the bad advice registers the whole bulk", String(r2.registered));
  const after = await slotReport(proj);
  check(after.coverage.total > before.coverage.total,
    "…and the coverage denominator grows by bytes nobody understood any better",
    `${before.coverage.total} → ${after.coverage.total}`);

  // The way back.
  let undo;
  try {
    undo = unregisterProjectFiles(svc, proj, { glob: "analysis/g64/**/*.bin" });
  } catch (e) { check(false, "unregister_files exists and runs", e.message); }
  check(undo?.removed === SECTORS, "the door back removes exactly the rows that glob registered",
    `removed=${undo?.removed} kept=${undo?.kept?.length}`);
  const back = await slotReport(proj);
  check(back.coverage.total === before.coverage.total,
    "…and the coverage denominator is what it was before the mistake",
    `${before.coverage.total} → ${after.coverage.total} → ${back.coverage.total}`);
  const stillThere = readJson(proj, "knowledge/artifacts.json").filter((a) => /analysis\/g64\//.test(a.relativePath ?? ""));
  check(stillThere.length === 0, "no row for that glob is left in the store", String(stillThere.length));
  check(existsSync(join(proj, "analysis/g64/side1/track-18/s0.bin")),
    "and it un-REGISTERS — the files on disk are untouched");

  // It refuses to take out a row somebody has written something about.
  writeFileSync(join(proj, INVENTORY_PATTERNS_FILE), JSON.stringify({
    patterns: [
      { glob: "analysis/payloads/*.prg", kind: "prg", scope: "analysis", role: "payload" },
      { glob: "analysis/g64/**/*.bin", kind: "raw", scope: "analysis", role: "raw-block" },
    ],
    intentional: [],
  }, null, 2));
  await runProjectInventorySync(svc, proj);
  const studied = readJson(proj, "knowledge/artifacts.json").find((a) => /analysis\/g64\//.test(a.relativePath ?? ""));
  svc.saveFinding({
    kind: "observation", title: "this sector holds the LUT", status: "confirmed",
    artifactIds: [studied.id], addressRange: { start: 0x0400, end: 0x04fd },
  });
  try {
    const undo2 = unregisterProjectFiles(svc, proj, { glob: "analysis/g64/**/*.bin" });
    check(undo2.removed === SECTORS - 1, "a second pass removes the rest", String(undo2.removed));
    check(undo2.kept.some((k) => k.artifactId === studied.id && /finding/i.test(k.reason)),
      "…but refuses the one somebody wrote a finding about, and says why",
      JSON.stringify(undo2.kept.slice(0, 2)));
    check(readJson(proj, "knowledge/artifacts.json").some((a) => a.id === studied.id),
      "…which is still in the store");
  } catch (e) {
    check(false, "the door back refuses a row that carries a finding", e.message);
  }
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} e2e-inventory-truth: ${pass} passed, ${failCount} failed.`);
process.exit(failCount === 0 ? 0 : 1);
