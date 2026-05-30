// Spec 727 — MCP Tool Use-Case Inventory generator.
// Reads docs/tool-surface-inventory.json + the live tier registry
// (dist/server-tools/tier-tools.js) and emits one classified row PER registered
// tool into docs/mcp-tool-usecase-matrix.{json,md}.
//
// Data-driven: tier is resolved at runtime (never hard-coded). Role / swimlane /
// pathMode / keepDecision come from ordered pattern rules; per-tool text comes
// from a curated map where we are confident, otherwise from a safe per-role
// template that still yields non-empty useWhen / notFor + (for default tools) at
// least one e2eUseCase. So the matrix stays correct even if the inventory grows.
//
// Run: node scripts/gen-mcp-tool-usecase-matrix.mjs
// Gate: node scripts/probe-mcp-tool-usecase-matrix.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const tier = await import(`${ROOT}/dist/server-tools/tier-tools.js`);
const { tierForTool } = tier;

// Trace reader/writer schema contract (Spec 726 §6a). Convenience readers MUST
// consume the live-writer schema, never the old Spec-217 meta/instructions tables.
const TRACE_SCHEMA = "trace_run + trace_event(run_id,seq,cycle,channel,trigger_kind,capture_kind,data_json) + trace_mark(run_id,cycle,label)";
const TRACE_READERS = new Set([
  "trace_store_info", "trace_store_query", "trace_store_top_pcs", "trace_store_bus_find",
  "trace_store_anchor_list", "trace_store_anchor_find",
  "runtime_query_events", "runtime_swimlane_slice", "runtime_trace_taint",
  "runtime_follow_path", "runtime_profile_loader",
]);
const TRACE_WRITERS = new Set([
  "runtime_session_start", "runtime_mark", "runtime_trace_finalize", "runtime_trace_status",
]);

// Tools that accept a media/trace/source path from the LLM. These resolve through
// the project/path resolver (absolute OR project-relative), never repo cwd.
const PATH_TOOLS = new Set([
  "inspect_disk", "extract_disk", "extract_crt", "disk_sector_allocation",
  "analyze_prg", "disasm_prg", "disasm_menu", "assemble_source",
  "runtime_session_start", "runtime_media_mount", "runtime_media_swap", "runtime_load_prg",
  "runtime_media_browse",
  "trace_store_info", "trace_store_query", "trace_store_top_pcs", "trace_store_bus_find",
  "trace_store_anchor_list", "trace_store_anchor_find",
  "runtime_query_events", "runtime_swimlane_slice", "runtime_trace_taint",
  "runtime_follow_path", "runtime_profile_loader",
]);

// Dev/scenario-fixture tools that legitimately bind to the repo corpus. Allowed
// ONLY because they are advanced; never default.
const REPO_DEV_TOOLS = new Set([
  "runtime_run_scenario", "runtime_run_scenarios_parallel", "runtime_scenario_list",
  "runtime_scenario_load", "runtime_scenario_save", "runtime_scenario_delete",
  "define_runtime_scenario", "list_runtime_scenarios", "diff_scenario_runs",
]);

// Legacy pre-facade runtime/trace variants → superseded by the Spec 725/726
// default facade. keepDecision = merge, with the successor named.
const LEGACY_SUCCESSOR = {
  runtime_status: "runtime_session_status",
  runtime_save_vsf: "runtime_session_snapshot",
  runtime_load_vsf: "runtime_session_snapshot",
  runtime_memory_access_map: "runtime_query_events / trace_store_bus_find",
  runtime_iec_bus_state: "runtime_swimlane_slice (iec lane)",
  runtime_diff_snapshots: "runtime_swimlane_slice (before/after)",
};

// Curated rows for the default surface (Spec 725 §3).
const CURATED = {
  agent_onboard: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "First call in any session: detect a new vs resumed project and load persistent project memory.", notFor: "Mid-task knowledge writes — use save_finding / agent_record_step.", adjacent: ["project_status", "c64re_whats_next", "start_re_workflow"], e2e: ["E2E-A", "E2E-H"] },
  c64re_whats_next: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "Ask the server for the next sensible action when unsure where to continue.", notFor: "Recording a completed step — use agent_record_step.", adjacent: ["agent_propose_next", "project_status"], e2e: ["E2E-A"] },
  agent_propose_next: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "Get a ranked next-action proposal from current project + phase state.", notFor: "Per-artifact phase moves — use the advanced phase tools.", adjacent: ["c64re_whats_next", "agent_record_step"], e2e: ["E2E-A"] },
  agent_record_step: { role: "workflow", swimlane: "validation", useWhen: "After every substantive step, persist what was done + propose the next branch.", notFor: "Storing analysis facts — use save_finding.", adjacent: ["agent_propose_next", "save_finding"], e2e: ["E2E-A", "E2E-C", "E2E-E"] },
  agent_set_role: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "Mark whether you operate as analyst, cartographer or implementer for this work.", notFor: "Choosing a workflow profile — use start_re_workflow.", adjacent: ["start_re_workflow", "agent_onboard"], e2e: ["E2E-A"] },
  start_re_workflow: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "Select the workflow/profile (crack, port, analysis, bugfix) for the project objective.", notFor: "Per-PRG static disassembly — use run_prg_reverse_workflow / disasm_prg.", adjacent: ["agent_set_role", "agent_onboard"], e2e: ["E2E-A"] },
  project_init: { role: "workflow", swimlane: "entry-project-baseline", useWhen: "Initialize a fresh directory as a C64RE project before any knowledge write — the product entry step for a new project.", notFor: "Resuming an existing project — use agent_onboard; choosing a workflow — use start_re_workflow.", adjacent: ["agent_onboard", "start_re_workflow", "project_status"], e2e: ["E2E-A", "E2E-H"] },
  project_status: { role: "knowledge-read", swimlane: "entry-project-baseline", useWhen: "Report whether the directory is a project and summarise its state.", notFor: "Listing individual artifacts — use list_artifacts.", adjacent: ["get_project_profile", "agent_onboard"], e2e: ["E2E-A", "E2E-H"] },
  get_project_profile: { role: "knowledge-read", swimlane: "entry-project-baseline", useWhen: "Read the active project's profile / objective / workflow selection.", notFor: "Mutating the profile — use start_re_workflow.", adjacent: ["project_status"], e2e: ["E2E-A"] },
  list_artifacts: { role: "knowledge-read", swimlane: "entry-project-baseline", useWhen: "List tracked artifacts (media, payloads, disasm, views).", notFor: "Reading one artifact's content — use read_artifact.", adjacent: ["read_artifact", "list_payloads"], e2e: ["E2E-A"] },
  list_payloads: { role: "knowledge-read", swimlane: "entry-project-baseline", useWhen: "List executable payloads discovered in media.", notFor: "Disassembling one payload — use disasm_prg.", adjacent: ["list_artifacts", "disasm_prg"], e2e: ["E2E-A"] },
  list_findings: { role: "knowledge-read", swimlane: "validation", useWhen: "Review recorded findings for the project.", notFor: "Creating a finding — use save_finding.", adjacent: ["save_finding", "list_open_questions"], e2e: ["E2E-A"] },
  list_open_questions: { role: "knowledge-read", swimlane: "validation", useWhen: "Review unresolved open questions.", notFor: "Asking a new question — use save_open_question.", adjacent: ["save_open_question"], e2e: ["E2E-A"] },
  list_entities: { role: "knowledge-read", swimlane: "asset-linking", useWhen: "List project entities (routines, assets, structures).", notFor: "Creating an entity — use save_entity.", adjacent: ["save_entity", "link_entities"], e2e: ["E2E-D"] },
  list_flows: { role: "knowledge-read", swimlane: "disassembly-improve", useWhen: "List recorded control/loader flows.", notFor: "Building a memory map — use build_memory_map.", adjacent: ["build_memory_map"], e2e: ["E2E-C"] },
  read_artifact: { role: "knowledge-read", swimlane: "entry-project-baseline", useWhen: "Read the content of a tracked artifact by id/path.", notFor: "Raw disk/CRT inspection — use inspect_disk / extract_crt.", adjacent: ["list_artifacts"], e2e: ["E2E-A"] },
  get_artifact_lineage: { role: "knowledge-read", swimlane: "validation", useWhen: "Trace an artifact's version lineage / derivation.", notFor: "Listing all artifacts — use list_artifacts.", adjacent: ["list_artifacts"], e2e: ["E2E-A"] },
  ram_report: { role: "knowledge-read", swimlane: "disassembly-improve", useWhen: "Read the project's RAM-usage hypotheses report.", notFor: "Live memory reads — use runtime_monitor_memory.", adjacent: ["build_memory_map", "runtime_monitor_memory"], e2e: ["E2E-C"] },
  save_finding: { role: "knowledge-write", swimlane: "validation", useWhen: "Persist an evidence-backed conclusion (routine, protection, asset origin).", notFor: "Transient chat notes — persist only durable conclusions.", adjacent: ["save_open_question", "link_entities", "agent_record_step"], e2e: ["E2E-A", "E2E-B", "E2E-C", "E2E-D"] },
  save_entity: { role: "knowledge-write", swimlane: "asset-linking", useWhen: "Record a named entity (routine/asset/struct) to link evidence to.", notFor: "Free-text conclusions — use save_finding.", adjacent: ["link_entities", "save_finding"], e2e: ["E2E-D"] },
  save_open_question: { role: "knowledge-write", swimlane: "validation", useWhen: "Record an unresolved question needing human input or later evidence.", notFor: "A settled conclusion — use save_finding.", adjacent: ["list_open_questions"], e2e: ["E2E-A"] },
  propose_annotations: { role: "disassembly", swimlane: "disassembly-improve", useWhen: "Write a draft annotation set (labels/segments/routine docs) for review.", notFor: "Applying + rebuilding — use disasm_prg with annotations.", adjacent: ["disasm_prg", "import_annotations_as_findings"], e2e: ["E2E-C"] },
  import_annotations_as_findings: { role: "knowledge-write", swimlane: "disassembly-improve", useWhen: "Promote annotation routine docs into durable findings.", notFor: "Drafting annotations — use propose_annotations.", adjacent: ["propose_annotations", "save_finding"], e2e: ["E2E-C"] },
  link_payload_to_asm: { role: "knowledge-write", swimlane: "asset-linking", useWhen: "Link a payload/byte range to its disassembly + evidence.", notFor: "Linking two entities — use link_entities.", adjacent: ["link_entities", "save_finding"], e2e: ["E2E-D"] },
  link_entities: { role: "knowledge-write", swimlane: "asset-linking", useWhen: "Relate two project entities (e.g. asset → producing routine).", notFor: "Linking a payload to code — use link_payload_to_asm.", adjacent: ["save_entity", "link_payload_to_asm"], e2e: ["E2E-D"] },
  inspect_disk: { role: "media-ingress", swimlane: "entry-project-baseline", useWhen: "Inspect a .d64/.g64 directory + layout from any absolute/project path.", notFor: "Extracting payloads — use extract_disk.", adjacent: ["extract_disk", "disk_sector_allocation"], e2e: ["E2E-A", "E2E-H"] },
  extract_disk: { role: "media-ingress", swimlane: "entry-project-baseline", useWhen: "Extract files/payloads from a disk image into project artifacts.", notFor: "Just listing the directory — use inspect_disk.", adjacent: ["inspect_disk", "list_payloads"], e2e: ["E2E-A", "E2E-H"] },
  extract_crt: { role: "media-ingress", swimlane: "entry-project-baseline", useWhen: "Extract banks/chips from a .crt cartridge into project artifacts.", notFor: "Live cartridge boot — use runtime_session_start / runtime_media_mount.", adjacent: ["runtime_media_mount"], e2e: ["E2E-A", "E2E-H"] },
  disk_sector_allocation: { role: "format-forensics", swimlane: "entry-project-baseline", useWhen: "Map BAM/sector allocation of a disk image.", notFor: "File extraction — use extract_disk.", adjacent: ["inspect_disk"], e2e: ["E2E-A"] },
  analyze_prg: { role: "static-analysis", swimlane: "disassembly-improve", useWhen: "Run the 9-analyzer heuristic pass over a PRG to find code/data/assets.", notFor: "Producing assembly text — use disasm_prg.", adjacent: ["disasm_prg", "inspect_address_range"], e2e: ["E2E-C"] },
  disasm_prg: { role: "disassembly", swimlane: "disassembly-improve", useWhen: "Disassemble a PRG to ASM; pass 2 consumes executed-PC evidence + annotations.", notFor: "Heuristic-only scan — use analyze_prg.", adjacent: ["analyze_prg", "propose_annotations", "runtime_resolve_pc"], e2e: ["E2E-C"] },
  disasm_menu: { role: "disassembly", swimlane: "disassembly-improve", useWhen: "Disassemble a specific menu/region with chosen entry points.", notFor: "Whole-PRG disasm — use disasm_prg.", adjacent: ["disasm_prg"], e2e: ["E2E-C"] },
  inspect_address_range: { role: "static-analysis", swimlane: "disassembly-improve", useWhen: "Inspect a byte/address range of a payload statically.", notFor: "Live memory — use runtime_monitor_memory.", adjacent: ["analyze_prg", "runtime_monitor_memory"], e2e: ["E2E-C"] },
  assemble_source: { role: "disassembly", swimlane: "validation", useWhen: "Assemble ASM (KickAss/64tass) to verify a byte-identical rebuild.", notFor: "Disassembly — use disasm_prg.", adjacent: ["disasm_prg"], e2e: ["E2E-C"] },
  c64ref_lookup: { role: "static-analysis", swimlane: "disassembly-improve", useWhen: "Look up a KERNAL/BASIC/hardware address or symbol meaning.", notFor: "Resolving a runtime PC to source — use runtime_resolve_pc.", adjacent: ["runtime_resolve_pc", "disasm_prg"], e2e: ["E2E-C"] },
  build_all_views: { role: "view-docs", swimlane: "validation", useWhen: "Regenerate every human view model for the project.", notFor: "One specific view — use the targeted build_* tool.", adjacent: ["build_project_dashboard", "render_docs"], e2e: ["E2E-A"] },
  build_project_dashboard: { role: "view-docs", swimlane: "validation", useWhen: "Build/refresh the project dashboard view after inventory or findings change.", notFor: "Memory map — use build_memory_map.", adjacent: ["build_all_views"], e2e: ["E2E-A"] },
  build_memory_map: { role: "view-docs", swimlane: "disassembly-improve", useWhen: "Build the project memory-map view.", notFor: "Annotated listing — use build_annotated_listing_view.", adjacent: ["ram_report", "build_annotated_listing_view"], e2e: ["E2E-C"] },
  build_annotated_listing_view: { role: "view-docs", swimlane: "disassembly-improve", useWhen: "Render the annotated disassembly listing view.", notFor: "Raw disasm text — use disasm_prg.", adjacent: ["disasm_prg", "build_memory_map"], e2e: ["E2E-C"] },
  render_docs: { role: "view-docs", swimlane: "validation", useWhen: "Render project documentation/report outputs.", notFor: "Building interactive views — use build_all_views.", adjacent: ["build_all_views"], e2e: ["E2E-A"] },
  suggest_depacker: { role: "static-analysis", swimlane: "disassembly-improve", useWhen: "Identify the likely packer/cruncher of a payload.", notFor: "Actually unpacking — use try_depack.", adjacent: ["try_depack"], e2e: ["E2E-C"] },
  try_depack: { role: "static-analysis", swimlane: "disassembly-improve", useWhen: "Attempt to unpack a packed payload into a usable image.", notFor: "Identifying the packer only — use suggest_depacker.", adjacent: ["suggest_depacker"], e2e: ["E2E-C"] },
  run_prg_reverse_workflow: { role: "workflow", swimlane: "disassembly-improve", useWhen: "Run the end-to-end per-PRG analyze→disasm→verify workflow.", notFor: "Project-level workflow selection — use start_re_workflow.", adjacent: ["analyze_prg", "disasm_prg"], e2e: ["E2E-C"] },
  runtime_session_start: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Start the Headless product runtime; pass disk_path/crt_path/prg_path + optional trace_out + trace_domains for durable capture. Disk-boot trace sequence: start(disk_path,trace_out) → session_run to BASIC READY → mark('basic-ready') → type('LOAD\"*\",8,1\\rRUN\\r') → session_run to stable screen → mark('loaded-or-title') → trace_finalize.", notFor: "VICE / scenario fixtures — those are advanced internal-dev paths.", adjacent: ["runtime_session_run", "runtime_mark", "runtime_trace_finalize", "runtime_media_mount"], e2e: ["E2E-B", "E2E-C", "E2E-H"] },
  runtime_session_status: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Read the live session's run state / cycle / media.", notFor: "Register dump — use runtime_monitor_registers.", adjacent: ["runtime_session_run", "runtime_monitor_registers"], e2e: ["E2E-B"] },
  runtime_session_run: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Advance the live session (instruction budget or until a stable-screen/PC condition).", notFor: "Single-step — use runtime_step_into / runtime_step_over.", adjacent: ["runtime_until", "runtime_mark"], e2e: ["E2E-B", "E2E-C"] },
  runtime_session_snapshot: { role: "runtime-inspect", swimlane: "freeze-inspect", useWhen: "Capture a checkpoint of the live machine for inspect/rewind/branch.", notFor: "Durable .c64re dump — that is an advanced session dump tool.", adjacent: ["runtime_render_screen", "runtime_vic_inspect_at"], e2e: ["E2E-D"] },
  runtime_media_browse: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "List media available to mount in the active project.", notFor: "Mounting — use runtime_media_mount.", adjacent: ["runtime_media_mount"], e2e: ["E2E-B"] },
  runtime_media_mount: { role: "media-ingress", swimlane: "runtime-explore", useWhen: "Mount a .d64/.g64 to drive 8 (or .crt) in the live session via the 709 ingress service.", notFor: "Swapping a mounted disk — use runtime_media_swap.", adjacent: ["runtime_media_swap", "runtime_media_unmount"], e2e: ["E2E-B", "E2E-H"] },
  runtime_media_unmount: { role: "media-ingress", swimlane: "runtime-explore", useWhen: "Eject media from a drive/cartridge slot.", notFor: "Mounting — use runtime_media_mount.", adjacent: ["runtime_media_mount"], e2e: ["E2E-B"] },
  runtime_media_swap: { role: "media-ingress", swimlane: "runtime-explore", useWhen: "Swap the drive-8 disk mid-session (checkpointed branch event).", notFor: "Initial mount — use runtime_media_mount.", adjacent: ["runtime_media_mount"], e2e: ["E2E-B"] },
  runtime_type: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Type text/commands into the live machine, e.g. LOAD\"*\",8,1\\rRUN\\r.", notFor: "Joystick/fire — use runtime_joystick.", adjacent: ["runtime_joystick", "runtime_session_run"], e2e: ["E2E-B"] },
  runtime_joystick: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Send joystick direction/fire into the live machine.", notFor: "Keyboard — use runtime_type.", adjacent: ["runtime_type"], e2e: ["E2E-B"] },
  runtime_load_prg: { role: "media-ingress", swimlane: "runtime-explore", useWhen: "Load a .prg into RAM (load) or load+run (inject-run) in the live session.", notFor: "Disk mount — use runtime_media_mount.", adjacent: ["runtime_session_start", "runtime_type"], e2e: ["E2E-H"] },
  runtime_render_screen: { role: "runtime-inspect", swimlane: "freeze-inspect", useWhen: "Render the current C64 screen as evidence of a visible state.", notFor: "Pixel→RAM resolution — use runtime_vic_inspect_at.", adjacent: ["runtime_session_snapshot", "runtime_vic_inspect_at"], e2e: ["E2E-B", "E2E-D"] },
  runtime_monitor_registers: { role: "runtime-monitor", swimlane: "freeze-inspect", useWhen: "Read CPU registers/flags at a paused state.", notFor: "Memory bytes — use runtime_monitor_memory.", adjacent: ["runtime_monitor_memory", "runtime_monitor_disasm"], e2e: ["E2E-D"] },
  runtime_monitor_memory: { role: "runtime-monitor", swimlane: "freeze-inspect", useWhen: "Read live RAM/IO bytes at a paused state.", notFor: "Static payload bytes — use inspect_address_range.", adjacent: ["runtime_monitor_registers", "inspect_address_range"], e2e: ["E2E-D"] },
  runtime_monitor_disasm: { role: "runtime-monitor", swimlane: "freeze-inspect", useWhen: "Disassemble around the live PC at a paused state.", notFor: "Static PRG disasm — use disasm_prg.", adjacent: ["runtime_monitor_registers", "runtime_resolve_pc"], e2e: ["E2E-D"] },
  runtime_step_into: { role: "runtime-monitor", swimlane: "freeze-inspect", useWhen: "Single-step one instruction, entering subroutines.", notFor: "Stepping over a JSR — use runtime_step_over.", adjacent: ["runtime_step_over", "runtime_until"], e2e: ["E2E-D"] },
  runtime_step_over: { role: "runtime-monitor", swimlane: "freeze-inspect", useWhen: "Single-step over a JSR without entering it.", notFor: "Entering the call — use runtime_step_into.", adjacent: ["runtime_step_into"], e2e: ["E2E-D"] },
  runtime_until: { role: "runtime-control", swimlane: "runtime-explore", useWhen: "Run until a PC/condition (e.g. stable screen) is reached.", notFor: "Fixed instruction budget — use runtime_session_run.", adjacent: ["runtime_session_run"], e2e: ["E2E-B", "E2E-C"] },
  runtime_resolve_pc: { role: "runtime-monitor", swimlane: "disassembly-improve", useWhen: "Resolve a runtime PC to a payload/source location for annotation evidence.", notFor: "Symbol/ROM lookup — use c64ref_lookup.", adjacent: ["disasm_prg", "c64ref_lookup"], e2e: ["E2E-C"] },
  runtime_vic_inspect_at: { role: "runtime-inspect", swimlane: "freeze-inspect", useWhen: "Resolve a screen pixel/cell to VIC/RAM evidence on a paused checkpoint.", notFor: "Whole-screen capture — use runtime_render_screen.", adjacent: ["runtime_render_screen", "runtime_monitor_memory"], e2e: ["E2E-D"] },
  runtime_mark: { role: "trace-capture", swimlane: "trace-capture", useWhen: "Stamp a phase mark (boot/title/loader/gameplay) into the active trace.", notFor: "Querying marks — use trace_store_anchor_list.", adjacent: ["runtime_session_start", "runtime_trace_finalize", "trace_store_anchor_list"], e2e: ["E2E-B"] },
  runtime_trace_finalize: { role: "trace-capture", swimlane: "trace-capture", useWhen: "Drain + close the live trace into a durable trace.duckdb.", notFor: "Starting a trace — use runtime_session_start(trace_out).", adjacent: ["runtime_session_start", "runtime_mark"], e2e: ["E2E-B"] },
  runtime_trace_status: { role: "trace-capture", swimlane: "trace-capture", useWhen: "Check whether a live trace is active + its queue/row counts.", notFor: "Reading rows — use runtime_query_events / trace_store_*.", adjacent: ["runtime_trace_finalize"], e2e: ["E2E-B"] },
  runtime_query_events: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Query trace events by family/cycle/pc/addr against a trace.duckdb.", notFor: "Custom SQL — use trace_store_query only for one-off questions.", adjacent: ["trace_store_top_pcs", "trace_store_bus_find"], e2e: ["E2E-B", "E2E-I"] },
  runtime_swimlane_slice: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Get a bounded multi-lane (c64/drive/iec/$dd00) slice around a cycle window.", notFor: "Single-family event list — use runtime_query_events.", adjacent: ["runtime_query_events", "trace_store_bus_find"], e2e: ["E2E-B"] },
  runtime_trace_taint: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Track how a value/address propagates through the trace.", notFor: "Top PCs — use trace_store_top_pcs.", adjacent: ["runtime_follow_path"], e2e: ["E2E-B"] },
  runtime_follow_path: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Follow a pointer/path of accesses through the trace.", notFor: "Taint propagation — use runtime_trace_taint.", adjacent: ["runtime_trace_taint"], e2e: ["E2E-B"] },
  runtime_profile_loader: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Profile loader phases / hot PCs / IEC activity from a trace.", notFor: "Generic event query — use runtime_query_events.", adjacent: ["runtime_query_events", "trace_store_top_pcs"], e2e: ["E2E-B"] },
  trace_store_info: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Summarise a trace.duckdb: run, event/channel/mark counts.", notFor: "Per-event rows — use runtime_query_events.", adjacent: ["trace_store_top_pcs", "runtime_query_events"], e2e: ["E2E-B", "E2E-I"] },
  trace_store_query: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Escape hatch for one-off custom SQL after the convenience readers cover the shape.", notFor: "Normal workflow — prefer trace_store_info/top_pcs/bus_find + runtime_query_events.", adjacent: ["runtime_query_events", "trace_store_info"], e2e: ["E2E-I"] },
  trace_store_top_pcs: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Get the most-executed PCs (executed-code set) for a cpu lane.", notFor: "Bus addresses — use trace_store_bus_find.", adjacent: ["trace_store_bus_find", "runtime_query_events"], e2e: ["E2E-B", "E2E-I"] },
  trace_store_bus_find: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Find bus reads/writes to an address/range (e.g. $dd00, IEC).", notFor: "Top PCs — use trace_store_top_pcs.", adjacent: ["trace_store_top_pcs"], e2e: ["E2E-B"] },
  trace_store_anchor_list: { role: "trace-query", swimlane: "trace-analysis", useWhen: "List phase marks/anchors recorded in a trace.", notFor: "Stamping a mark — use runtime_mark.", adjacent: ["trace_store_anchor_find", "runtime_mark"], e2e: ["E2E-B"] },
  trace_store_anchor_find: { role: "trace-query", swimlane: "trace-analysis", useWhen: "Find a mark/anchor by label/cycle in a trace.", notFor: "Listing all marks — use trace_store_anchor_list.", adjacent: ["trace_store_anchor_list"], e2e: ["E2E-B"] },
};

function classify(name, ns) {
  const t = tierForTool(name);
  if (CURATED[name]) return { tier: t, ...CURATED[name] };
  if (name.startsWith("vice_")) {
    return { tier: t, role: "internal-dev-oracle", swimlane: "internal-dev-only",
      useWhen: "Internal C64RE development only: compare Headless behaviour against the VICE oracle when investigating a port-fidelity divergence.",
      notFor: "Any normal product / external-LLM workflow — use the Headless runtime + trace tools instead.",
      useInstead: "runtime_session_start + trace readers", adjacent: [], e2e: ["E2E-F"] };
  }
  if (/^runtime_drive(_session)?_/.test(name)) {
    return { tier: t, role: "debug-only", swimlane: "internal-dev-only",
      useWhen: "Advanced drive-only debugging of the 1541 CPU/mechanics in isolation.",
      notFor: "Normal disk loading — mount via runtime_media_mount and run the real drive.",
      useInstead: "runtime_media_mount + runtime_session_run", adjacent: ["runtime_media_mount"], e2e: [] };
  }
  if (LEGACY_SUCCESSOR[name]) {
    return { tier: t, role: name.includes("snapshot") || name.includes("vsf") ? "runtime-inspect" : (name.includes("iec") || name.includes("access") || name.includes("diff") ? "trace-query" : "runtime-monitor"),
      swimlane: "internal-dev-only",
      useWhen: "Legacy pre-facade variant; retained only for backward-compat tooling.",
      notFor: "New work — the Spec 725/726 default facade supersedes it.",
      useInstead: LEGACY_SUCCESSOR[name], adjacent: [], e2e: [], keep: "merge" };
  }
  if (REPO_DEV_TOOLS.has(name) || /^runtime_(scenario|load_scenario|run_scenario)/.test(name)) {
    return { tier: t, role: "internal-dev-oracle", swimlane: "internal-dev-only",
      useWhen: "Internal dev: run/manage a built-in repo scenario fixture for regression/debug.",
      notFor: "External-LLM project work — start from user media via runtime_session_start.",
      useInstead: "runtime_session_start", adjacent: [], e2e: [] };
  }
  if (/export_(audio|video|screenshot)|capture_frame/.test(name)) {
    return { tier: t, role: "view-docs", swimlane: "operator-maintenance",
      useWhen: "Advanced: export audio/video/frame artifacts from a session.",
      notFor: "Normal screen evidence — use runtime_render_screen.",
      useInstead: "runtime_render_screen", adjacent: ["runtime_render_screen"], e2e: [] };
  }
  if (/input_(load|save)_(config|vicerc)/.test(name)) {
    return { tier: t, role: "maintenance", swimlane: "operator-maintenance",
      useWhen: "Advanced: configure input/keymap for a session.",
      notFor: "Sending input — use runtime_type / runtime_joystick.",
      useInstead: "runtime_type", adjacent: ["runtime_type"], e2e: [] };
  }
  if (name.startsWith("runtime_")) {
    const def = t === "default";
    return { tier: t, role: "runtime-control",
      swimlane: def ? "runtime-explore" : "internal-dev-only",
      useWhen: def ? "Part of the Headless runtime facade." : "Advanced runtime-control variant (lifecycle/dump/breakpoint/watch/batch/regression) for debugging.",
      notFor: def ? "VICE oracle work — that is advanced." : "Normal workflow — the default runtime facade covers session start/run/snapshot.",
      useInstead: def ? undefined : "runtime_session_start / runtime_session_run / runtime_session_snapshot",
      adjacent: ["runtime_session_start"], e2e: def ? ["E2E-B"] : [] };
  }
  if (/^(backfill_|dedupe_|repair_|register_|bulk_|sandbox_|reconstruct_)/.test(name) || ns === "maintenance") {
    return { tier: t, role: "maintenance", swimlane: "operator-maintenance",
      useWhen: "Operator/maintenance: repair/backfill/dedupe/register project-store records.",
      notFor: "Normal analysis — never use maintenance tools to answer RE questions.",
      adjacent: [], e2e: ["E2E-G"] };
  }
  if (/g64|gcr|_lut|_sector|_bam/i.test(name) || ns === "scan") {
    return { tier: t, role: "format-forensics", swimlane: t === "default" ? "entry-project-baseline" : "operator-maintenance",
      useWhen: "Low-level disk-format / GCR forensics on an image.",
      notFor: "Normal file extraction — use extract_disk.",
      useInstead: "extract_disk", adjacent: ["extract_disk", "inspect_disk"], e2e: t === "default" ? ["E2E-A"] : [] };
  }
  if (/^(pack_|depack_|compare_exomizer)/.test(name) || ns === "pack" || ns === "depack") {
    return { tier: t, role: "static-analysis", swimlane: "operator-maintenance",
      useWhen: "Advanced packer/depacker codec helper for a specific compression format.",
      notFor: "Normal depack workflow — use suggest_depacker + try_depack.",
      useInstead: "try_depack", adjacent: ["try_depack", "suggest_depacker"], e2e: [] };
  }
  if (/patch_recipe|apply_patch|^declare_loader|loader_event|loader_entrypoint/.test(name)) {
    return { tier: t, role: "change-intervention", swimlane: t === "default" ? "change-intervention" : "operator-maintenance",
      useWhen: "Advanced change/patch-recipe + loader-event bookkeeping.",
      notFor: "Normal analysis — record conclusions via save_finding.",
      adjacent: ["save_finding"], e2e: t === "default" ? ["E2E-E"] : [] };
  }
  if (ns === "agent") {
    return { tier: t, role: "workflow", swimlane: t === "default" ? "entry-project-baseline" : "operator-maintenance",
      useWhen: t === "default" ? "Core agent workflow step." : "Advanced agent/phase orchestration used inside a real RE project workspace.",
      notFor: t === "default" ? "Knowledge writes — use save_*." : "Casual use outside a C64RE project workspace.",
      adjacent: ["agent_onboard"], e2e: t === "default" ? ["E2E-A"] : [] };
  }
  if (ns === "project") {
    return { tier: t, role: "workflow", swimlane: t === "default" ? "entry-project-baseline" : "operator-maintenance",
      useWhen: t === "default" ? "Project lifecycle operation." : "Advanced project init/maintenance operation.",
      notFor: "Per-artifact analysis — use the analysis/disasm tools.",
      adjacent: ["project_status"], e2e: t === "default" ? ["E2E-A"] : [] };
  }
  if (ns === "trace") {
    return { tier: t, role: "trace-query", swimlane: t === "default" ? "trace-analysis" : "internal-dev-only",
      useWhen: t === "default" ? "Trace evidence query." : "Advanced/auxiliary trace tooling.",
      notFor: "Raw SQL by default — prefer the convenience readers.",
      adjacent: ["trace_store_info"], e2e: t === "default" ? ["E2E-B"] : [] };
  }
  // generic catch-all → advanced auxiliary.
  return { tier: t, role: t === "default" ? "static-analysis" : "maintenance",
    swimlane: t === "default" ? "disassembly-improve" : "operator-maintenance",
    useWhen: t === "default" ? "General project analysis helper." : "Advanced/auxiliary tool; not part of the normal workflow.",
    notFor: t === "default" ? "Runtime work — use the runtime facade." : "Normal workflow — covered by the default facade.",
    adjacent: [], e2e: t === "default" ? ["E2E-A"] : [] };
}

function keepDecisionFor(name, tier, cls) {
  if (cls.keep) return cls.keep;
  return tier === "default" ? "keep-default" : "keep-advanced";
}
function pathModeFor(name) {
  if (PATH_TOOLS.has(name)) return "project-or-absolute-ok";
  if (REPO_DEV_TOOLS.has(name) || /^runtime_(scenario|load_scenario|run_scenario)/.test(name)) return "repo-dev-only";
  return "no-path";
}

const rows = inv.tools.map((t) => {
  const cls = classify(t.name, t.ns);
  const tierR = cls.tier;
  const adjacent = (cls.adjacent || []).filter(Boolean);
  const e2e = (cls.e2e || []).slice();
  if (tierR === "default" && e2e.length === 0) e2e.push("E2E-A");
  const row = {
    name: t.name, namespace: t.ns, sourceFile: t.file, tier: tierR,
    role: cls.role, swimlane: cls.swimlane, useWhen: cls.useWhen, notFor: cls.notFor,
    adjacentTools: adjacent, e2eUseCases: e2e,
    keepDecision: keepDecisionFor(t.name, tierR, cls), pathMode: pathModeFor(t.name),
  };
  if (cls.useInstead) row.useInstead = cls.useInstead;
  if (TRACE_READERS.has(t.name)) {
    row.schemaContract = TRACE_SCHEMA;
    row.notes = `Trace reader: consumes the live-writer schema (${TRACE_SCHEMA}). MUST NOT query legacy meta/instructions tables (Spec 726 §6a).`;
  } else if (TRACE_WRITERS.has(t.name)) {
    row.schemaContract = TRACE_SCHEMA;
    row.notes = `Trace writer: produces ${TRACE_SCHEMA}.`;
  }
  return row;
});

const json = {
  generated: "scripts/gen-mcp-tool-usecase-matrix.mjs", spec: "727",
  total: rows.length,
  defaultCount: rows.filter((r) => r.tier === "default").length,
  advancedCount: rows.filter((r) => r.tier === "advanced").length,
  swimlaneLegend: {
    "entry-project-baseline": "onboard, status, media inventory, knowledge",
    "runtime-explore": "start/run Headless, mount, input, render",
    "freeze-inspect": "paused monitor + VIC inspect",
    "trace-capture": "durable trace_out + marks + finalize",
    "trace-analysis": "DuckDB evidence queries",
    "disassembly-improve": "static analysis + disasm + annotation",
    "asset-linking": "visible asset → RAM/file/code",
    "change-intervention": "patch/crack/port (future tooling)",
    "validation": "record step, build views, verify",
    "internal-dev-only": "VICE oracle, drive-only debug, scenario fixtures, legacy variants",
    "operator-maintenance": "store repair/backfill/dedupe/export",
    none: "unclassified",
  },
  e2eLegend: {
    "E2E-A": "New project + media inventory", "E2E-B": "Trace-first runtime discovery",
    "E2E-C": "Disassembly-first + trace validation", "E2E-D": "Frozen visual inspect → knowledge",
    "E2E-E": "Change / validation loop", "E2E-F": "VICE is internal-dev-only",
    "E2E-G": "Operator tools are not workflow tools", "E2E-H": "Path portability",
    "E2E-I": "Trace writer/reader schema contract",
  },
  rows,
};
writeFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), JSON.stringify(json, null, 2));

const bySwim = {};
for (const r of rows) (bySwim[r.swimlane] = bySwim[r.swimlane] || []).push(r);
const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const rowMd = (r) => `| \`${r.name}\` | ${r.tier} | ${r.role} | ${esc(r.useWhen)} | ${esc(r.notFor)} | ${r.useInstead ? esc(r.useInstead) : (r.adjacentTools.join(", ") || "—")} | ${r.e2eUseCases.join(" ") || "—"} | ${r.keepDecision} | ${r.pathMode} |`;
const HEAD = "| tool | tier | role | useWhen | notFor | useInstead / adjacent | e2e | keep | pathMode |\n|---|---|---|---|---|---|---|---|---|";

let md = `# MCP Tool Use-Case Matrix (Spec 727)

Generated by \`scripts/gen-mcp-tool-usecase-matrix.mjs\` from
\`docs/tool-surface-inventory.json\` + the live tier registry. One row per
registered MCP tool (${rows.length} total: ${json.defaultCount} default, ${json.advancedCount} advanced).

**Path-portability rule:** no default tool may be \`repo-dev-only\` or
\`broken-cwd-coupled\`. Path-taking tools resolve absolute OR project-relative
paths through the project resolver — never the MCP install dir or process cwd.

**VICE:** \`vice_*\` tools are internal-dev oracle only (advanced). External /
product LLM workflows use the Headless runtime + trace tools.

**Trace readers:** every trace-query tool consumes the live-writer schema
\`${TRACE_SCHEMA}\` and must not query legacy \`meta\`/\`instructions\` tables.

## 1. Quick answers (acceptance)

- Start a project → \`agent_onboard\` then \`start_re_workflow\`.
- Start Headless → \`runtime_session_start\`.
- Write a durable trace → \`runtime_session_start(trace_out=…)\` + \`runtime_mark\` + \`runtime_trace_finalize\`.
- Query a trace → \`trace_store_info\` / \`trace_store_top_pcs\` / \`runtime_query_events\`.
- Disassemble a payload → \`disasm_prg\` (after \`analyze_prg\`).
- Record a finding → \`save_finding\`.
- Use VICE → only for internal C64RE port-fidelity debugging (advanced \`vice_*\`).
- Not for normal workflow → \`vice_*\`, \`runtime_drive_*\`, maintenance/*, legacy runtime/trace variants.

## 2. Default surface

${HEAD}
${rows.filter((r) => r.tier === "default").sort((a, b) => a.swimlane.localeCompare(b.swimlane) || a.name.localeCompare(b.name)).map(rowMd).join("\n")}

## 3. Advanced surface

${HEAD}
${rows.filter((r) => r.tier === "advanced").sort((a, b) => a.swimlane.localeCompare(b.swimlane) || a.name.localeCompare(b.name)).map(rowMd).join("\n")}

## 4. Retire / merge / rename candidates

${HEAD}
${rows.filter((r) => ["merge", "retire", "rename"].includes(r.keepDecision)).sort((a, b) => a.name.localeCompare(b.name)).map(rowMd).join("\n") || "_(none)_"}

## 5. Full table by swimlane

`;
for (const sw of Object.keys(bySwim).sort()) {
  md += `### ${sw}\n\n${HEAD}\n${bySwim[sw].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)).map(rowMd).join("\n")}\n\n`;
}
writeFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.md"), md);

console.log(`727 matrix: ${rows.length} rows (${json.defaultCount} default, ${json.advancedCount} advanced) → docs/mcp-tool-usecase-matrix.{json,md}`);
