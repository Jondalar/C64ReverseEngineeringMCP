# Project Knowledge Layer

## Summary

This repository now contains a backend-first `project-knowledge` subsystem that turns the MCP server into one client of a project-centric reverse-engineering workspace.

The design keeps semantic interpretation, persistence, derived views, and analysis-run registration in the backend. The workspace UI consumes the stable JSON view-models from `project/views/*.json` and the `/api/*` endpoints surfaced by the workspace UI server.

Current state (after Sprints 1-51, Specs 001-058): the layer ships
artifact lineage + same-path versions (Spec 025), seven-phase workflow
(Spec 034), master/worker pattern (Spec 035), question auto-resolution
(Spec 052), phase-1 noise archive (Spec 053), latest-version-per-lineage
default (Spec 054), routine + segment-reclass findings auto-emit
(Spec 055), per-payload scope filter (Spec 056), closed-loop sweep
(Spec 057), and hide-internal-files (Spec 058). All knowledge-layer
record kinds carry `internal?: boolean` for the user-facing-vs-LLM
distinction and propagate it via `LineageVisibilityContext` /
`InternalVisibilityContext` in the UI.

## Layering

1. `src/project-knowledge/types.ts`
   Defines explicit TypeScript and Zod schemas for project metadata, artifacts, entities, findings, relations, flows, tasks, open questions, checkpoints, timeline events, and view-models.

2. `src/project-knowledge/storage.ts`
   Implements filesystem-backed project storage.
   Creates the workspace structure.
   Loads missing JSON files with safe defaults.
   Writes JSON atomically and in human-readable form.
   Persists checkpoints, timeline JSONL, tool-run records, and view-model files.

3. `src/project-knowledge/service.ts`
   Exposes high-level project operations:
   `initProject()`
   `getProjectStatus()`
   `saveArtifact()` (auto-classifies `internal` via
     `classifyArtifactInternal` based on path / role / kind — Spec 058)
   `saveEntity()` (derives `internal` from the primary linked
     artifact when not set explicitly — Spec 058)
   `listEntities()`
   `saveFinding()` (accepts top-level `addressRange` — Bug 25)
   `removeFindingsById()` (Spec 055)
   `backfillFindingAddressRanges()` (Bug 28)
   `listFindings()`
   `importAnalysisArtifact()` (also emits hypothesis findings with
     top-level `addressRange` — Bug 28 producer fix)
   `linkEntities()`
   `listRelations()`
   `saveFlow()`
   `listFlows()`
   `saveTask()`
   `listTasks()`
   `updateTaskStatus()`
   `saveOpenQuestion()`
   `listOpenQuestions()`
   `createCheckpoint()`
   `appendTimelineEvent()`
   `registerToolRun()`
   Spec 052 question auto-resolution:
     `resolveQuestionsForFinding({ findingId, artifactId? })`,
     `resolveQuestionsForPhase()`,
     `sweepQuestionResolutions({ artifactId? })`,
     `confirmQuestionResolution()`,
     `proposeQuestionResolutions()`.
   Spec 053 phase-1 noise archive:
     `archivePhase1Noise({ dryRun?, artifactId? })`,
     `markSegmentConfirmed()`, `markSegmentRejected()`,
     `clearSegmentMark()` (Bug 23 Stage 2).
   Spec 055 R25 routine emit:
     `emitAnnotationFindings({ sourcePrgArtifactId, annotationsPath, analysisJsonPath? })`.
   Spec 057 R26 closed loop:
     `runClosedLoopSweep({ artifactId? })`.
   View-builders:
     `buildProjectDashboardView()`, `buildMemoryMapView()`,
     `buildDiskLayoutView()`, `buildCartridgeLayoutView()`,
     `buildFlowGraphView()`, `buildAnnotatedListingView()`,
     `buildLoadSequenceView()`, `buildMediumLayoutView()`,
     `buildAllViews()`.
     All listing-style builders skip `internal === true` records (Spec 058).
   Per-artifact status (filters internal + collapses lineage + same-path):
     `getPerArtifactStatus()`.

4. `src/project-knowledge/view-builders.ts`
   Deterministic view-model builders that transform stored records into JSON payloads meant for direct UI consumption later.
   The flow-graph builder now merges explicit saved flows with relation-derived entity graphs so the project can remain explorable before manual flow modeling is complete.

5. `src/project-knowledge/integration.ts`
   Thin integration layer that registers existing analysis outputs as structured artifacts and tool-run records without rewriting the underlying TRXDis, CRT, or disk extraction pipelines.

6. `src/project-knowledge/mcp-tools.ts`
   MCP-facing tool registration for the knowledge layer.

## Workspace Layout

The service initializes this structure:

```text
project/
  input/
    prg/
    crt/
    disk/
    raw/
  artifacts/
    extracted/
    generated-src/
    previews/
    reports/
  analysis/
    runs/
    latest/
    indexes/
  knowledge/
    project.json
    artifacts.json
    entities.json
    findings.json
    relations.json
    flows.json
    notes.md
    tasks.json
    labels.user.json
    open-questions.json
  views/
    project-dashboard.json
    memory-map.json
    disk-layout.json
    cartridge-layout.json
    annotated-listing.json
    flow-graph.json
  session/
    timeline.jsonl
    checkpoints/
```

`knowledge/artifacts.json` is the only notable addition to the requested layout. It is necessary to make deterministic tool outputs, generated reports, extracted manifests, previews, and run metadata first-class project records.

## Record Model

Core persisted record groups:

- `project.json`
  Project metadata and identity.

- `artifacts.json`
  Input files, generated reports, disassemblies, extracted manifests, run records, previews, and other durable outputs.

- `entities.json`
  Named reverse-engineering objects such as routines, memory regions, data tables, banks, loader stages, disk files, and IRQ handlers.

- `findings.json`
  Observations, classifications, hypotheses, confirmations, and refutations with evidence and linked records.

- `relations.json`
  Structured links between entities like `calls`, `reads`, `writes`, `contains`, `derived-from`, and `maps-to`.

- `flows.json`
  Flow and sequence models with explicit nodes and edges.

- `tasks.json`
  Actionable work items and investigation TODOs.

- `open-questions.json`
  Unresolved ambiguities and evidence gaps.

- `session/checkpoints/*.json`
  Durable project checkpoints.

- `session/timeline.jsonl`
  Append-only activity log that survives `/new` and later continuation.

Every semantic record supports:

- `id`
- `kind`
- `title` or `name`
- `confidence`
- `status`
- `evidence`
- linked entity or artifact ids where relevant
- timestamps

Artifacts additionally carry:
- Lineage (Spec 025): `derivedFrom`, `lineageRoot`, `versionRank`,
  `versionLabel`, `versions[]` (same-path snapshots).
- Phase (Spec 034): `phase`, `phaseFrozen`, `phaseFrozenReason`.
- Platform (Spec 020): `platform`.
- Load contexts (Spec 023): `loadContexts[]`.
- Relevance (Spec 041): `relevance`.
- `internal` (Spec 058): hide-from-user marker, auto-classified.

Entities additionally carry the same `internal` marker (Spec 058) and
the payload-specific fields (`payloadId`, `payloadLoadAddress`,
`payloadFormat`, `payloadPacker`, `payloadSourceArtifactId`,
`payloadDepackedArtifactId`, `payloadAsmArtifactIds`,
`payloadContentHash`, `payloadDiskHint`).

Findings additionally carry top-level `addressRange` (Spec 053 / Bug 25)
and `archivedBy` (Spec 053).

## View Models

The first pass generates stable JSON for:

- `project-dashboard.json`
  Counts, recent artifacts, active findings, open tasks, open questions, and recent timeline events.

- `memory-map.json`
  Addressed regions derived from persisted entities and linked findings.

- `disk-layout.json`
  Disk layout derived from registered disk manifests.

- `cartridge-layout.json`
  Cartridge bank and chip layout derived from registered CRT manifests.

- `flow-graph.json`
  Nodes and edges derived from saved flows plus persisted entity relations.

- `annotated-listing.json`
  Deterministic listing entries derived from persisted analysis JSON artifacts plus linked entities and findings.

The analysis importer also derives:

- relation records from cross-references and entry-point mappings
- open questions from lower-confidence imported findings
- a first-pass flow model from imported code/data relations
- compatibility imports for simpler legacy analysis JSON files with plain hex entry points

## MCP Surface

The server registers these knowledge-layer MCP tools (organised by area):

Core records:
- `project_init`, `project_status`, `project_checkpoint`,
  `project_audit`, `project_repair`.
- `save_artifact`, `list_project_artifacts`, `list_artifacts`,
  `register_existing_files`, `bulk_create_cart_chunk_payloads`,
  `import_manifest_artifact`, `register_payload`, `list_payloads`,
  `register_container_entry`, `list_container_entries`,
  `snapshot_artifact_before_overwrite`, `rename_artifact_version`,
  `get_artifact_lineage`, `set_artifact_relevance`.
- `save_entity`, `list_entities`, `link_entities`, `list_relations`.
- `save_finding` (with top-level `address_range` — Bug 25),
  `list_findings`,
  `backfill_finding_address_ranges` (Bug 28 migration).
- `save_flow`, `list_flows`.
- `save_task`, `list_tasks`, `update_task_status`.
- `save_open_question`, `list_open_questions`.
- `import_analysis_report`, `bulk_import_analysis_reports`.

Question lifecycle (Spec 052):
- `auto_resolve_questions` (accepts `artifact_id` for scope —
  Spec 056), `propose_question_resolutions`,
  `confirm_question_resolution`.

Phase-1 noise + segment confirm/reject (Spec 053):
- `archive_phase1_noise` (accepts `artifact_id` for scope — Spec 056),
  `mark_segment_confirmed`, `mark_segment_rejected`.

Routine + segment-reclass findings emit (Spec 055):
- `import_annotations_as_findings` (also fires automatically when
  `disasm_prg` consumes annotations).

Agent orchestration (Spec 034 / 035 / 044):
- `agent_onboard`, `agent_set_role`, `agent_record_step`,
  `agent_propose_next`, `agent_advance_phase`,
  `agent_freeze_artifact`, `start_re_workflow`,
  prompt `c64re_worker_phase`.

View builders:
- `build_project_dashboard`, `build_memory_map`,
  `build_cartridge_layout_view`, `build_disk_layout_view`,
  `build_flow_graph_view`, `build_annotated_listing_view`,
  `build_load_sequence_view`, `build_all_views`.

Build pipelines / scenarios / patches / constraints / loaders
(Specs 027 / 029 / 030 / 032 / 028):
- `save_patch_recipe`, `apply_patch_recipe`,
  `register_resource_region`, `verify_constraints`,
  `define_runtime_scenario`, `diff_scenario_runs`,
  `save_build_pipeline`, `run_build_pipeline`,
  `declare_loader_entrypoint`, `record_loader_event`,
  `register_load_context`.

## Existing Tool Integration

Existing tools are connected through `registerToolKnowledge()` rather than rewritten.

Current first-pass automatic registrations:

- `analyze_prg`
  Registers the input PRG, output analysis JSON, a persisted tool-run record under `analysis/runs/`, and immediately imports deterministic entities, findings, relations, open questions, and a first-pass flow model from the analysis report.

- `disasm_prg`
  Registers the input PRG, optional analysis JSON, generated `.asm`, generated `.tass`, and a tool-run record.

- `ram_report`
  Registers the source analysis JSON, output markdown report, and a tool-run record.

- `pointer_report`
  Registers the source analysis JSON, output markdown report, and a tool-run record.

- `extract_crt`
  Registers the CRT input, extracted manifest, a tool-run record, and imports cartridge-bank/chip entities plus structural relations.

- `extract_disk`
  Registers the D64 or G64 input, extracted disk manifest, a tool-run record, and imports disk-file entities plus layout findings.

This keeps legacy output paths working while making the results available as structured project knowledge.

## Migration Plan

1. Start creating project workspaces with `project_init`.
2. Keep existing analysis tools unchanged from the user’s point of view.
3. Let the integration layer record outputs into `knowledge/artifacts.json` and `analysis/runs/`.
4. Begin storing semantic interpretation in structured records instead of freeform markdown.
5. Build stable `views/*.json` after significant analysis steps.
6. Later add a local React dashboard that reads only the persisted view-model files.
7. In a future pass, migrate default output locations from legacy `analysis/...` paths toward the new `artifacts/...` layout where it makes sense, without breaking existing projects.

## Example Workspace

There is no in-tree sample workspace. Point `C64RE_PROJECT_DIR` at any
local reverse-engineering project and run `npm run ui:serve` to use the
workspace UI against it.
