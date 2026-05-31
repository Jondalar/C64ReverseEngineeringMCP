// Spec 729 E2E-F/G — tool boundaries. Proves the default surface is the product
// workflow and that oracle / drive-only / maintenance / legacy tools are NOT in
// default and NOT required by any normal playbook. Static + deterministic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 729 E2E-F/G — tool boundaries\n");

const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), "utf8"));
const tier = await import(`${ROOT}/dist/server-tools/tier-tools.js`);
const allNames = inv.tools.map((t) => t.name);
const def = allNames.filter((n) => tier.tierForTool(n) === "default");
const defSet = new Set(def);

// 1. the product-workflow facade IS default (a fresh LLM can run the swimlane).
const PRODUCT = ["agent_onboard", "start_re_workflow", "inspect_disk", "extract_disk",
  "runtime_session_start", "runtime_session_run", "runtime_type", "runtime_mark",
  "runtime_trace_finalize", "trace_store_info", "trace_store_top_pcs", "runtime_query_events",
  "analyze_prg", "disasm_prg", "save_finding", "runtime_render_screen", "runtime_vic_inspect_at"];
const missingProduct = PRODUCT.filter((n) => !defSet.has(n));
ok(missingProduct.length === 0, "1 product-workflow facade is default", missingProduct.join(",") || "none");

// 2. no vice_* in default (E2E-F).
const viceDef = def.filter((n) => n.startsWith("vice_"));
ok(viceDef.length === 0, "2 no vice_* in default", viceDef.join(",") || "none");

// 3. no runtime_drive(_session)_* in default.
const driveDef = def.filter((n) => /^runtime_drive(_session)?_/.test(n));
ok(driveDef.length === 0, "3 no runtime_drive_* in default", driveDef.join(",") || "none");

// 4. no maintenance / bulk / sandbox in default (E2E-G).
// Exception (Spec 730.1): bulk_create_cart_chunk_payloads is a product RE tool
// explicitly promoted to default — its name matches /^bulk_/ but it is not a
// maintenance op.
// Exception (BUG-024): register_payload is a product knowledge-write tool — it
// matches /^register_/ but registers a carved code-derived load as a first-class
// payload (load addr + format + source .prg + medium spans), not a maintenance op.
const BULK_EXCEPTIONS_730 = new Set(["bulk_create_cart_chunk_payloads", "register_payload"]);
const maintDef = def.filter((n) => /^(backfill_|dedupe_|repair_|register_|bulk_|sandbox_)|_(backfill|dedupe|repair)/.test(n) && !BULK_EXCEPTIONS_730.has(n));
ok(maintDef.length === 0, "4 no maintenance/bulk/sandbox in default", maintDef.join(",") || "none");

// 5. no headless_* in default (one runtime language).
const headlessDef = def.filter((n) => n.startsWith("headless_"));
ok(headlessDef.length === 0, "5 no headless_* in default", headlessDef.join(",") || "none");

// 6. matrix: every default tool sits in a product swimlane (not internal-dev / operator).
const rowByName = new Map(matrix.rows.map((r) => [r.name, r]));
const PRODUCT_LANES = new Set(["entry-project-baseline", "runtime-explore", "freeze-inspect",
  "trace-capture", "trace-analysis", "disassembly-improve", "asset-linking", "change-intervention", "validation"]);
const badLane = def.filter((n) => { const r = rowByName.get(n); return r && !PRODUCT_LANES.has(r.swimlane); });
ok(badLane.length === 0, "6 every default tool is in a product swimlane", badLane.join(",") || "none");

// 7. oracle/drive-debug rows are advanced.
const oracleRows = matrix.rows.filter((r) => r.role === "internal-dev-oracle" || r.role === "debug-only");
const oracleBad = oracleRows.filter((r) => r.tier !== "advanced");
ok(oracleBad.length === 0, `7 oracle/drive-debug rows are advanced (${oracleRows.length})`, oracleBad.map((r) => r.name).join(",") || "none");

// 8. playbooks never require vice_* / maintenance in a normal flow.
const pb = JSON.parse(readFileSync(join(ROOT, "docs/mcp-llm-playbooks.json"), "utf8"));
const normalTools = new Set();
for (const b of pb.playbooks) if (!b.internalOnly && !b.operatorOnly) for (const s of b.steps) for (const t of (s.tools || [])) normalTools.add(t);
const leak = [...normalTools].filter((t) => (t.startsWith("vice_") || /^(backfill_|dedupe_|repair_|bulk_|sandbox_)/.test(t)) && !BULK_EXCEPTIONS_730.has(t));
ok(leak.length === 0, "8 normal playbooks require no vice_/maintenance tool", leak.join(",") || "none");

console.log(`\n--- report ---`);
console.log(`default tools: ${def.length}; advanced: ${allNames.length - def.length}`);
console.log(`product facade verified; vice/drive/maintenance excluded from default + normal playbooks.`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E tool-boundaries: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
