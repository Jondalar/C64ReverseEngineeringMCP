// Spec 722.3a guard — tool tier gate. Verifies the façade-first default surface
// against the full inventory + the tier-tools registry (the exact logic the
// server.tool() gate uses). Static + deterministic; no server boot.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 722.3a — probe-tool-surface\n");

const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const tier = await import(`${ROOT}/dist/server-tools/tier-tools.js`);
const { DEFAULT_TOOLS, tierForTool, DEFAULT_TIER_CAP } = tier;

const allNames = inv.tools.map((t) => t.name);
const descByName = new Map(inv.tools.map((t) => [t.name, t.firstSentence]));
const defaultNames = allNames.filter((n) => tierForTool(n) === "default").sort();
const fullCount = allNames.length;

// 1. default surface is small (façade-first), within the documented cap.
ok(defaultNames.length <= DEFAULT_TIER_CAP,
  `1 default surface ≤ cap (${DEFAULT_TIER_CAP})`, `${defaultNames.length} default`);

// 2. full surface = the whole inventory (gate off → all registered).
ok(fullCount === inv.total, "2 full surface == inventory total", `${fullCount}`);

// 3-5. no raw runtime / VICE / headless tool in the default surface.
const leak = (re) => defaultNames.filter((n) => re.test(n));
ok(leak(/^vice_/).length === 0, "3 no vice_* in default", leak(/^vice_/).join(",") || "none");
ok(leak(/^runtime_/).length === 0, "4 no runtime_* in default", leak(/^runtime_/).join(",") || "none");
ok(leak(/^headless_/).length === 0, "5 no headless_* in default", leak(/^headless_/).join(",") || "none");

// 5b. no maintenance / bulk / sandbox in default.
ok(leak(/^(backfill_|dedupe_|sandbox_|bulk_)|_(backfill|dedupe|repair)/).length === 0,
  "5b no maintenance/bulk/sandbox in default", leak(/^(backfill_|dedupe_|sandbox_|bulk_)/).join(",") || "none");

// 6. every default tool has a description.
const noDesc = defaultNames.filter((n) => !descByName.get(n) || !descByName.get(n).trim());
ok(noDesc.length === 0, "6 every default tool has a description", noDesc.join(",") || "none");

// 7. every DEFAULT_TOOLS entry actually exists in the inventory (catch typos /
//    renamed tools → would silently vanish from the surface).
const have = new Set(allNames);
const phantom = [...DEFAULT_TOOLS].filter((n) => !have.has(n)).sort();
ok(phantom.length === 0, "7 no phantom DEFAULT_TOOLS entry (all exist in inventory)", phantom.join(",") || "none");

// 8. unknown/untagged = advanced (never silently default). Report tools that are
//    neither in DEFAULT_TOOLS nor matched by a recognised advanced bucket, so a
//    new namespace gets a human look (informational — they default to advanced).
const ADVANCED_BUCKET = /^(vice_|runtime_|headless_|trace_|pack_|depack_|bwc_|extract_g64|inspect_g64|analyze_g64|scan_g64|backfill_|dedupe_|repair_|register_|bulk_|sandbox_|record_|build_|list_|save_|import_|link_|run_|start_|project_|agent_|get_|mark_|propose_|auto_|close_|confirm_|declare_|define_|verify_|apply_|archive_|rename_|update_|snapshot_|reconstruct_|suggest_|c64ref_|set_|read_|disasm_|inspect_|analyze_|assemble_|extract_|export_|render_|disk_|ram_|pointer_|compare_|try_|diff_|c64re_)/;
const unrecognised = allNames.filter((n) => tierForTool(n) === "advanced" && !ADVANCED_BUCKET.test(n)).sort();
ok(true, `8 unrecognised-namespace advanced tools (informational)`, unrecognised.length ? unrecognised.join(",") : "none");

console.log(`\nDefault surface (${defaultNames.length}):`);
for (const n of defaultNames) console.log(`  ${n}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} tool-surface: ${pass} pass, ${fail} fail. default=${defaultNames.length} full=${fullCount}`);
process.exit(fail === 0 ? 0 : 1);
