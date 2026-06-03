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

console.log(`\nproject: ${dir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 752: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
