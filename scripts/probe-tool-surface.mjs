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
const fullDescByName = new Map(inv.tools.map((t) => [t.name, t.desc || t.firstSentence]));
const defaultNames = allNames.filter((n) => tierForTool(n) === "default").sort();
const fullCount = allNames.length;

// 1. default surface is small (façade-first), within the documented cap.
ok(defaultNames.length <= DEFAULT_TIER_CAP,
  `1 default surface ≤ cap (${DEFAULT_TIER_CAP})`, `${defaultNames.length} default`);

// 2. full surface = the whole inventory (gate off → all registered).
ok(fullCount === inv.total, "2 full surface == inventory total", `${fullCount}`);

// 3-5. Negative guards — these never belong in the default surface.
// (Spec 725: the "no runtime_* in default" guard is REMOVED — the curated
// Headless Runtime + Monitor/Inspect + TraceDB facades ARE default; only the
// drive-only/debug runtime_ tools stay advanced, covered below.)
const leak = (re) => defaultNames.filter((n) => re.test(n));
ok(leak(/^vice_/).length === 0, "3 no vice_* in default", leak(/^vice_/).join(",") || "none");
ok(leak(/^headless_/).length === 0, "5 no headless_* in default", leak(/^headless_/).join(",") || "none");
// 5a (Spec 725 §4): no drive-only/debug runtime_ tools in default.
ok(leak(/^runtime_drive(_session)?_|^runtime_diagnose_/).length === 0,
  "5a no runtime_drive_*/runtime_diagnose_* in default", leak(/^runtime_drive/).join(",") || "none");

// 5b. no maintenance / bulk in default. Exceptions: product RE tools explicitly
// promoted — bulk_create_cart_chunk_payloads (Spec 730.1) and the sandbox 6502 depack
// tools (2026-07-05; run a game's own depacker — core loader/crypto RE, not maintenance).
const BULK_EXCEPTIONS_730 = new Set(["bulk_create_cart_chunk_payloads", "sandbox_depack", "sandbox_6502_run"]);
const bulk5b = leak(/^(backfill_|dedupe_|sandbox_|bulk_)|_(backfill|dedupe|repair)/).filter((n) => !BULK_EXCEPTIONS_730.has(n));
ok(bulk5b.length === 0,
  "5b no maintenance/bulk/sandbox in default (bulk_create_cart_chunk_payloads excepted per Spec 730.1)", bulk5b.join(",") || "none");

// 5c (Spec 725 §3.7-3.9): the required facade tools MUST be default.
const REQUIRED_DEFAULT = [
  // Headless Runtime
  "runtime_session_start","runtime_session_status","runtime_session_run","runtime_session_snapshot",
  "runtime_media_browse","runtime_media_mount","runtime_media_unmount","runtime_media_swap",
  "runtime_type","runtime_joystick","runtime_load_prg","runtime_render_screen",
  // Monitor / inspect
  "runtime_monitor_registers","runtime_monitor_memory","runtime_monitor_disasm",
  "runtime_step_into","runtime_step_over","runtime_until","runtime_resolve_pc","runtime_vic_inspect_at",
  // TraceDB / evidence
  "runtime_query_events","runtime_swimlane_slice","runtime_trace_taint","runtime_follow_path","runtime_profile_loader",
  "trace_store_info","trace_store_query","trace_store_top_pcs","trace_store_bus_find",
  "trace_store_anchor_list","trace_store_anchor_find",
  // Spec 726 — live trace capture facade (write side).
  "runtime_mark","runtime_trace_finalize","runtime_trace_status",
];
const defaultSet = new Set(defaultNames);
const missingFacade = REQUIRED_DEFAULT.filter((n) => !defaultSet.has(n));
ok(missingFacade.length === 0, "5c required Headless Runtime + Monitor + TraceDB facade tools are default",
  missingFacade.join(",") || "none");

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

// --- 722.5a: default-tool description quality (capability-first, no history) ---
const dfull = (n) => fullDescByName.get(n) || "";
// 9. no `Spec NNN` in any default description.
const specInDefault = defaultNames.filter((n) => /Spec\s*\d/i.test(dfull(n)));
ok(specInDefault.length === 0, "9 no Spec NNN in default descriptions", specInDefault.join(",") || "none");
// 10. no default description starts with "Spec" or a phase prefix.
const badStart = defaultNames.filter((n) => /^\s*(Spec\b|\[Phase)/i.test(dfull(n)));
ok(badStart.length === 0, "10 no default description starts with Spec/[Phase]", badStart.join(",") || "none");
// 11. every default description carries decision help: a "Use …" trigger AND a
//     when-to-pick-vs-alternative pointer ("Not for …" / "use <other>").
const lacksHelp = defaultNames.filter((n) => {
  const d = dfull(n);
  const hasUse = /\bUse [a-z]/i.test(d);
  const hasAlt = /Not for|\(use [a-z_]+|use [a-z_]+ instead/i.test(d);
  return !(hasUse && hasAlt);
});
ok(lacksHelp.length === 0, "11 every default description has Use-trigger + alternative pointer", lacksHelp.join(",") || "none");

// --- 722.5b-1: vice_* are advanced oracle-only ---
const viceNames = allNames.filter((n) => n.startsWith("vice_"));
// 12. every vice_* is advanced (none in default).
const viceDefault = viceNames.filter((n) => tierForTool(n) === "default");
ok(viceDefault.length === 0, "12 every vice_* is advanced (none default)", viceDefault.join(",") || "none");
// 13. every vice_* description is framed oracle-only.
const viceNoOracle = viceNames.filter((n) => !/Oracle-only|VICE comparison|oracle/i.test(fullDescByName.get(n) || ""));
ok(viceNoOracle.length === 0, "13 every vice_* description is oracle-only framed", viceNoOracle.join(",") || "none");
// 14. no vice_* description starts with Spec.
const viceSpecStart = viceNames.filter((n) => /^\s*Spec\b/i.test(fullDescByName.get(n) || ""));
ok(viceSpecStart.length === 0, "14 no vice_* description starts with Spec", viceSpecStart.join(",") || "none");

// 16 (722.3b): the confusing audio name-collision is retired. The session
// exporter is runtime_session_export_audio; the scenario one is
// runtime_export_audio. The old colliding `runtime_audio_export` must not exist.
ok(!have.has("runtime_audio_export"), "16 audio name-collision retired (no runtime_audio_export)",
  have.has("runtime_audio_export") ? "still present" : "none");

// 15 (722.4): the headless_* namespace is fully retired — one runtime language.
const headlessLeft = allNames.filter((n) => n.startsWith("headless_"));
ok(headlessLeft.length === 0, "15 no headless_* tool remains (consolidated into runtime_*)", headlessLeft.join(",") || "none");

// --- 730.1: promoted disk/G64 + cartridge tools must be in the default tier ---
const PROMOTED_730 = [
  // Disk / G64
  "list_g64_slots", "inspect_g64_track", "inspect_g64_blocks", "inspect_g64_syncs",
  "scan_g64_headers", "read_g64_sector_candidate", "extract_g64_sectors",
  "extract_g64_raw_track", "analyze_g64_anomalies",
  "suggest_disk_lut_sector", "extract_disk_custom_lut", "set_payload_disk_hint",
  // Cartridge
  "bulk_create_cart_chunk_payloads", "link_cart_chunk_to_asm", "record_cart_chunk_packer",
];
const missing730 = PROMOTED_730.filter((n) => !defaultSet.has(n));
ok(missing730.length === 0, "730a all 15 promoted disk/G64+cart tools are default",
  missing730.join(",") || "none");

// 730b: view-build internals and vice_* must NOT be default.
const MUST_NOT_DEFAULT_730 = ["build_disk_layout_view", "build_cartridge_layout_view"];
const wrongDefault730 = MUST_NOT_DEFAULT_730.filter((n) => defaultSet.has(n));
ok(wrongDefault730.length === 0, "730b build_disk_layout_view + build_cartridge_layout_view are NOT default",
  wrongDefault730.join(",") || "none");
// vice_* already guarded by check 3 above; redundant explicit check for clarity.
const viceInDefault730 = PROMOTED_730.filter((n) => n.startsWith("vice_") && defaultSet.has(n));
ok(viceInDefault730.length === 0, "730b no vice_* tool in default (redundant guard)", viceInDefault730.join(",") || "none");

// 730c: none of the 15 promoted descriptions starts with "Spec" or contains "C64RE_FULL_TOOLS".
const bad730Start = PROMOTED_730.filter((n) => /^\s*Spec\b/i.test(dfull(n)));
ok(bad730Start.length === 0, "730c no promoted tool description starts with 'Spec'",
  bad730Start.join(",") || "none");
const bad730Full = PROMOTED_730.filter((n) => /C64RE_FULL_TOOLS/i.test(dfull(n)));
ok(bad730Full.length === 0, "730c no promoted tool description contains 'C64RE_FULL_TOOLS'",
  bad730Full.join(",") || "none");

console.log(`\nDefault surface (${defaultNames.length}):`);
for (const n of defaultNames) console.log(`  ${n}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} tool-surface: ${pass} pass, ${fail} fail. default=${defaultNames.length} full=${fullCount}`);
process.exit(fail === 0 ? 0 : 1);
