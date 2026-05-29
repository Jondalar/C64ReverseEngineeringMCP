// Spec 722.3a + 725 — tool tier gate. The DEFAULT surface is the NORMAL LLM
// project workflow — static project work (extract / inspect / disassemble /
// annotate / persist) AND runtime work (start Headless, mount media, type /
// joystick, run, render, monitor / frozen-inspect, query the TraceDB). It is
// NOT "static-only" (Spec 722 overcorrected; Spec 725 promotes the curated
// Headless Runtime + Monitor/Inspect + TraceDB facades to default).
//
// ADVANCED (only with `C64RE_FULL_TOOLS`): VICE oracle, drive-only debug,
// maintenance / backfill / dedupe / repair / bulk, raw scenario batch/debug,
// input-config, audio/video export, format-forensics, sandbox.
//
// Unknown / untagged tools resolve to "advanced" (NEVER silently default), so a
// newly-added tool stays out of the lean surface until explicitly promoted +
// described capability-first. `scripts/probe-tool-surface.mjs` reports any tool
// not covered here.
//
// Classification source: docs/tool-surface-classification.md (Spec 722.2).

export type ToolTier = "default" | "advanced";

/** The default façade — the only tools registered without C64RE_FULL_TOOLS. */
export const DEFAULT_TOOLS: ReadonlySet<string> = new Set<string>([
  // Enter / orient
  "agent_onboard", "c64re_whats_next", "agent_propose_next", "agent_record_step",
  "agent_set_role", "project_status", "get_project_profile",
  // Read knowledge
  "list_artifacts", "list_payloads", "list_findings", "list_open_questions",
  "list_entities", "list_flows", "read_artifact", "get_artifact_lineage",
  "ram_report",
  // Analyse / disassemble
  "analyze_prg", "disasm_prg", "disasm_menu", "inspect_address_range",
  "inspect_disk", "assemble_source", "c64ref_lookup",
  // Get bytes off media
  "extract_disk", "extract_crt", "disk_sector_allocation",
  // Record knowledge
  "save_finding", "save_entity", "save_open_question", "propose_annotations",
  "import_annotations_as_findings", "link_payload_to_asm", "link_entities",
  // Build views / docs
  "build_all_views", "build_project_dashboard", "build_memory_map",
  "build_annotated_listing_view", "render_docs",
  // Unpack façade
  "suggest_depacker", "try_depack",
  // Workflow entry
  "start_re_workflow", "run_prg_reverse_workflow",
  // Spec 725 §3.7 — Headless Runtime facade (the LLM's normal way to run the
  // product runtime; no V3 WebSocket server required).
  "runtime_session_start", "runtime_session_status", "runtime_session_run",
  "runtime_session_snapshot", "runtime_media_browse", "runtime_media_mount",
  "runtime_media_unmount", "runtime_media_swap", "runtime_type",
  "runtime_joystick", "runtime_load_prg", "runtime_render_screen",
  // Spec 725 §3.8 — Monitor / frozen-inspect facade.
  "runtime_monitor_registers", "runtime_monitor_memory", "runtime_monitor_disasm",
  "runtime_step_into", "runtime_step_over", "runtime_until",
  "runtime_resolve_pc", "runtime_vic_inspect_at",
  // Spec 725 §3.9 — TraceDB / evidence facade (DuckDB trace is a product
  // feature, not an internal debug escape hatch).
  "runtime_query_events", "runtime_swimlane_slice", "runtime_trace_taint",
  "runtime_follow_path", "runtime_profile_loader",
  "trace_store_info", "trace_store_query", "trace_store_top_pcs",
  "trace_store_bus_find", "trace_store_anchor_list", "trace_store_anchor_find",
  // Spec 726 — live trace capture facade (write side, completes the readers above).
  "runtime_mark", "runtime_trace_finalize", "runtime_trace_status",
]);

/** Documented cap on the default surface (probe fails if exceeded). Spec 725
 * raised this 45→80 to fit the Headless Runtime + TraceDB facade. */
export const DEFAULT_TIER_CAP = 80;

export function tierForTool(name: string): ToolTier {
  return DEFAULT_TOOLS.has(name) ? "default" : "advanced";
}

/** True when the full (advanced) surface is enabled via env. */
export function fullToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.C64RE_FULL_TOOLS && env.C64RE_FULL_TOOLS.trim());
}
