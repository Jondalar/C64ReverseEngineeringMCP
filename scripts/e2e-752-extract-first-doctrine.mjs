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

console.log(`\nproject: ${dir}\nauto-chain project: ${proj}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 752: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
