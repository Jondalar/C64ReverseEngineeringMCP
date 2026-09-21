#!/usr/bin/env node
// The three defects BUG-056 left open because each one moves data a project
// already holds.
//
//  1. A SUBJECT MUST IDENTIFY ONE THING. `subjectIdForArtifact` was the
//     basename with the directory thrown away, so a three-sided disk project's
//     three `pl0_disasm.asm` were one subject with three tying versions — the
//     reason one sync filed 220 open questions, and the reason
//     `get_current_artifact("pl0")` could hand back another disk's listing.
//  2. `.tas` IS A LISTING. The renderer has written that suffix since
//     2026-09-06 and the version model did not know it, so every modern 64tass
//     listing joined no version group at all.
//  3. `basic_tokenize` REGISTERS ITS OWN OUTPUT, from the parent, like every
//     other door that produces a file.
//
// And the part that makes 1 and 2 safe to ship: a project written under the
// old identity is RE-KEYED on open, with its manual pins, its stale marks, its
// group ids and its members carried across. Fixture 4 is a project in the old
// shape, opened after the change.
//
// Hermetic: temp projects, files of a few bytes, one live MCP session over
// stdio. No ROMs, no media, no assembler, no daemon.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:subject-identity

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const head = (n, t) => console.log(`\n${n} — ${t}`);

console.log("A subject is one thing, a .tas is a listing, and a door registers its own output\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
const { runProjectInventorySync } = await import(join(ROOT, "dist/server-tools/inventory-sync.js"));
const {
  subjectIdForArtifact, subjectStemForArtifact, isVersionedSourceArtifact,
  classifyTopRankTie, orderCandidatesBestFirst, rankCandidate, migrateSubjectIdentity,
} = await import(join(ROOT, "dist/project-knowledge/artifact-versions.js"));

const tmpProject = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const write = (root, rel, body) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  return rel;
};
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

// ───────────────────────────── 1 — three disks, three payloads, three subjects
try {
  head(1, "the same filename on three disks is three subjects, not one");
  const proj = tmpProject("c64re-subj-three-");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Three sides" });
  for (const disk of ["CRAZY1", "CRAZY2", "CRAZY3"]) {
    for (let i = 0; i < 8; i++) write(proj, `analysis/disk/${disk}/pl${i}_disasm.asm`, `; ${disk} listing ${i}\n rts\n`);
  }
  const r = await runProjectInventorySync(svc, proj);
  check(r.versionGroupsCreated === 24, "24 listings, 24 subjects — one per payload, not one per filename", String(r.versionGroupsCreated));
  check(r.versionGroupsNeedDecision === 0, "none of them needs a decision", String(r.versionGroupsNeedDecision));
  check(r.versionTiesAutoResolved === 0, "and none of them TIES — there was never anything to settle", String(r.versionTiesAutoResolved));

  const groups = svc.listArtifactVersionGroups();
  check(groups.every((g) => g.versions.length === 1), "every group holds exactly its own listing",
    String(Math.max(...groups.map((g) => g.versions.length))));
  const subjects = new Set(groups.map((g) => g.subjectId));
  check(subjects.has("analysis/disk/CRAZY1/pl0") && subjects.has("analysis/disk/CRAZY3/pl0"),
    "the subject is where the listing lives plus its stem");

  // The listing the group points at is the one from that group's own directory.
  for (const disk of ["CRAZY1", "CRAZY2", "CRAZY3"]) {
    const current = svc.getCurrentArtifactForSubject(`analysis/disk/${disk}/pl0`);
    check(current?.relativePath === `analysis/disk/${disk}/pl0_disasm.asm`,
      `${disk}'s subject resolves to ${disk}'s own listing`, current?.relativePath ?? "none");
  }

  // A bare filename is no longer an identity. It is answered with the subjects
  // that carry it, never with one of them picked silently.
  const ref = svc.resolveSubjectRef("pl0");
  check(ref.candidates.length === 3, "a bare `pl0` names three subjects, and says which three", ref.candidates.join(" "));
  const one = svc.resolveSubjectRef("pl7");
  check(one.candidates.length === 3, "so does pl7", String(one.candidates.length));
} catch (e) { check(false, "harness", e.message); }

// ─────────────────────────── 2 — a declared lineage is the subject, wherever it sits
try {
  head(2, "a file registered as derived from another is a version of it, in any directory");
  const proj = tmpProject("c64re-subj-lineage-");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Lineage" });
  write(proj, "analysis/disk/D1/loader_disasm.asm", "; generated\n rts\n");
  write(proj, "src/hand/loader.asm", "; hand-written from the generated one\n rts\n");
  const gen = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "loader_disasm.asm", path: "analysis/disk/D1/loader_disasm.asm", format: "kickass", role: "disasm" });
  const hand = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "loader.asm", path: "src/hand/loader.asm", format: "kickass", role: "semantic-source", derivedFrom: gen.id });
  check(svc.subjectIdOf(hand) === svc.subjectIdOf(gen),
    "the derived file takes its ancestor's subject", `${svc.subjectIdOf(hand)} vs ${svc.subjectIdOf(gen)}`);
  await svc.reconcileArtifactVersionGroups();
  const group = svc.getArtifactVersionGroup(svc.subjectIdOf(gen));
  check(group?.versions.length === 2, "both files are in one group", String(group?.versions.length));
  check(group?.currentArtifactId === hand.id, "and the hand-written one is current", group?.currentArtifactId === gen.id ? "the generated one won" : "ok");
  // Without the declaration they are two subjects: two directories, two things.
  check(subjectIdForArtifact(hand) !== subjectIdForArtifact(gen),
    "the located rule alone would have kept them apart — the lineage is what joins them");
} catch (e) { check(false, "harness", e.message); }

// ────────────────────────────────── 3 — .tas joins the model, without moving current
try {
  head(3, "the suffix the renderer writes is a listing");
  const proj = tmpProject("c64re-subj-tas-");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Tas" });
  const asmRel = write(proj, "analysis/disk/D1/pack1_disasm.asm", "; kickass\n rts\n");
  const tasRel = write(proj, "analysis/disk/D1/pack1_disasm.tas", "; 64tass, converted from the kickass one\n rts\n");
  const asm = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "pack1_disasm.asm", path: asmRel, format: "kickass", role: "disasm" });
  const tas = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "pack1_disasm.tas", path: tasRel, format: "64tass", role: "disasm-tass" });
  check(isVersionedSourceArtifact(tas), "a .tas is a versioned source at all");
  check(subjectIdForArtifact(tas) === subjectIdForArtifact(asm), "and shares the .asm's subject");

  await svc.reconcileArtifactVersionGroups();
  const group = svc.getArtifactVersionGroup(subjectIdForArtifact(asm));
  check(group?.versions.length === 2, "the group holds both renderings", String(group?.versions.length));
  check(group?.currentArtifactId === asm.id,
    "the KickAssembler listing stays current — the 64tass file is its conversion, not a newer version",
    group?.currentArtifactId === tas.id ? "the .tas took over" : "ok");
  const verdict = classifyTopRankTie(orderCandidatesBestFirst([asm, tas].map(rankCandidate)));
  check(verdict.kind === "resolved" && verdict.rule === "same-run-dialects",
    "and the tie is settled by a named rule, not by a clock", verdict.kind === "resolved" ? verdict.rule : verdict.kind);
  check(verdict.kind === "resolved" && /converted from/.test(verdict.reason), "which says why", verdict.kind === "resolved" ? verdict.reason : "");

  // A HAND-AUTHORED .tas is the case the version model exists for: it wins.
  const semRel = write(proj, "analysis/disk/D1/pack1_semantic.tas", "; hand-written 64tass\n nop\n");
  const sem = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "pack1_semantic.tas", path: semRel, format: "64tass", role: "semantic-source" });
  await svc.reconcileArtifactVersionGroups();
  const after = svc.getArtifactVersionGroup(subjectIdForArtifact(asm));
  check(after?.currentArtifactId === sem.id, "a hand-authored .tas outranks the generated pair", after?.currentArtifactId ?? "none");
} catch (e) { check(false, "harness", e.message); }

// ────────────────────────────── 4 — a project written under the old identity opens
try {
  head(4, "an existing project keeps its history when the identity changes");
  const proj = tmpProject("c64re-subj-migrate-");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Old shape" });

  // Three disks' pl0, plus CRAZY1's 64tass rendering — the file the old suffix
  // list could not see — and one listing of its own under a fourth directory.
  const made = {};
  for (const disk of ["CRAZY1", "CRAZY2", "CRAZY3"]) {
    const rel = write(proj, `analysis/disk/${disk}/pl0_disasm.asm`, `; ${disk}\n rts\n`);
    made[disk] = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: `${disk} pl0`, path: rel, format: "kickass", role: "disasm" });
  }
  const tasRel = write(proj, "analysis/disk/CRAZY1/pl0_disasm.tas", "; CRAZY1 64tass\n rts\n");
  const tas = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "CRAZY1 pl0 tas", path: tasRel, format: "64tass", role: "disasm-tass" });

  // Hand-write the store the way a project written before this change holds it:
  // ONE group keyed "pl0", all three listings in it, CRAZY2's pinned by hand,
  // CRAZY3's marked stale, and a member whose artifact row is long gone.
  const oldGroup = {
    id: "version-group-pl0-legacy",
    subjectId: "pl0",
    currentArtifactId: made.CRAZY2.id,
    currentSource: "manual",
    needsDecision: true,
    versions: [
      { artifactId: made.CRAZY1.id, role: "generated", format: "kickass", rank: 100, status: "available" },
      { artifactId: made.CRAZY2.id, role: "generated", format: "kickass", rank: 100, status: "current" },
      { artifactId: made.CRAZY3.id, role: "generated", format: "kickass", rank: 100, status: "stale" },
      { artifactId: "artifact-deleted-long-ago", role: "generated", format: "kickass", rank: 100, status: "missing" },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  writeFileSync(join(proj, "knowledge", "artifact-versions.json"), JSON.stringify({
    schemaVersion: 1, updatedAt: "2026-08-01T00:00:00.000Z", items: [oldGroup],
  }, null, 2));
  const before = readJson(proj, "knowledge/artifact-versions.json");
  check(before.subjectIdentity === undefined && before.items.length === 1,
    "the fixture is a store in the old shape: one group, no identity marker");

  // Open it. Nothing else — no sync, no reconcile: the first READ migrates.
  const opened = new ProjectKnowledgeService(proj);
  const groups = opened.listArtifactVersionGroups();
  check(groups.length === 3, "the one group becomes three, one per disk", String(groups.length));
  const store = readJson(proj, "knowledge/artifact-versions.json");
  check(store.subjectIdentity === "located", "and the store records which identity it is keyed by", String(store.subjectIdentity));

  const g1 = opened.getArtifactVersionGroup("analysis/disk/CRAZY1/pl0");
  const g2 = opened.getArtifactVersionGroup("analysis/disk/CRAZY2/pl0");
  const g3 = opened.getArtifactVersionGroup("analysis/disk/CRAZY3/pl0");
  check(!!g1 && !!g2 && !!g3, "each disk's payload has its own group now");

  check(g2?.id === "version-group-pl0-legacy",
    "the partition holding the pinned file keeps the original group's id", g2?.id ?? "none");
  check(g2?.currentSource === "manual" && g2?.currentArtifactId === made.CRAZY2.id,
    "the manual pin survives, on the file it was actually about", `${g2?.currentSource}/${g2?.currentArtifactId === made.CRAZY2.id}`);
  check(g2?.createdAt === "2026-08-01T00:00:00.000Z", "and so does when the group was made", g2?.createdAt ?? "none");

  check(g3?.versions.find((v) => v.artifactId === made.CRAZY3.id)?.status === "stale",
    "the stale mark survives the split", g3?.versions.find((v) => v.artifactId === made.CRAZY3.id)?.status ?? "none");
  check(g1?.currentSource === "auto" && g1?.currentArtifactId === made.CRAZY1.id,
    "a split-off group gets its own best member as an auto current", g1?.currentArtifactId ?? "none");

  const allMembers = groups.flatMap((g) => g.versions.map((v) => v.artifactId));
  check(allMembers.includes("artifact-deleted-long-ago"),
    "a member whose artifact row is gone is kept, not dropped — nothing is lost on the way");
  check(g1?.versions.some((v) => v.artifactId === tas.id && v.status === "available"),
    "the 64tass listing is folded in as available…",
    g1?.versions.find((v) => v.artifactId === tas.id)?.status ?? "absent");
  check(g1?.currentArtifactId !== tas.id,
    "…and never as the current: learning about a suffix may not move a project's listing");

  // Opening again changes nothing, and a later sync agrees with the migration.
  const reopened = new ProjectKnowledgeService(proj);
  const again = reopened.listArtifactVersionGroups();
  check(again.length === 3 && again.find((g) => g.id === "version-group-pl0-legacy")?.currentSource === "manual",
    "a second open is a no-op", String(again.length));
  const r = await runProjectInventorySync(reopened, proj);
  check(r.versionGroupsCreated === 0, "a sync after the migration creates nothing — the groups are already right", String(r.versionGroupsCreated));
  const pinned = reopened.getArtifactVersionGroup("analysis/disk/CRAZY2/pl0");
  check(pinned?.currentSource === "manual" && pinned?.currentArtifactId === made.CRAZY2.id,
    "and it still respects the pin it inherited", `${pinned?.currentSource}`);
} catch (e) { check(false, "harness", e.message); }

// ───────────────────────── 5 — the pure migration, on shapes a service cannot make
try {
  head(5, "the re-keying itself: what it does with a group that does not split");
  const now = "2026-09-20T00:00:00.000Z";
  const artifact = (id, rel) => ({
    id, kind: "generated-source", scope: "analysis", title: id, path: `/p/${rel}`, relativePath: rel,
    sourceArtifactIds: [], entityIds: [], evidence: [], status: "active", confidence: 1, tags: [],
    versions: [], loadContexts: [], format: "kickass", role: "disasm", lineageRoot: id,
    createdAt: now, updatedAt: now,
  });
  const a = artifact("a1", "analysis/x/foo_disasm.asm");
  const b = artifact("b1", "analysis/x/foo_semantic.asm");
  const group = {
    id: "g", subjectId: "foo", currentArtifactId: "b1", currentSource: "manual",
    versions: [
      { artifactId: "a1", role: "generated", format: "kickass", rank: 100, status: "available" },
      { artifactId: "b1", role: "semantic", format: "kickass", rank: 300, status: "current" },
    ],
    createdAt: now, updatedAt: now,
  };
  const out = migrateSubjectIdentity([group], [a, b], now, (s) => `new-${s}`);
  check(out.groups.length === 1, "a group whose members share one subject stays one group", String(out.groups.length));
  check(out.groups[0].subjectId === "analysis/x/foo", "re-keyed to the located subject", out.groups[0].subjectId);
  check(out.groups[0].id === "g" && out.groups[0].currentSource === "manual", "keeping its id and its pin");
  check(out.rekeyed === 1 && out.split === 0, "and it is counted as a re-key, not a split", `${out.rekeyed}/${out.split}`);

  // An empty store migrates to an empty store rather than to an error.
  const none = migrateSubjectIdentity([], [], now, (s) => `new-${s}`);
  check(none.groups.length === 0 && none.rekeyed === 0, "an empty store is an empty store");

  // The stem helper still answers the question it is for: a NAME, not a place.
  check(subjectStemForArtifact(a) === "foo", "the bare stem is still available for name matching", subjectStemForArtifact(a));
} catch (e) { check(false, "harness", e.message); }

// ──────────────────────────────── 6 — basic_tokenize registers from the parent
try {
  head(6, "the last door that let the pipeline child write the store");
  const proj = tmpProject("c64re-subj-basic-");
  const procEnv = { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" };
  const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env: procEnv, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pend = new Map();
  let nid = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ln = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!ln) continue;
      let m;
      try { m = JSON.parse(ln); } catch { continue; }
      if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nid++;
    const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 120000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return (r.result?.content || []).map((c) => c.text).join("\n");
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-subject-identity", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: proj, name: "Basic" });
    await call("agent_onboard", { project_dir: proj });

    const out = "artifacts/generated-src/boot.prg";
    const answer = await call("basic_tokenize", { project_dir: proj, text: "10 SYS 2080\n", output_path: out });
    check(/Bytes: \d+/.test(answer), "the door still tokenizes", answer.split("\n")[0] ?? "");
    check(/Knowledge run: /.test(answer), "and now says which knowledge run the PRG was registered under");

    const runLine = (answer.match(/Knowledge run: (.+)/) ?? [])[1];
    check(!!runLine && existsSync(runLine.trim()), "the run record is on disk", runLine ?? "none");
    const run = runLine ? JSON.parse(readFileSync(runLine.trim(), "utf8")) : {};
    check(run.toolName === "basic_tokenize", "recorded against the MCP door, not the pipeline verb", String(run.toolName));

    const artifacts = readJson(proj, "knowledge/artifacts.json").items;
    const row = artifacts.find((a) => (a.relativePath ?? "").endsWith("boot.prg"));
    check(!!row, "the PRG is in the store");
    check(row?.producedByTool === "basic_tokenize", "produced by the door that was called", String(row?.producedByTool));
    check((run.outputArtifactIds ?? []).includes(row?.id), "and the run names it as its output",
      (run.outputArtifactIds ?? []).join(","));
  } catch (e) {
    check(false, "harness", e.message);
  } finally {
    proc.kill();
  }
} catch (e) { check(false, "harness", e.message); }

// ──────────────── 5 — BUG-060 defect 2: the payload and its listing are one subject
//
// `extract_disk` files a stock-DOS payload under the CBM directory name (`p`), while
// every analysis door files the extracted `03_p.prg`'s rows under the file stem
// (`03_p`). Two owners, so the payload node had nothing under it: a Neuromancer run
// read 0 % classified on seven side-1 DOS files that were fully annotated and rebuilt
// byte-identically, and the coverage measure — which keys on the file stem — saw the
// bytes twice under two names. One subject, not two.
try {
  head(5, "a stock-DOS payload and the listing of its extracted file are one subject");
  const { buildD64 } = await import(join(ROOT, "dist/disk/d64-builder.js"));
  const { extractDiskImage } = await import(join(ROOT, "dist/disk-extractor.js"));
  const { linkExtractedPayloadFiles } = await import(join(ROOT, "dist/lib/extract-auto-chain.js"));
  const { ownerFromAnalysisPath } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
  const { parseId } = await import(join(ROOT, "dist/knowledge-graph/ids.js"));

  const proj = tmpProject("c64re-subj-dosfile-");
  mkdirSync(join(proj, "input"), { recursive: true });
  // Three DOS files with distinct bytes, so nothing is joined by a hash collision.
  const body = (fill, n) => {
    const b = new Uint8Array(n);
    b[0] = 0x00; b[1] = 0x20;
    for (let i = 2; i < n; i += 1) b[i] = fill;
    return b;
  };
  const image = buildD64({
    diskName: "NEURO", diskId: "01", files: [
      { name: "BOOT", payload: body(0x01, 300) },
      { name: "X", payload: body(0x02, 500) },
      { name: "P", payload: body(0x03, 700) },
    ],
  });
  const imagePath = join(proj, "input", "neuro.d64");
  writeFileSync(imagePath, image);

  const outDir = join(proj, "analysis", "disk", "neuro");
  const extracted = extractDiskImage(imagePath, outDir);
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "Neuro side 1" });
  const manifestArtifact = svc.saveArtifact({
    kind: "manifest", scope: "generated", title: "manifest.json",
    path: extracted.manifestPath, role: "disk-manifest", format: "json",
  });
  svc.importManifestArtifact(manifestArtifact.id);
  linkExtractedPayloadFiles(proj, manifestArtifact.id);

  const pFile = extracted.files.find((f) => f.name === "p");
  check(!!pFile && pFile.relativePath === "03_p.prg",
    "extract_disk writes the CBM file `p` as 03_p.prg", pFile?.relativePath ?? "none");
  // What the analysis / disasm producers call it: the file stem.
  const listingOwner = ownerFromAnalysisPath(join(outDir, "03_p_analysis.json"));
  check(listingOwner === "03_p", "the analysis producers file its rows under 03_p", listingOwner);

  const payloadEntity = svc.listEntities().find((e) => e.name === "p" || (e.aliases ?? []).includes("p"));
  check(!!payloadEntity, "the disk file is a payload entity", svc.listEntities().map((e) => e.name).join(","));
  let payloadOwner = "(unparseable)";
  try {
    const parsed = parseId(payloadEntity?.id ?? "");
    payloadOwner = parsed.form === "project" ? (parsed.ctx.owner ?? "(none)") : `(${parsed.form})`;
  } catch (e) { payloadOwner = `(${e.message})`; }
  check(payloadOwner === listingOwner,
    "…and the payload node stands under that same owner — one subject, not two",
    `payload=${payloadOwner} listing=${listingOwner} id=${payloadEntity?.id}`);

  // The CBM name is what the directory says and must not be lost to the file stem.
  const names = [payloadEntity?.name, ...(payloadEntity?.aliases ?? [])].filter(Boolean);
  check(names.includes("p"), "the CBM directory name survives on the entity", names.join(","));

  // The other two agree too — this is not one lucky file.
  for (const [cbm, rel] of [["boot", "01_boot.prg"], ["x", "02_x.prg"]]) {
    const ent = svc.listEntities().find((e) => e.name === cbm || (e.aliases ?? []).includes(cbm));
    let own = "(none)";
    try { const p = parseId(ent?.id ?? ""); own = p.form === "project" ? (p.ctx.owner ?? "(none)") : `(${p.form})`; } catch { /* reported below */ }
    check(own === ownerFromAnalysisPath(rel.replace(/\.prg$/, "_analysis.json")),
      `${cbm} likewise stands under its extracted file's stem`, `${own} vs ${rel}`);
  }
} catch (e) { check(false, "harness (5)", e.message); }

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} subject identity: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
