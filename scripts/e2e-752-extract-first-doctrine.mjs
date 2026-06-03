// Spec 752 — extract-first grounding doctrine.
// S1: doctrine text (agent-doctrine L1 + default steering provisioning).
// (Later slices S2-S8 append their own sections to this gate.)
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 752 — extract-first grounding doctrine\n");
console.log("S1 — doctrine text + default steering provisioning\n");

const { ensureDefaultSteering, EXTRACT_FIRST_MARKER } = await import(`${ROOT}/dist/server-tools/steering-defaults.js`);

// Fresh project → steering.md created with the extract-first block.
const dir = mkdtempSync(join(tmpdir(), "c64re-752-"));
const steeringPath = join(dir, "knowledge", "steering.md");
const r1 = ensureDefaultSteering(dir);
ok(r1 === "created", "S1 fresh project → steering.md created", `r=${r1}`);
ok(existsSync(steeringPath), "S1 steering.md exists");
const sContent = readFileSync(steeringPath, "utf8");
ok(sContent.includes(EXTRACT_FIRST_MARKER), "S1 steering carries the extract-first marker");
ok(/\bL1\b/.test(sContent) && /\bL2\b/.test(sContent), "S1 steering states both laws (L1 + L2)");
ok(/artifact_ids/.test(sContent) && /disasm/.test(sContent), "S1 steering names artifact_ids + disasm");

// Idempotent — second call is a no-op.
ok(ensureDefaultSteering(dir) === "present", "S1 idempotent → present on re-run");

// Existing hand-written steering WITHOUT the block → appended, not clobbered.
const dir2 = mkdtempSync(join(tmpdir(), "c64re-752b-"));
mkdirSync(join(dir2, "knowledge"), { recursive: true });
writeFileSync(join(dir2, "knowledge", "steering.md"), "# Project steering\n\n- my own rule\n");
const r2 = ensureDefaultSteering(dir2);
const s2 = readFileSync(join(dir2, "knowledge", "steering.md"), "utf8");
ok(r2 === "appended", "S1 existing steering → appended", `r=${r2}`);
ok(s2.includes("my own rule") && s2.includes(EXTRACT_FIRST_MARKER), "S1 append preserves the hand-written rule + adds the block");

// Universal law in docs/agent-doctrine.md.
const doctrine = readFileSync(join(ROOT, "docs", "agent-doctrine.md"), "utf8");
ok(/Extract-first grounding/.test(doctrine) && /L1 — extract-backing/.test(doctrine), "S1 agent-doctrine.md states L1 (extract-backing)");
ok(/Trace is not grounding/i.test(doctrine), "S1 agent-doctrine.md states trace-is-not-grounding");

// ===========================================================================
// S3/S4/S5 — L2 auto-chain: analyse+disasm every extracted payload, soft-fail.
// ===========================================================================
console.log("\nS3/S4/S5 — L2 extract auto-chain (analyse+disasm payloads, soft-fail)\n");
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const { autoAnalyzeExtractedPayloads } = await import(`${ROOT}/dist/lib/extract-auto-chain.js`);

const proj = mkdtempSync(join(tmpdir(), "c64re-752c-"));
const svc = new ProjectKnowledgeService(proj);
svc.initProject({ name: "752 auto-chain" });
mkdirSync(join(proj, "input", "prg"), { recursive: true });

// A tiny valid PRG: load $1000, LDA #$00 / RTS.
const goodPrgPath = join(proj, "input", "prg", "good.prg");
writeFileSync(goodPrgPath, Buffer.from([0x00, 0x10, 0xa9, 0x00, 0x60]));
const goodArt = svc.saveArtifact({ kind: "prg", scope: "input", title: "good.prg", path: goodPrgPath, role: "prg", platform: "c64" });
const goodPayload = svc.saveEntity({ kind: "payload", name: "good_payload", payloadSourceArtifactId: goodArt.id, payloadFormat: "prg", payloadLoadAddress: 0x1000 });

// A broken payload: its source artifact's file does not exist → workflow throws.
const brokenArt = svc.saveArtifact({ kind: "prg", scope: "input", title: "missing.prg", path: join(proj, "input", "prg", "missing.prg"), role: "prg", platform: "c64" });
const brokenPayload = svc.saveEntity({ kind: "payload", name: "broken_payload", payloadSourceArtifactId: brokenArt.id, payloadFormat: "prg", payloadLoadAddress: 0x2000 });

let chain;
let threw = false;
try {
  chain = await autoAnalyzeExtractedPayloads(proj, [goodPayload.id, brokenPayload.id], { mode: "quick" });
} catch { threw = true; }
ok(!threw, "S4 auto-chain never throws even with a broken payload");
const goodRes = chain?.find((r) => r.payloadId === goodPayload.id);
const brokenRes = chain?.find((r) => r.payloadId === brokenPayload.id);
ok(goodRes?.status === "done", "S4 good payload → done", `status=${goodRes?.status}`);
ok(brokenRes?.status === "failed", "S4 broken payload → failed (soft-fail, isolated)", `status=${brokenRes?.status}`);

// S3 stamp: the good payload now carries an asm artifact id.
const svc2 = new ProjectKnowledgeService(proj);
const stampedPayload = svc2.listEntities().find((e) => e.id === goodPayload.id);
ok((stampedPayload?.payloadAsmArtifactIds?.length ?? 0) > 0, "S3 good payload stamped with payloadAsmArtifactIds (extract evidence)", `n=${stampedPayload?.payloadAsmArtifactIds?.length}`);
ok(stampedPayload?.kind === "payload", "S3 stamp preserved the entity kind");

// L2: an analysis artifact + a disasm listing now exist for the good payload.
const arts = svc2.listArtifacts();
ok(arts.some((a) => a.role === "analysis-json" || a.kind === "analysis-run"), "L2 analysis artifact produced for the extracted payload");
ok(arts.some((a) => a.relativePath.endsWith("_disasm.asm") || a.role === "kickassembler-source"), "L2 disasm listing produced for the extracted payload");

// ===========================================================================
// S7 — L1 enforcement: saveFinding tags an unbacked file/payload finding.
// ===========================================================================
console.log("\nS7 — L1 saveFinding grounding marker (soft, never throws)\n");
const tagged = (f) => (f.tags ?? []).includes("ungrounded");

const ep = mkdtempSync(join(tmpdir(), "c64re-752e-"));
const esvc = new ProjectKnowledgeService(ep);
esvc.initProject({ name: "752 enforce" });

// a1 — file/payload finding (addressRange + routine tag) with NO backing → ungrounded.
const f1 = esvc.saveFinding({ kind: "classification", title: "routine at C000", addressRange: { start: 0xc000, end: 0xc010 }, tags: ["routine"] });
ok(tagged(f1), "S7 unbacked routine finding → tagged ungrounded");

// a2 — same shape but citing an analysis-run artifact → NOT ungrounded.
const anaArt = esvc.saveArtifact({ kind: "analysis-run", scope: "analysis", title: "x_analysis.json", path: join(ep, "analysis", "x_analysis.json"), role: "prg-analysis", format: "json" });
const f2 = esvc.saveFinding({ kind: "classification", title: "routine at C100", addressRange: { start: 0xc100, end: 0xc110 }, tags: ["routine"], artifactIds: [anaArt.id] });
ok(!tagged(f2), "S7 routine finding citing an analysis artifact → NOT ungrounded");

// a3 — re-save f1 WITH the backing artifact → marker cleared.
const f1b = esvc.saveFinding({ id: f1.id, kind: "classification", title: "routine at C000", addressRange: { start: 0xc000, end: 0xc010 }, tags: ["routine"], artifactIds: [anaArt.id] });
ok(!tagged(f1b), "S7 re-grounded finding → ungrounded marker cleared");

// a4 — a non-file/payload finding (no addressRange, no payloadId) → never tagged.
const f3 = esvc.saveFinding({ kind: "hypothesis", title: "general idea", tags: ["note"] });
ok(!tagged(f3), "S7 non-file/payload finding → not tagged (no false positive)");

// a5 — addressRange but NO file/payload tag → not scoped → not tagged.
const f4 = esvc.saveFinding({ kind: "observation", title: "range note", addressRange: { start: 0x0400, end: 0x07e7 }, tags: ["screen"] });
ok(!tagged(f4), "S7 addressRange without a file/payload tag → not tagged (predicate precision)");

// ===========================================================================
// S8 — agent_next_step routes an ungrounded finding to grounding (above trace).
// ===========================================================================
console.log("\nS8 — agent_next_step ungrounded rung (above annotate/trace/record)\n");
const { computeNextStep } = await import(`${ROOT}/dist/server-tools/agent-step.js`);

// Project with ONLY an ungrounded finding + clean inventory → rung 7b fires.
const sp = mkdtempSync(join(tmpdir(), "c64re-752f-"));
const ssvc = new ProjectKnowledgeService(sp);
ssvc.initProject({ name: "752 nextstep" });
ssvc.saveFinding({ kind: "classification", title: "ungrounded routine", addressRange: { start: 0x1000, end: 0x1010 }, tags: ["routine"] });
ssvc.buildAllViews();
const ns = computeNextStep(sp);
ok(ns.primary.stepId === "static-analyze", "S8 ungrounded finding → primary step routes to grounding (static-analyze)", `step=${ns.primary.stepId}`);
ok(/ungrounded/i.test(ns.primary.why) && /L1/.test(ns.primary.why), "S8 the why names L1 / ungrounded", ns.primary.why.slice(0, 60));

// Control: no ungrounded findings → the rung does not fire.
const sp2 = mkdtempSync(join(tmpdir(), "c64re-752g-"));
const ssvc2 = new ProjectKnowledgeService(sp2);
ssvc2.initProject({ name: "752 nextstep ctrl" });
ssvc2.buildAllViews();
const ns2 = computeNextStep(sp2);
ok(!/ungrounded/i.test(ns2.primary.why), "S8 control (no ungrounded) → rung does not fire", `step=${ns2.primary.stepId}`);

// ===========================================================================
// REVIEW FIXES — real-disk L2 (relink), L1 indirect kind/role validation,
// 64tass role, steering token idempotency. (Adversarial-review hardening.)
// ===========================================================================
console.log("\nReview fixes — real-disk L2 relink + L1 indirect validation\n");
const { extractDiskImage } = await import(`${ROOT}/dist/disk-extractor.js`);
const { linkExtractedPayloadFiles } = await import(`${ROOT}/dist/lib/extract-auto-chain.js`);

// Real disk: a disk-file entity (born internal, source=manifest) must be
// relinked to a real PRG and then auto-disassembled.
const dp = mkdtempSync(join(tmpdir(), "c64re-752h-"));
const dsvc = new ProjectKnowledgeService(dp);
dsvc.initProject({ name: "752 real disk" });
const man = extractDiskImage(`${ROOT}/samples/fixtures/load-fidelity/lf-002-5block.d64`, join(dp, "analysis", "disk"));
const manArt = dsvc.saveArtifact({ kind: "manifest", scope: "generated", title: "manifest", path: man.manifestPath, role: "disk-manifest", format: "json" });
const dimp = dsvc.importManifestArtifact(manArt.id);
ok(dimp.importedPayloadEntityIds.length > 0, "REVIEW disk import yields payload entity ids", `n=${dimp.importedPayloadEntityIds.length}`);
const nLinked = linkExtractedPayloadFiles(dp, manArt.id);
ok(nLinked > 0, "REVIEW extracted files relinked to per-file PRG artifacts", `linked=${nLinked}`);
const dchain = await autoAnalyzeExtractedPayloads(dp, dimp.importedPayloadEntityIds, { mode: "quick" });
ok(dchain.some((c) => c.status === "done"), "REVIEW real disk-file payload auto-disassembled (L2 works end-to-end)", dchain.map((c) => `${c.name}:${c.status}`).join(","));
const dEnt = dsvc.listEntities().find((e) => dimp.importedPayloadEntityIds.includes(e.id));
ok(dEnt?.internal !== true, "REVIEW relinked disk-file entity is no longer internal");

// L1 indirect: a payload backed ONLY by a d64 disk image is NOT grounding.
const lp = mkdtempSync(join(tmpdir(), "c64re-752i-"));
const lsvc = new ProjectKnowledgeService(lp);
lsvc.initProject({ name: "752 L1 indirect" });
const d64Art = lsvc.saveArtifact({ kind: "d64", scope: "input", title: "game.d64", path: join(lp, "input", "game.d64"), role: "disk-image" });
const payOnlyDisk = lsvc.saveEntity({ kind: "payload", name: "disk_only_payload", payloadSourceArtifactId: d64Art.id, payloadFormat: "prg" });
const fIndirectBad = lsvc.saveFinding({ kind: "classification", title: "routine in disk payload", payloadId: payOnlyDisk.id, addressRange: { start: 0x1000, end: 0x1010 }, tags: ["routine"] });
ok((fIndirectBad.tags ?? []).includes("ungrounded"), "REVIEW payload backed only by a d64 → finding still ungrounded (kind validated)");
// Give the payload a real disasm artifact → now grounded.
const asmArt = lsvc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "p_disasm.asm", path: join(lp, "analysis", "p_disasm.asm"), role: "kickassembler-source", format: "kickass" });
lsvc.saveEntity({ id: payOnlyDisk.id, kind: "payload", name: "disk_only_payload", payloadAsmArtifactIds: [asmArt.id] });
const fIndirectGood = lsvc.saveFinding({ id: fIndirectBad.id, kind: "classification", title: "routine in disk payload", payloadId: payOnlyDisk.id, addressRange: { start: 0x1000, end: 0x1010 }, tags: ["routine"] });
ok(!(fIndirectGood.tags ?? []).includes("ungrounded"), "REVIEW payload with a disasm artifact → finding grounded");

// 64tass-source role is accepted as grounding.
const tassArt = lsvc.saveArtifact({ kind: "report", scope: "analysis", title: "p.tass", path: join(lp, "analysis", "p.tass"), role: "64tass-source" });
const fTass = lsvc.saveFinding({ kind: "classification", title: "routine grounded by tass", addressRange: { start: 0x2000, end: 0x2010 }, tags: ["routine"], artifactIds: [tassArt.id] });
ok(!(fTass.tags ?? []).includes("ungrounded"), "REVIEW 64tass-source role counts as grounding");

// Steering idempotency keys on the hidden token even if the heading is edited.
const tk = mkdtempSync(join(tmpdir(), "c64re-752j-"));
mkdirSync(join(tk, "knowledge"), { recursive: true });
const { EXTRACT_FIRST_TOKEN } = await import(`${ROOT}/dist/server-tools/steering-defaults.js`);
writeFileSync(join(tk, "knowledge", "steering.md"), `# Steering\n${EXTRACT_FIRST_TOKEN}\n## (heading hand-edited away)\n`);
ok(ensureDefaultSteering(tk) === "present", "REVIEW steering idempotency survives a heading edit (hidden token)");

console.log(`\nproject: ${dir}\nauto-chain: ${proj}\nenforce: ${ep}\nnextstep: ${sp}\nreal-disk: ${dp}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 752: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
