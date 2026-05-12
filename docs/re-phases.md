# Seven-Phase Reverse-Engineering Workflow

This file is the agent-facing definition of the seven phases C64RE
work moves through. Each phase has a narrow scope, an explicit
allowed-tool set, and a "done" criterion. Skip phases at your own
risk — phase 5+ findings without phase 4 inspection are routinely
wrong.

## Phase 1 — Extraction / Inventarization

Pull bytes off the medium and register every produced artifact in
the project knowledge layer.

- **Allowed tools**: `extract_disk`, `extract_crt`,
  `extract_disk_custom_lut`, `extract_g64_*`, `inspect_disk`,
  `inspect_g64_*`, `inspect_address_range`, `register_existing_files`,
  `register_payload`, `bulk_create_cart_chunk_payloads`,
  `bulk_import_analysis_reports`, `save_artifact`.
- **Done when**: every payload visible on the medium has a registered
  artifact; the audit reports zero unregistered files.

## Phase 2 — Loader / Load behaviour / Sequence

Understand how the title actually loads. KERNAL? Custom fastloader?
Container with sub-entries? Where do bytes land at runtime vs on
disk?

- **Allowed tools**: `analyze_g64_anomalies`,
  `declare_loader_entrypoint`, `list_loader_entrypoints`,
  `record_loader_event`, `register_load_context`,
  `register_container_entry`, `list_container_entries`,
  `vice_session_*`, `vice_trace_*`, `headless_session_*`,
  `headless_trace_*`, `save_flow`, `link_payload_to_runtime`.
- **Done when**: the load chain is documented as a flow; loader entry
  points exist for every routed call; load contexts cover any file
  whose runtime address differs from the on-disk PRG header.

## Phase 3 — Heuristic Disasm

Deterministic Phase-1 analysis plus a non-semantic first-pass disasm
per relevant artifact. No LLM annotations yet.

- **Allowed tools**: `analyze_prg`, `analyze_raw` (via
  `--load-address`), `disasm_prg` (no annotations), `ram_report`,
  `pointer_report`, `import_analysis_report`, `inspect_address_range`,
  `c64ref_lookup`.
- **Done when**: every relevant artifact has a `*_analysis.json` and
  a `*_disasm.asm`; rebuild verification has been attempted.

## Phase 4 — Segment Analysis

Inspect every non-trivial segment by hand. Classify, hypothesize,
look up hardware references. Open questions are welcome.

- **Allowed tools**: `inspect_address_range`, `scan_graphics_candidates`,
  `render_graphics_preview`, `pointer_report`, `ram_report`,
  `c64ref_lookup`, `c64ref_build_rom_knowledge`, `disasm_menu`,
  `save_open_question`, `list_open_questions`,
  `update_task_status`.
- **Done when**: every non-trivial segment is either understood or
  tracked in an open question; you would not be embarrassed to
  defend the segment classification.

## Phase 5 — Semantic Analysis V1

Merge the inspection findings into entities, write annotations,
re-disassemble. Produces the first humans-can-read version of the
listing.

- **Allowed tools**: `save_finding`, `save_entity`, `save_relation`
  (within an artifact only), `link_entities`, annotation files
  (write under `analysis/.../{stem}_annotations.json`),
  `disasm_prg` (with annotations), `assemble_source --compare_to`.
- **Done when**: the disasm rebuilds byte-identical with annotations;
  ≥1 finding references the artifact; the segment list reads
  semantically (named labels, no `WXXXX` everywhere).

## Phase 6 — Meta Connections

Step back from a single artifact. Cross-link entities across
artifacts. Build flows. Spot patterns the per-artifact view missed.

- **Allowed tools**: `save_relation`, `save_flow`, `link_entities`,
  `link_payload_to_*`, `bulk_import_analysis_reports`, doc renderer,
  `save_anti_pattern` (when a meta-pattern reveals a refuted
  hypothesis), `verify_constraints`.
- **Done when**: cross-artifact relations exist; flows describe at
  least the load chain; anti-patterns / refuted hypotheses are
  recorded.

## Phase 7 — Semantic V2

Refine the V1 listings under meta-context. Lock in rebuild
verification. Render docs. Mark the artifact "ship-ready" or
"frozen at phase X for cracker reasons".

- **Allowed tools**: `save_finding` (refined), `disasm_prg` final
  pass with full annotations, `assemble_source --compare_to`,
  `render_docs`, `save_patch_recipe` (cracker), `apply_patch_recipe`,
  `save_build_pipeline`, `agent_advance_phase` (terminal).
- **Done when**: per-artifact status checklist is at 100% for the
  active role; rebuild verified; doc render run.

## Phase Gating

`agent_propose_next` and the optional hard phase gate
(`projectProfile.phaseGateStrict = true`) keep work on-phase. Skip a
phase only with explicit `agent_advance_phase(toPhase, evidence=...)`.

## Cracker Freeze

For asset PRGs that have no relevance to the crack / port, set
`agent_freeze_artifact(artifact_id, reason)` after phase 3. The
artifact stays at its frozen phase, counts as "done" for
completion-percentage math, and is skipped by `propose_next`
unless the user opts back in.

## Master + Worker Pattern (Spec 035)

Strongly recommended:

1. The master agent (your main Claude Code session) reads
   `agent_propose_next` and decides the next phase task.
2. The master spawns a Task subagent with the
   `c64re_worker_phase(phase, artifact_id, role)` prompt.
3. The worker has only the phase's allowed tools and stops when
   its hand-off contract is met.
4. The master collects the worker report, calls
   `agent_record_step`, and loops.

This keeps the master's context clean and prevents drift inside the
worker.
