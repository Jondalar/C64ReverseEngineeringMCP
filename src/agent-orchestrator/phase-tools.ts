// Spec 034 + 035: per-phase tool allow-lists + helpers used by
// agent_propose_next and the phase gate. The phase model is described in docs/re-phases.md.

export type PhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const PHASE_TITLES: Record<PhaseNumber, string> = {
  1: "Extraction / Inventarization",
  2: "Loader / Load behaviour / Sequence",
  3: "Heuristic Disasm",
  4: "Segment Analysis",
  5: "Semantic Analysis V1",
  6: "Meta Connections",
  7: "Semantic V2",
};

export const PHASE_NARRATIVES: Record<PhaseNumber, string> = {
  1: "Pull bytes off the medium and register every produced artifact. Done when every payload visible on the medium has a registered artifact and the audit reports zero unregistered files.",
  2: "Understand how the title actually loads. A bootable disk ALWAYS starts at the stock DOS directory (track 18) — the first KERNAL-loadable file is the loader stub; it uploads custom drive-code + the $dd00 handshake before any custom-GCR is read. Disassemble the loader files at full function breadth and semantically annotate them HERE (the drivecode track→payload tables are byte tables, meaningless until the indexing code is read) — loader RE belongs to Discovery, not deferred to phase 3. KERNAL or custom fastloader? Container with sub-entries? Where do bytes land at runtime vs on disk? Done when the load chain is documented as a flow with loader entry points and load contexts, and the loader files are disassembled + annotated.",
  3: "Run the deterministic Phase-1 analysis and a non-semantic first-pass disasm per relevant artifact. No LLM annotations yet. Done when every artifact has *_analysis.json + its listing (one file, in the project's dialect) and rebuild verification has been attempted.",
  4: "Inspect every non-trivial segment by hand. Classify, hypothesize, look up hardware references. Open questions welcome. Done when every non-trivial segment is either understood or tracked in an open question.",
  5: "Merge the inspection findings into entities, write annotations, re-disassemble. Every split low/high table the analysis found in confirmed code must be decided — declared in `splitTables` (`lo`, `hi`, `count`, `adjust` 1 for an RTS dispatch) or rejected with a reason — before the artifact leaves this phase; agent_advance_phase refuses otherwise. Done when the disasm rebuilds byte-identical with annotations, no found split table is open and ≥1 finding references the artifact.",
  6: "Step back from a single artifact. Cross-link entities across artifacts. Build flows. Spot meta-patterns. Done when cross-artifact relations + flows exist and anti-patterns / refuted hypotheses are recorded.",
  7: "Refine the V1 listings under meta-context. Lock in rebuild verification. Render docs. Done when the per-artifact status checklist is at 100% for the active role and the doc render has run.",
};

export const PHASE_TOOLS: Record<PhaseNumber, string[]> = {
  1: [
    "extract_disk", "extract_crt", "extract_disk_custom_lut",
    "extract_g64_raw_track", "extract_g64_sectors",
    "inspect_disk", "inspect_g64_blocks", "inspect_g64_syncs",
    "inspect_g64_track", "inspect_address_range",
    "register_existing_files", "register_payload",
    "bulk_create_cart_chunk_payloads", "bulk_import_analysis_reports",
    "save_artifact", "list_g64_slots", "scan_g64_headers",
    "scan_registration_delta", "list_artifacts", "list_payloads",
  ],
  2: [
    // Loader RE is a Discovery activity: the loader stub is a standard KERNAL-
    // loaded .prg and its drivecode tables must be disassembled + annotated to
    // understand the load chain — so analyze/disasm are first-class here, not
    // deferred to phase 3. (Doctrine: docs/agent-doctrine.md §0.7.)
    // retired-name-ok: the aliases belong in the phase list too, or an alias call reads as out-of-phase
    "analyze", "disasm", "analyze_prg", "disasm_prg",
    "analyze_g64_anomalies",
    "declare_loader_entrypoint", "list_loader_entrypoints",
    "record_loader_event", "list_loader_events",
    "register_load_context", "register_container_entry",
    "list_container_entries", "save_flow",
    "link_payload_to_runtime", "link_payload_to_asm",
    // Spec 806: the vice_* session/monitor/trace tools retired with the external
    // emulator bridge — the runtime_* surface below is the whole answer now.
    // V2 runtime_* surface (Spec 238) — preferred for new agent flows.
    "runtime_status", "runtime_step_into", "runtime_step_over",
    "runtime_until", "runtime_breakpoint_add", "runtime_breakpoint_list",
    "runtime_breakpoint_remove", "runtime_monitor_memory",
    "runtime_monitor_registers", "runtime_monitor_disasm",
    "runtime_query_events", "runtime_follow_path",
    "runtime_swimlane_slice", "runtime_trace_taint",
    "runtime_save_vsf", "runtime_load_vsf", "runtime_resolve_pc",
    "runtime_diff_snapshots",
    // Integrated session control (kept; V2.x has no direct replacement).
    "runtime_session_start", "runtime_session_run",
    // Spec 806: runtime_session_snapshot retired with the TS emulator (structured
    // JSON state was its own product, not the daemon's snapshot/dump file).
    "runtime_session_status",
    "runtime_render_screen", "runtime_checkpoint_capture",
  ],
  3: [
    // retired-name-ok: the aliases belong in the phase list too, or an alias call reads as out-of-phase
    "analyze", "disasm", "analyze_prg", "disasm_prg", "disasm_raw", "ram_report", "pointer_report",
    "import_analysis_report", "inspect_address_range",
    "c64ref_lookup", "c64ref_build_rom_knowledge",
    "run_prg_reverse_workflow", "run_payload_reverse_workflow",
    "build_tools",
  ],
  4: [
    "inspect_address_range", "scan_graphics_candidates",
    "render_graphics_preview", "pointer_report", "ram_report",
    "c64ref_lookup", "c64ref_build_rom_knowledge", "disasm_menu",
    "save_open_question", "list_open_questions",
    "update_task_status", "save_task", "list_tasks",
    "list_entities", "list_findings",
  ],
  5: [
    "save_finding", "save_entity", "save_relation",
    "link_entities", "link_cart_chunk_to_asm",
    "write_annotations", "merge_annotations",
    // retired-name-ok: the aliases belong in the phase list too, or an alias call reads as out-of-phase
    "disasm", "disasm_prg", "assemble_source",
    "snapshot_artifact_before_overwrite",
    "rename_artifact_version", "list_findings", "list_entities",
  ],
  6: [
    "save_relation", "save_flow", "link_entities",
    "link_payload_to_asm", "link_payload_to_runtime",
    "link_cart_chunk_to_asm", "bulk_import_analysis_reports",
    "build_flow_graph_view", "build_load_sequence_view",
    "save_anti_pattern", "list_anti_patterns",
    "verify_constraints", "list_relations", "list_flows",
    "render_docs",
  ],
  7: [
    // retired-name-ok: the aliases belong in the phase list too, or an alias call reads as out-of-phase
    "save_finding", "disasm", "disasm_prg", "assemble_source",
    "render_docs", "save_patch_recipe", "apply_patch_recipe",
    "list_patch_recipes", "save_build_pipeline",
    "build_all_views", "build_project_dashboard",
    "build_memory_map", "build_disk_layout_view",
    "build_cartridge_layout_view", "build_annotated_listing_view",
    "agent_advance_phase",
  ],
};

// Tools that are always allowed regardless of phase. Includes the
// orchestration primitives, project audit / repair, and read-only
// listing tools that do not advance state.
export const PHASE_AGNOSTIC_TOOLS: string[] = [
  "agent_onboard", "agent_propose_next", "agent_record_step",
  "agent_set_role", "agent_advance_phase", "agent_freeze_artifact",
  "agent_next_step", "agent_run_step",
  "project_audit", "project_repair", "project_status",
  "project_init", "project_checkpoint",
  "list_artifacts", "list_entities", "list_findings",
  "list_open_questions", "list_relations", "list_flows",
  "list_tasks", "list_loader_entrypoints", "list_loader_events",
  "list_container_entries", "list_patch_recipes",
  "list_anti_patterns", "get_artifact_lineage",
  "get_project_profile", "save_project_profile",
  "save_open_question", "list_payloads",
  "read_artifact", "read_g64_sector_candidate",
  "build_tools",
];

export function phaseForTool(toolName: string): PhaseNumber | "agnostic" | undefined {
  if (PHASE_AGNOSTIC_TOOLS.includes(toolName)) return "agnostic";
  for (const [phase, tools] of Object.entries(PHASE_TOOLS)) {
    if (tools.includes(toolName)) return Number(phase) as PhaseNumber;
  }
  return undefined;
}

export function isToolAllowedInPhase(toolName: string, currentPhase: PhaseNumber, strictGate = true): { allowed: boolean; reason?: string } {
  const tag = phaseForTool(toolName);
  if (tag === "agnostic") return { allowed: true };
  if (tag === undefined) return { allowed: true, reason: "tool not phase-tagged; treated as agnostic" };
  if (strictGate) {
    if (tag <= currentPhase + 1) return { allowed: true };
    return {
      allowed: false,
      reason: `tool belongs to phase ${tag} (${PHASE_TITLES[tag]}); current phase is ${currentPhase} (${PHASE_TITLES[currentPhase]}). Skipping more than one phase ahead is not allowed under phaseGateStrict.`,
    };
  }
  return { allowed: true };
}
