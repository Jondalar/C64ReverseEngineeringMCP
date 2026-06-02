// BUG-033 — artifact-version reconcile must (A) clear a sticky `missing`/`stale`
// flag when the file reappears on disk, and (B) never auto-pick a `related` companion
// (.sym) over a primary listing (.asm/.tass) of the same subject.
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-033 — version reconcile clears reappeared-missing + primary beats related\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug033-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const { subjectIdForArtifact } = await import(`${ROOT}/dist/project-knowledge/artifact-versions.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "BUG-033" });

mkdirSync(join(projectDir, "analysis"), { recursive: true });
const asmPath = "analysis/02_2.0_disasm.asm", symPath = "analysis/02_2.0_disasm.sym";
writeFileSync(join(projectDir, asmPath), "; disasm\n");
writeFileSync(join(projectDir, symPath), "WC000 = $C000\n");

const asm = svc.saveArtifact({ kind: "generated-source", scope: "analysis", title: "02_2.0_disasm.asm", path: asmPath, format: "kickass" });
const sym = svc.saveArtifact({ kind: "report", scope: "analysis", title: "02_2.0_disasm.sym", path: symPath, role: "symbols" });
const subject = subjectIdForArtifact(asm);

const grp = () => svc.getArtifactVersionGroup(subject);
const statusOf = (id) => grp()?.versions.find((v) => v.artifactId === id)?.status;

// 1 first reconcile: PRIMARY .asm is auto-current, NOT the related .sym.
svc.reconcileArtifactVersionGroups();
ok(grp()?.currentArtifactId === asm.id, "1 auto-current = primary .asm (not the related .sym)", `current=${grp()?.currentArtifactId === asm.id ? "asm" : grp()?.currentArtifactId === sym.id ? "SYM" : "?"}`);

// 2 mark the .asm missing (clean-restart workflow) — file still on disk.
svc.markArtifactVersionStatus(subject, asm.id, "missing");
ok(statusOf(asm.id) === "missing", "2 .asm marked missing", `status=${statusOf(asm.id)}`);

// 3 reconcile with the .asm STILL present → missing flag CLEARED, .asm current again
//   (not the .sym winning).
svc.reconcileArtifactVersionGroups();
ok(statusOf(asm.id) !== "missing" && statusOf(asm.id) !== "stale", "3 reappeared file → missing flag cleared", `status=${statusOf(asm.id)}`);
ok(grp()?.currentArtifactId === asm.id, "3b .asm is current again (related .sym does not win)", `current=${grp()?.currentArtifactId === asm.id ? "asm" : "SYM/other"}`);
ok(statusOf(sym.id) === "available", "3c .sym stays available (not current)", `sym=${statusOf(sym.id)}`);

// 4 genuine-missing fallback: delete the .asm file, mark missing, reconcile →
//   .asm stays missing (file gone) and the related .sym becomes current (only one left).
unlinkSync(join(projectDir, asmPath));
svc.markArtifactVersionStatus(subject, asm.id, "missing");
svc.reconcileArtifactVersionGroups();
ok(statusOf(asm.id) === "missing", "4 genuinely-deleted .asm stays missing", `status=${statusOf(asm.id)}`);
ok(grp()?.currentArtifactId === sym.id, "4b with no primary available, the .sym becomes current (only available)", `current=${grp()?.currentArtifactId === sym.id ? "sym" : "?"}`);

console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-033: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
