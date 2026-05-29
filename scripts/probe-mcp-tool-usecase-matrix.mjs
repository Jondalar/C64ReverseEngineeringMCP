// Spec 727 gate — validate docs/mcp-tool-usecase-matrix.json against the
// inventory + the classification rules. Static + deterministic; no server boot.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 727 — probe-mcp-tool-usecase-matrix\n");

const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), "utf8"));
const rows = matrix.rows;
const byName = new Map(rows.map((r) => [r.name, r]));

// 1. every inventory tool appears exactly once.
const invNames = inv.tools.map((t) => t.name);
const counts = {};
for (const r of rows) counts[r.name] = (counts[r.name] || 0) + 1;
const missing = invNames.filter((n) => !counts[n]);
const dupes = Object.keys(counts).filter((n) => counts[n] > 1);
const extra = rows.map((r) => r.name).filter((n) => !invNames.includes(n));
ok(missing.length === 0, "1a every inventory tool has a row", missing.slice(0, 8).join(",") || "none");
ok(dupes.length === 0, "1b no duplicate rows", dupes.slice(0, 8).join(",") || "none");
ok(extra.length === 0, "1c no phantom rows", extra.slice(0, 8).join(",") || "none");
ok(rows.length === invNames.length, "1d row count == inventory total", `${rows.length}/${invNames.length}`);

// 2. no empty useWhen / notFor.
const emptyUse = rows.filter((r) => !r.useWhen || !r.useWhen.trim());
const emptyNot = rows.filter((r) => !r.notFor || !r.notFor.trim());
ok(emptyUse.length === 0, "2a no empty useWhen", emptyUse.map((r) => r.name).slice(0, 8).join(",") || "none");
ok(emptyNot.length === 0, "2b no empty notFor", emptyNot.map((r) => r.name).slice(0, 8).join(",") || "none");

// 3. every default tool has >=1 e2eUseCases.
const defNoE2e = rows.filter((r) => r.tier === "default" && (!r.e2eUseCases || r.e2eUseCases.length === 0));
ok(defNoE2e.length === 0, "3 every default tool has >=1 e2eUseCases", defNoE2e.map((r) => r.name).slice(0, 8).join(",") || "none");

// 4. trace reader schema contract + raw-SQL guard.
const TRACE_READERS = ["trace_store_info", "trace_store_top_pcs", "trace_store_bus_find",
  "trace_store_anchor_list", "trace_store_anchor_find", "runtime_query_events",
  "runtime_swimlane_slice", "runtime_trace_taint", "runtime_follow_path", "runtime_profile_loader"];
const readerNoSchema = TRACE_READERS.filter((n) => byName.has(n) && !byName.get(n).schemaContract);
ok(readerNoSchema.length === 0, "4a every convenience trace reader names a schema contract", readerNoSchema.join(",") || "none");
const badSchema = TRACE_READERS.filter((n) => byName.has(n) && /\bmeta\b|instructions/i.test(byName.get(n).schemaContract || ""));
ok(badSchema.length === 0, "4b no trace reader contract references meta/instructions", badSchema.join(",") || "none");
const defReaders = TRACE_READERS.filter((n) => byName.has(n) && byName.get(n).tier === "default");
ok(defReaders.length >= 3, "4c >=3 default convenience trace readers exist (not raw-SQL-only)", `${defReaders.length}`);

// 5. vice_* → internal-dev-oracle + advanced.
const vice = rows.filter((r) => r.name.startsWith("vice_"));
const viceBad = vice.filter((r) => r.role !== "internal-dev-oracle" || r.tier !== "advanced");
ok(viceBad.length === 0, `5 every vice_* is internal-dev-oracle + advanced (${vice.length} vice tools)`, viceBad.map((r) => r.name).join(",") || "none");

// 6. runtime_drive(_session)_* advanced.
const drive = rows.filter((r) => /^runtime_drive(_session)?_/.test(r.name));
const driveBad = drive.filter((r) => r.tier !== "advanced");
ok(driveBad.length === 0, `6 every runtime_drive(_session)_* is advanced (${drive.length})`, driveBad.map((r) => r.name).join(",") || "none");

// 7. no keep-default with swimlane none.
const kdNone = rows.filter((r) => r.keepDecision === "keep-default" && r.swimlane === "none");
ok(kdNone.length === 0, "7 no keep-default row has swimlane none", kdNone.map((r) => r.name).join(",") || "none");

// 8. no default row repo-dev-only / broken-cwd-coupled.
const badPath = rows.filter((r) => r.tier === "default" && (r.pathMode === "repo-dev-only" || r.pathMode === "broken-cwd-coupled"));
ok(badPath.length === 0, "8 no default tool is repo-dev-only / broken-cwd-coupled", badPath.map((r) => r.name).join(",") || "none");

// 9. retire/merge/rename name a successor (useInstead) or reason (notes).
const cand = rows.filter((r) => ["retire", "merge", "rename"].includes(r.keepDecision));
const candNoSucc = cand.filter((r) => !(r.useInstead && r.useInstead.trim()) && !(r.notes && r.notes.trim()));
ok(candNoSucc.length === 0, `9 every retire/merge/rename names a successor/reason (${cand.length} candidates)`, candNoSucc.map((r) => r.name).join(",") || "none");

// 10. tier matches the live registry.
const tier = await import(`${ROOT}/dist/server-tools/tier-tools.js`);
const drift = rows.filter((r) => tier.tierForTool(r.name) !== r.tier);
ok(drift.length === 0, "10 matrix tier matches live registry", drift.map((r) => r.name).slice(0, 8).join(",") || "none");

// 11. valid enum values.
const ROLES = new Set(["workflow", "knowledge-read", "knowledge-write", "media-ingress", "static-analysis", "disassembly", "runtime-control", "runtime-monitor", "runtime-inspect", "trace-capture", "trace-query", "change-intervention", "view-docs", "internal-dev-oracle", "maintenance", "format-forensics", "debug-only", "obsolete"]);
const SWIM = new Set(["entry-project-baseline", "runtime-explore", "freeze-inspect", "trace-capture", "trace-analysis", "disassembly-improve", "asset-linking", "change-intervention", "validation", "internal-dev-only", "operator-maintenance", "none"]);
const PATH = new Set(["no-path", "project-relative-ok", "absolute-ok", "project-or-absolute-ok", "repo-dev-only", "broken-cwd-coupled"]);
const badEnum = rows.filter((r) => !ROLES.has(r.role) || !SWIM.has(r.swimlane) || !PATH.has(r.pathMode));
ok(badEnum.length === 0, "11 all role/swimlane/pathMode values valid", badEnum.map((r) => r.name).slice(0, 8).join(",") || "none");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} 727 matrix: ${pass} pass, ${fail} fail. ${rows.length} rows (${matrix.defaultCount} default, ${matrix.advancedCount} advanced).`);
process.exit(fail === 0 ? 0 : 1);
