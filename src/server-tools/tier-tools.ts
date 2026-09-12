// Spec 722.3a + 725 — tool tier gate. The DEFAULT surface is the NORMAL LLM
// project workflow — static project work (extract / inspect / disassemble /
// annotate / persist) AND runtime work (start Headless, mount media, type /
// joystick, run, render, monitor / frozen-inspect, query the TraceDB). It is
// NOT "static-only" (Spec 722 overcorrected; Spec 725 promotes the curated
// Headless Runtime + Monitor/Inspect + TraceDB facades to default).
//
// ADVANCED (only with `C64RE_FULL_TOOLS`): the external-emulator oracle used
// during runtime development, drive-only debug, maintenance / backfill / dedupe
// / repair / bulk, raw scenario batch/debug, legacy input-config, audio/video
// export, format-forensics, sandbox.
//
// A RE-facing tool description must not name an external emulator (2026-07-09):
// it is not an option for RE work, and naming it invites the flight-to-runtime
// the static-first doctrine exists to stop. Only the `.vsf` interchange format
// may name it, and only when marked LEGACY / DEPRECATED.
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
  // Spec 844 — the completeness question. project_slots answers "for this disk set,
  // these relationships are unnamed, here they are", which agent_next_step (a TO-DO
  // question) structurally cannot; slot_record is the door that fills one. Both must be
  // on the DEFAULT surface: a tool not in this set is HIDDEN, and a gate that refuses
  // while naming a tool the caller cannot see is a dead end.
  "project_slots", "slot_record",
  // Spec 845 — the model layer. model_read is the RE-ENTRY read: after a compact or a
  // /new it returns the boundaries with their citations, what is still open, and what was
  // already refuted. It only helps if a fresh session can reach it without being told it
  // exists, which means the default surface.
  "model_read", "model_assert", "model_remove",
  // Spec 846 — the counter-pressure. project_critique is the adversarial pass the owner
  // used to be; critic_checks is the severity table, on the surface so a finding that
  // looks mis-ranked can be argued with instead of ignored.
  "project_critique", "critic_checks",
  // Spec 847 — documents declare themselves. doc_template must be reachable BEFORE a
  // document is written, doc_register right after, and wiki_index replaces the curated
  // docs/index.md that sat empty in both long-running projects for four months.
  "doc_register", "doc_lint", "doc_template", "wiki_index",
  // Read knowledge
  "list_artifacts", "list_payloads", "list_findings", "list_open_questions",
  "list_entities", "list_flows", "read_artifact", "get_artifact_lineage",
  "ram_report",
  // Analyse / disassemble
  "analyze_prg", "disasm_prg", "disasm_menu", "inspect_address_range",
  "inspect_disk", "assemble_source", "c64ref_lookup",
  // BASIC V2: read a tokenized program (and its SYS target) before assuming a
  // PRG is 6502, and write one back. A cracked game very often boots through
  // BASIC, and until now that boot was disassembled as machine code.
  "basic_list", "basic_tokenize",
  // BUG-039 — poll the background job analyze_prg returns for large PRGs (job
  // mode prevents the >180s host stall that dropped the MCP connection).
  "analysis_job_status",
  // Get bytes off media
  "extract_disk", "extract_crt", "disk_sector_allocation",
  // Record knowledge
  "save_finding", "save_entity", "save_open_question", "propose_annotations",
  // Spec 822.2: import_annotations_as_findings retired — the annotations file is
  // a door into the graph (D6): disasm_prg imports it, `c64re graph annotations-import`
  // for a file disasm_prg never saw.
  "link_payload_to_asm", "link_entities",
  // BUG-024 — register a carved code-derived/custom-loader block as a first-class
  // payload (load addr + format + source .prg + medium spans) so it renders on the
  // disk/memory views like a CBM/LUT-extracted payload. Common in cracks.
  "register_payload",
  // Spec 750.2 — the addressing itself. Without these in DEFAULT the tables can be
  // described by nobody: the stores existed for months and stayed empty because no
  // agent could reach the write tools from the standard surface.
  "declare_lut_descriptor",
      "suggest_lut_descriptor",
      "derive_payload_relations",
      "suggest_loader_entrypoints",
  "list_lut_descriptors",
  "resolve_lut_rows",
  "link_payload_to_lut_row",
  "declare_loader_entrypoint",
  "list_loader_entrypoints",
  // Spec 784 — the loader-lens extraction chain: a per-project extractor's manifest
  // bulk-registers as first-class payloads (FULL medium spans + derivedBy + LoaderModel
  // records), trace-validated against what the real loader actually read. Product
  // default surface — the crack Discovery workflow calls these directly.
  "register_payloads_from_manifest", "validate_extraction", "list_loader_models",
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
  "runtime_media_browse", "runtime_media_mount",
  "runtime_media_unmount", "runtime_media_persist", "runtime_media_swap",
  // BUG-027 Blocker 2 (Spec 744 §7.2) — high-level "Insert side N" answer:
  // eject→run→insert→run→RETURN→run as ONE call (atomic swap can't be sensed).
  "runtime_swap_disk_and_continue", "runtime_type",
  "runtime_joystick", "runtime_load_prg", "runtime_run_prg", "runtime_render_screen",
  // Spec 812 — the capture scenario and the release reel it produces. Default,
  // not advanced: producing a documentation reel is a recurring need on every
  // release project, and it is the only door where an input schedule carries its
  // own durations — a hidden tool would leave callers hand-orchestrating the
  // primitives, which is the situation the spec was written to end.
  "runtime_scene_reel",
  // Spec 836 D3 — the SAME private machine, reachable without a .feature file.
  // Default for the reason the defect exists: a caller who wants to try their own
  // medium without disturbing anyone had no door but `runtime_session_start`, and
  // that one attaches to the machine a human is co-driving. A private door that is
  // invisible on the default surface does not prevent that mistake — it only makes
  // it harder to explain afterwards. It replaces orchestration rather than adding
  // to it: one call instead of start/mount/type/run/render against the wrong machine.
  "runtime_sandbox_run",
  // Spec 725 §3.8 — Monitor / frozen-inspect facade.
  // Spec 766 — runtime_monitor: the one-tool monitor REPL (whole interactive
  // monitor in one call). A default product tool, not advanced.
  "runtime_monitor",
  // Spec 769 — time-travel rewind (seek+restore a past checkpoint) + the
  // code-overlay debug loop (rewind→patch→run→observe, repeatable).
  "runtime_rewind",
  "runtime_overlay_run",
  "runtime_monitor_registers", "runtime_monitor_memory", "runtime_monitor_disasm",
  "runtime_step_into", "runtime_step_over", "runtime_until",
  "runtime_resolve_pc", "runtime_vic_inspect_at",
  // Spec 839 — the other two halves of Spec 721's Visual-Origin Join. A tool is
  // HIDDEN until it is in DEFAULT_TOOLS, and the whole point of this spec is that
  // what the human can do the LLM can do.
  "runtime_vic_inspect_region", "runtime_vic_origin",
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
  // Spec 784 — read a loader-lens capture's landing map (drive-sector→C64-dest), the
  // ground truth validate_extraction diffs a manifest against.
  "runtime_loader_lens",
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
  // Spec 823 — the knowledge graph's five doors (817–822 build the graph; these
  // are the only tools over it). Thin by gate: parse → one library call → format.
  "graph_find", "graph_node", "graph_edges", "graph_path", "graph_overview",
  // Spec 748 (BUG-032) — persistent project STEERING (the steering-file analogue):
  // always-apply rules injected at the top of agent_onboard every session.
  "project_steering_set",
  // 2026-07-05 — promote wrongly-hidden CORE RE tools. These were "advanced" only as
  // bloat-collateral, but both clients (Claude Code + Codex) defer schemas, so hiding
  // them cost discoverability for no gain (sandbox_depack was invisible even to search).
  // The internal/maintenance plumbing stays advanced (facade discipline unchanged).
  // Sandbox 6502 depack — run a game's OWN depacker/decryptor over packed bytes.
  "sandbox_depack", "sandbox_6502_run",
  // Time-travel / recorder (Specs 765/766/769) — checkpoints, dump-from-anchor, branch.
  "runtime_checkpoint_capture", "runtime_checkpoint_list", "runtime_checkpoint_pin",
  "runtime_checkpoint_restore", "runtime_checkpoint_unpin",
  "runtime_recorder_dump", "runtime_recorder_list", "runtime_recorder_status",
  "runtime_snapshot_tree", "runtime_promote_branch", "runtime_diff_snapshots",
  "runtime_component_diff",
  // Candidate model (Spec 796) — live scenario-bound overlay branches.
  "runtime_candidate_create", "runtime_candidate_patch", "runtime_candidate_run",
  "runtime_candidate_remove_patch", "runtime_candidate_list", "runtime_candidate_delete",
  "runtime_candidate_export", "runtime_candidate_derive_delta",
  "runtime_find_cheat",
  // Runtime export + input-config: render the live session's audio; load/save the
  // c64re keyboard/joystick config. `runtime_input_load_vicerc` is deliberately
  // ADVANCED — it parses a legacy foreign emulator config, is a one-off bootstrap,
  // and its name would put an external emulator back on the RE surface.
  // 2026-08-12 — `runtime_session_export_audio` DEMOTED to advanced rather than raise
  // the cap a second time in one day. Writing a .wav of a session is a nice thing to
  // have and not a step in reverse-engineering anything; it also fails the
  // description-shape rule, so it was never carrying its place. Spec 750.7's
  // `suggest_lut_descriptor` takes the slot, and that one removes actual handwork.
  // 2026-08-12 — `runtime_input_save_config` DEMOTED. Writing a joystick keymap to
  // ~/.config is housekeeping, not a step in reverse-engineering anything; loading one
  // stays, because a session that will not take input is a session you cannot drive.
  // Spec 750.6's `derive_payload_relations` takes the slot: it finds mutators, which
  // is the case where a byte-identical rebuild is green and the result is still wrong.
  // 2026-08-12 — `runtime_input_load_config` DEMOTED too. Loading a joystick keymap is
  // setup a human does once, not a step an agent takes while reverse-engineering; the
  // session takes input without it. Spec 750.5's `suggest_loader_entrypoints` takes the
  // slot — it implements the third addressing kind in Spec 750 §1's model, and without
  // it that model was two thirds built.
]);

// ── Retired with the TypeScript emulator (Spec 806 step 3) ───────────────────
//
// Eleven ADVANCED-only tools were removed rather than routed, because the emulator
// WAS their implementation and the runtime has no equivalent object to route to.
// Recorded here so a later reader does not read the absence as an oversight:
//
//   runtime_drive_session_start / _status / _persist_writes /
//   runtime_drive_session_save_vsf / _load_vsf / runtime_iec_bus_state
//     — a STANDALONE 1541 session (a drive with no C64). The runtime's drive only
//       exists inside a machine; there is no such object to expose.
//   runtime_session_snapshot
//     — returned a structured JSON state object; the daemon's snapshot/dump writes
//       a .c64re FILE. Different product, not a missing route. Use the checkpoint
//       ring + runtime_component_diff.
//   runtime_export_screenshot / _video / _audio
//     — replayed a saved SCENARIO to a cycle and wrote PNG/MP4/WAV. There is no
//       export/* method group on the daemon; session/screenshot, render_screen and
//       audio/export are all LIVE-session verbs (the last one is
//       runtime_session_export_audio, which stays).
//   runtime_diagnose_mm
//     — a per-title one-shot diagnostic built entirely on an in-process machine.
//
// None was in DEFAULT_TOOLS, so the default surface is byte-identical. Do NOT
// re-add any of them as a daemon route without a spec: each would be a new feature
// wearing an old tool's name.

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
 * Spec 748 raised 108→109 (project_steering_set — persistent project steering).
 * BUG-039 raised 109→110 (analysis_job_status — poll analyze_prg's job mode).
 * Spec 784 raised 110→114 (the loader-lens extraction chain: register_payloads_from_
 * manifest + validate_extraction + list_loader_models + runtime_loader_lens).
 * 2026-07-05 raised 114→141: promoted the group-11 disk/G64 + group-14 TRX64
 * runtime surface (checkpoint/recorder/rewind/overlay/monitor/run_prg + the
 * sandbox depack pair) to default — see collectToolInventory() in server.ts,
 * which the tool-surface gate reads live (no more frozen inventory drift).
 * 2026-07-09 lowered 141→140: runtime_input_load_vicerc demoted to advanced.
 * 2026-08-12 raised 140→150, and the honest half of that is that it was ALREADY at
 * 144: Specs 784, 796 and 798 promoted tools without touching this number, so the
 * gate stood red and was read as background noise. Spec 750.2 adds the last six —
 * the addressing surface (declare/list_lut_descriptor, resolve_lut_rows,
 * link_payload_to_lut_row) plus the two loader-entry-point tools that were
 * unreachable, which is exactly why `loader-entry-points` sat empty for months.
 * These belong in DEFAULT: mapping index → position is what the workbench IS for,
 * and a tool an agent cannot reach might as well not exist. The cap is a discipline
 * about how much surface an agent must hold at once, not a budget to be smuggled
 * past — raise it deliberately, here, with the reason, or demote something.
 * 2026-08-17 raised 150→151 for `runtime_scene_reel`. It earns the slot because it
 * REPLACES orchestration rather than adding to it: producing a release reel used to
 * mean hand-driving mount, type, joystick, run and screenshot in a loop, one call
 * per waypoint, and getting a different result each time. One door that takes the
 * whole schedule is less surface for an agent to hold, not more — and there is no
 * other tool where an input carries its own duration.
 * FULL, so this is said plainly: five tools that answer "who calls / who writes /
 * what does this touch / is there a path / where are the unknowns" from an index
 * replace the loop of read_artifact + inspect_address_range + a 5 000-line
 * listing that an agent runs today to answer the same question by hand. Less
 * surface to hold per question, not more — the runtime_scene_reel argument. If
 * 151 must hold, 823 OQ1 names project_wiki_lint as the demotion candidate.
 *
 * 2026-09-06, second raise, 156 → 158 for Spec 829's `basic_list` +
 * `basic_tokenize` — stated here rather than left for the probe to discover.
 * They earn the slot for the same kind of reason: a PRG that loads at $0801 was
 * being disassembled as 6502 across its token bytes (issue #11), so the default
 * surface had no way to READ the boot a cracked game most often arrives with, or
 * to name the address it SYSes into. The two raises are independent — 823's five
 * graph tools and 829's two — and they merged into one number here.
 *
 * 2026-09-09, NOT raised: Spec 836's `runtime_sandbox_run` takes the one free slot
 * this number had left, so the default surface sat at 158 of 158.
 *
 * 2026-09-10, raised to 200 (owner's call). What this cap actually costs was
 * measured wrong for a while, including by me: in this harness MCP tools are
 * DEFERRED — the client holds their NAMES and fetches a schema only when it
 * reaches for one — so a default tool does not carry its description in the
 * context window permanently. The cap therefore buys a smaller thing than
 * "context": it decides what is registered and so what a caller can FIND at
 * all.
 *
 * That is still worth a limit, because finding is the real bottleneck: a
 * surface nobody can survey sends a caller to the wrong tool by name
 * similarity — which is exactly how a session looking for a sandboxed
 * cartridge landed on `sandbox_6502_run`, a CPU sandbox with no machine in it.
 * 200 leaves room for the verbs the workbench UI can reach and the tool
 * surface cannot (measured 2026-09-10: fifteen, `media/unmount` among them)
 * without pretending the number is free. */
export const DEFAULT_TIER_CAP = 200;

export function tierForTool(name: string): ToolTier {
  return DEFAULT_TOOLS.has(name) ? "default" : "advanced";
}

/** True when the full (advanced) surface is enabled via env. */
export function fullToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.C64RE_FULL_TOOLS && env.C64RE_FULL_TOOLS.trim());
}
