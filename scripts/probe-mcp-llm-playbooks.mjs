// Spec 728 gate — validate docs/mcp-llm-playbooks.json.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 728 — probe-mcp-llm-playbooks\n");

const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const have = new Set(inv.tools.map((t) => t.name));
const pb = JSON.parse(readFileSync(join(ROOT, "docs/mcp-llm-playbooks.json"), "utf8"));
const books = pb.playbooks;
const byId = new Map(books.map((b) => [b.id, b]));
const matrix = JSON.parse(readFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), "utf8"));

// 1. all required playbook ids exist.
const REQUIRED = ["new-project-onboarding", "media-inventory", "trace-first-runtime-discovery",
  "disassembly-first-static-pass", "disassembly-trace-validation", "human-assisted-loader-protection",
  "frozen-visual-inspect", "change-patch-crack-port", "internal-dev-oracle-vice", "operator-maintenance"];
const missingPb = REQUIRED.filter((id) => !byId.has(id));
ok(missingPb.length === 0, "1 all 10 required playbooks exist", missingPb.join(",") || "none");

// 2. every tool named exists in the inventory.
const named = [];
for (const b of books) for (const s of b.steps) for (const t of (s.tools || [])) named.push({ id: b.id, t });
const unknown = named.filter((x) => !have.has(x.t));
ok(unknown.length === 0, "2 every playbook tool exists in inventory", unknown.map((x) => x.id + ":" + x.t).slice(0, 8).join(",") || "none");

// 3. every playbook well-formed.
const badStep = [];
for (const b of books) {
  if (!b.steps || !b.steps.length) badStep.push(b.id + ":no-steps");
  for (const s of (b.steps || [])) if (!s.action || !s.action.trim()) badStep.push(b.id + ":empty-action");
  if (!b.stopConditions || !b.stopConditions.length) badStep.push(b.id + ":no-stop");
  if (!b.nextActions || !b.nextActions.length) badStep.push(b.id + ":no-next");
  if (!b.forbiddenShortcuts || !b.forbiddenShortcuts.length) badStep.push(b.id + ":no-forbidden");
}
ok(badStep.length === 0, "3 every playbook well-formed (steps/stop/next/forbidden)", badStep.slice(0, 8).join(",") || "none");

// 4. no vice_* outside the Internal Dev Oracle playbook.
const viceOutside = [];
for (const b of books) if (b.id !== "internal-dev-oracle-vice") for (const s of b.steps) for (const t of (s.tools || [])) if (t.startsWith("vice_")) viceOutside.push(b.id + ":" + t);
ok(viceOutside.length === 0, "4 no vice_* outside the Internal Dev Oracle playbook", viceOutside.join(",") || "none");

// 5. no maintenance tool in a normal playbook.
const maintNames = new Set(matrix.rows.filter((r) => r.role === "maintenance").map((r) => r.name));
const maintLeak = [];
for (const b of books) if (b.id !== "operator-maintenance") for (const s of b.steps) for (const t of (s.tools || [])) if (maintNames.has(t)) maintLeak.push(b.id + ":" + t);
ok(maintLeak.length === 0, "5 no maintenance tool in a normal playbook", maintLeak.join(",") || "none");

// 6. trace-first playbook uses the Spec 726 writer tools.
const tf = byId.get("trace-first-runtime-discovery");
const tfTools = new Set(tf ? tf.steps.flatMap((s) => s.tools || []) : []);
const need726 = ["runtime_session_start", "runtime_mark", "runtime_trace_finalize"];
const miss726 = need726.filter((n) => !tfTools.has(n));
ok(miss726.length === 0, "6 trace-first playbook uses Spec 726 writer tools", miss726.join(",") || "none");

// 7. disk-boot trace sequence present.
const tfText = JSON.stringify(tf);
ok(/LOAD..\*..,8,1/.test(tfText) && /RUN/.test(tfText), "7a trace-first includes LOAD\"*\",8,1 + RUN", "");
ok(/basic-ready/.test(tfText) && /loaded-or-title/.test(tfText), "7b trace-first marks basic-ready + loaded-or-title", "");
ok(/trace_out/.test(tfText) && /trace_domains/.test(tfText), "7c trace-first start uses trace_out + trace_domains", "");

// 8. global rules present.
const gr = (pb.globalRules || []).join(" ");
ok((pb.globalRules || []).length >= 5, "8a >=5 global rules", `${(pb.globalRules || []).length}`);
ok(/raw SQL/i.test(gr) && /VICE is internal-dev-only/i.test(gr) && /cwd/i.test(gr), "8b global rules cover raw-SQL + vice + cwd", "");

// 9. every DEFAULT tool appears in >=1 playbook or is marked supporting.
const inPlaybooks = new Set(named.map((x) => x.t));
const defaults = matrix.rows.filter((r) => r.tier === "default").map((r) => r.name);
const uncovered = defaults.filter((n) => !inPlaybooks.has(n));
const SUPPORTING = new Set(["runtime_session_status", "runtime_trace_status", "runtime_media_browse",
  "runtime_media_unmount", "runtime_step_into", "runtime_step_over", "runtime_monitor_disasm",
  "runtime_monitor_registers", "list_artifacts", "list_payloads", "list_findings", "list_open_questions",
  "list_entities", "list_flows", "get_artifact_lineage", "ram_report", "build_all_views",
  "build_memory_map", "build_annotated_listing_view", "render_docs", "trace_store_anchor_list",
  "trace_store_anchor_find", "trace_store_query", "runtime_until", "suggest_depacker", "try_depack",
  "run_prg_reverse_workflow", "read_artifact", "agent_propose_next", "c64re_whats_next",
  // Spec 730 §7 — artifact version-op tools are targeted curate/read utilities
  // (resolve/pin/demote the current best source version), supporting any
  // disassembly/annotation playbook rather than driving their own swimlane.
  "list_artifact_versions", "get_current_artifact", "set_current_artifact_version",
  "mark_artifact_version_stale",
  // Spec 740.1 — project_search/find_related drive the onboarding retrieval step;
  // reindex + wiki-lint are supporting utilities (rebuild cache / report gaps).
  "project_reindex_search", "project_wiki_lint",
  // BUG-023 — save mounted-disk writes back to the host file (supports any
  // media/runtime playbook; eject does the same via runtime_media_unmount).
  "runtime_media_persist"]);
const trulyUncovered = uncovered.filter((n) => !SUPPORTING.has(n));
ok(trulyUncovered.length === 0, "9 every default tool is in a playbook or marked supporting", trulyUncovered.slice(0, 10).join(",") || "none");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} 728 playbooks: ${pass} pass, ${fail} fail. ${books.length} playbooks.`);
process.exit(fail === 0 ? 0 : 1);
