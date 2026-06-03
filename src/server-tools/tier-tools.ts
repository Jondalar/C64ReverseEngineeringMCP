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
  // Create the project. The product entry step (vision §2.4): a fresh external
  // directory must be initializable from the default surface — otherwise the
  // knowledge-write tools reject every call with "not an initialized c64re
  // project". Without this the swimlane cannot even start. (Spec 727 gap.)
  "project_init",
  // Spec 730.3 — single product facade over register/import/view-rebuild. The
  // callable action when files are present-but-unregistered, manifests are
  // unimported, or views are stale. Wraps the internal maintenance helpers so
  // the LLM never has to call them directly.
  "project_inventory_sync",
  // Spec 730.4 — the step orchestrator. agent_next_step returns the single
  // MCP-chosen next product step (+ branches) from real project state;
  // agent_run_step runs the inventory/media-sync step in-process and points at
  // the product tool for every other step. Both keep internal maintenance tools
  // off the recommendation path (doNotCall only).
  "agent_next_step", "agent_run_step",
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
  // BUG-024 — register a carved code-derived/custom-loader block as a first-class
  // payload (load addr + format + source .prg + medium spans) so it renders on the
  // disk/memory views like a CBM/LUT-extracted payload. Common in cracks.
  "register_payload",
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
  // BUG-027 Blocker 3 (Spec 744.3) — close/release a session so a finished
  // RuntimeController stops ticking (otherwise it pegs a core ~100%); the clean
  // alternative to killing the process. Must be on the default surface next to start.
  "runtime_session_close",
  "runtime_session_snapshot", "runtime_media_browse", "runtime_media_mount",
  "runtime_media_unmount", "runtime_media_persist", "runtime_media_swap", "runtime_type",
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
  "trace_memory_map", // Spec 753 — page memory map (free RAM / persistence surface)
  // Spec 726 — live trace capture facade (write side, completes the readers above).
  // runtime_trace_start is THE enable-on-a-running-session entry point — without it
  // on the default surface the LLM could finalize/status a trace it can't begin
  // (BUG: it was omitted, so a default-surface agent reported "no tool to start a
  // trace" while the UI toggle worked). Spec 746 makes this the LLM's live-trace gate.
  "runtime_trace_start", "runtime_mark", "runtime_trace_finalize", "runtime_trace_status",
  // Spec 730.1 — promote disk/G64 + cartridge RE tools to the default surface.
  // Disk / G64 raw-inspection product tools:
  "list_g64_slots", "inspect_g64_track", "inspect_g64_blocks", "inspect_g64_syncs",
  "scan_g64_headers", "read_g64_sector_candidate", "extract_g64_sectors",
  "extract_g64_raw_track", "analyze_g64_anomalies",
  "suggest_disk_lut_sector", "extract_disk_custom_lut", "set_payload_disk_hint",
  // Cartridge chunk product tools:
  "bulk_create_cart_chunk_payloads", "link_cart_chunk_to_asm", "record_cart_chunk_packer",
  // Spec 730 §7 — artifact version-op tools. Targeted "current best version"
  // model so the LLM + UI resolve a payload's source to the curated/semantic
  // file instead of a stale generated dump. Each takes a single subject id.
  "list_artifact_versions", "get_current_artifact", "set_current_artifact_version",
  "mark_artifact_version_stale",
  // Spec 740.1 — Project Wiki + Knowledge Retrieval. The normal "where is X?"
  // entry point + neighbour walk + index rebuild + wiki coverage lint.
  "project_search", "project_find_related", "project_reindex_search", "project_wiki_lint",
  // Spec 748 (BUG-032) — persistent project STEERING (the steering-file analogue):
  // always-apply rules injected at the top of agent_onboard every session.
  "project_steering_set",
]);

/** Documented cap on the default surface (probe fails if exceeded). Spec 725
 * raised this 45→80 to fit the Headless Runtime + TraceDB facade. Spec 730.1
 * raised 80→95 to fit the promoted disk/G64 + cartridge RE tools (15 new).
 * Spec 730.4 raised 95→100 to fit the step orchestrator (agent_next_step +
 * agent_run_step). Spec 740.1 raised 100→104 for the project wiki/search tools
 * (project_search + project_find_related + project_reindex_search +
 * project_wiki_lint). BUG-024 raised 104→106 (headroom) when promoting
 * register_payload — carved code-derived loads become first-class payloads.
 * BUG-027 raised 106→107 (runtime_session_close — session lifecycle/close).
 * Spec 746 raised 107→108 (runtime_trace_start — the LLM's enable-trace-on-a-
 * running-session gate; its finalize/status siblings were already default).
 * Spec 748 raised 108→109 (project_steering_set — persistent project steering). */
export const DEFAULT_TIER_CAP = 109;

export function tierForTool(name: string): ToolTier {
  return DEFAULT_TOOLS.has(name) ? "default" : "advanced";
}

/** True when the full (advanced) surface is enabled via env. */
export function fullToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.C64RE_FULL_TOOLS && env.C64RE_FULL_TOOLS.trim());
}
