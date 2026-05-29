// Spec 722.3a — tool tier gate. Façade-first: the DEFAULT surface is the small
// set of normal project/RE workflow tools an LLM (outside the C64RE dev repo)
// reaches for. Everything else — raw runtime/debug, VICE oracle, maintenance,
// one-shot repair/backfill, format-forensics, sandbox — is ADVANCED and only
// registered when `C64RE_FULL_TOOLS` is set.
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
]);

/** Documented cap on the default surface (probe fails if exceeded). */
export const DEFAULT_TIER_CAP = 45;

export function tierForTool(name: string): ToolTier {
  return DEFAULT_TOOLS.has(name) ? "default" : "advanced";
}

/** True when the full (advanced) surface is enabled via env. */
export function fullToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.C64RE_FULL_TOOLS && env.C64RE_FULL_TOOLS.trim());
}
