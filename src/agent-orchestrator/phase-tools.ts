// Spec 034 + 035: per-phase tool allow-lists + helpers used by
// agent_propose_next, the phase gate, and the c64re_worker_phase
// prompt. The phase model is described in docs/re-phases.md.

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
  2: "Understand how the title actually loads. KERNAL or custom fastloader? Container with sub-entries? Where do bytes land at runtime vs on disk? Done when the load chain is documented as a flow with loader entry points and load contexts.",
  3: "Run the deterministic Phase-1 analysis and a non-semantic first-pass disasm per relevant artifact. No LLM annotations yet. Done when every artifact has *_analysis.json + *_disasm.asm and rebuild verification has been attempted.",
  4: "Inspect every non-trivial segment by hand. Classify, hypothesize, look up hardware references. Open questions welcome. Done when every non-trivial segment is either understood or tracked in an open question.",
  5: "Merge the inspection findings into entities, write annotations, re-disassemble. Done when the disasm rebuilds byte-identical with annotations and ≥1 finding references the artifact.",
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
    "analyze_g64_anomalies",
    "declare_loader_entrypoint", "list_loader_entrypoints",
    "record_loader_event", "list_loader_events",
    "register_load_context", "register_container_entry",
    "list_container_entries", "save_flow",
    "link_payload_to_runtime", "link_payload_to_asm",
    "vice_session_start", "vice_session_attach_media",
    "vice_session_send_keys", "vice_session_status",
    "vice_session_stop", "vice_monitor_breakpoint_add",
    "vice_monitor_continue", "vice_monitor_step",
    "vice_monitor_memory", "vice_monitor_registers",
    "vice_trace_start", "vice_trace_stop", "vice_trace_runtime_start",
    "vice_trace_analyze_last_session", "vice_trace_hotspots",
    "vice_trace_find_pc", "vice_trace_find_memory_access",
    "headless_session_start", "headless_session_run",
    "headless_session_step", "headless_session_status",
    "headless_session_stop", "headless_breakpoint_add",
    "headless_trace_slice", "headless_trace_tail",
    "headless_monitor_memory", "headless_monitor_registers",
  ],
  3: [
    "analyze_prg", "disasm_prg", "ram_report", "pointer_report",
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
    "disasm_prg", "assemble_source",
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
    "save_finding", "disasm_prg", "assemble_source",
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

export function buildWorkerPrompt(args: { phase: PhaseNumber; artifactId: string; artifactTitle?: string; role?: "analyst" | "cracker" }): string {
  const role = args.role ?? "analyst";
  const tools = PHASE_TOOLS[args.phase];
  const lines: string[] = [];
  lines.push(`# Worker Briefing — Phase ${args.phase}: ${PHASE_TITLES[args.phase]}`);
  lines.push("");
  lines.push(`Target artifact: \`${args.artifactId}\`${args.artifactTitle ? ` (${args.artifactTitle})` : ""}`);
  lines.push(`Active role: ${role}`);
  lines.push("");
  lines.push(`## Your scope`);
  lines.push("");
  lines.push(PHASE_NARRATIVES[args.phase]);
  lines.push("");
  lines.push(`## Allowed tools`);
  lines.push("");
  for (const tool of tools) lines.push(`- \`${tool}\``);
  lines.push("");
  lines.push(`## Required outputs before stopping`);
  lines.push("");
  switch (args.phase) {
    case 1:
      lines.push("- Every payload visible on the medium is registered (audit reports 0 unregistered for this artifact's family).");
      break;
    case 2:
      lines.push("- ≥1 loader entry point declared on the artifact (or explicit confirmation that KERNAL LOAD is the only loader).");
      lines.push("- Load context recorded if runtime address differs from on-disk header.");
      break;
    case 3:
      lines.push("- `<stem>_analysis.json` + `<stem>_disasm.asm` exist for the artifact.");
      lines.push("- Rebuild verification attempted; result captured in the asm header.");
      break;
    case 4:
      lines.push("- Every non-trivial segment in the listing has either a 1-line classification or an open-question id.");
      break;
    case 5:
      lines.push("- Annotations file written; `disasm_prg` re-run with annotations; rebuild verified byte-identical.");
      lines.push("- ≥1 `save_finding` references the artifact.");
      break;
    case 6:
      lines.push("- Cross-artifact relations or flows added that reference this artifact.");
      lines.push("- Any refuted hypothesis recorded as `save_anti_pattern`.");
      break;
    case 7:
      lines.push("- Per-artifact status checklist at 100% for the active role.");
      lines.push("- `render_docs` run.");
      break;
  }
  lines.push("");
  lines.push(`## Hand-off contract`);
  lines.push("");
  lines.push("When you finish, return ONE Markdown report with:");
  lines.push(`- A heading: \`Phase ${args.phase} done\` or \`Phase ${args.phase} blocked: <reason>\``);
  lines.push("- A 1-line summary per tool call you made");
  lines.push("- A `recommended_next` block the master will pass to `agent_record_step`.");
  lines.push("");
  lines.push("Do not spawn further subagents. Do not call `agent_advance_phase`. Do not edit artifacts outside your target. The master decides next steps.");
  return lines.join("\n");
}
