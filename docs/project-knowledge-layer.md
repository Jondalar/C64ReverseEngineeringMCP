# Project Knowledge Layer

## Summary

This repository now contains a backend-first `project-knowledge` subsystem that turns the MCP server into one client of a project-centric reverse-engineering workspace.

The design keeps semantic interpretation, persistence, derived views, and analysis-run registration in the backend. A future React UI can consume only stable JSON view-models from `project/views/*.json` without needing to re-implement reverse-engineering logic in the browser.

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
   `saveArtifact()`
   `saveEntity()`
   `listEntities()`
   `saveFinding()`
   `listFindings()`
   `importAnalysisArtifact()`
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
   `buildProjectDashboardView()`
   `buildMemoryMapView()`
   `buildDiskLayoutView()`
   `buildCartridgeLayoutView()`
   `buildFlowGraphView()`
   `buildAnnotatedListingView()`
   `buildAllViews()`

4. `src/project-knowledge/view-builders.ts`
   Deterministic view-model builders that transform stored records into JSON payloads meant for direct UI consumption later.
   The flow-graph builder now merges explicit saved flows with relation-derived entity graphs so the project can remain explorable before manual flow modeling is complete.

5. `src/project-knowledge/integration.ts`
   Thin integration layer that registers existing analysis outputs as structured artifacts and tool-run records without rewriting the underlying TRXDis, CRT, or disk extraction pipelines.

7. `scripts/refresh-polarbear-example.mjs`
   Re-imports the seeded `polarbear-in-space-example` artifacts and rebuilds every view so the example stays aligned with the current knowledge model.

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

The server now registers these knowledge-layer MCP tools:

- `project_init`
- `project_status`
- `save_artifact`
- `list_project_artifacts`
- `save_finding`
- `list_findings`
- `list_entities`
- `list_relations`
- `list_open_questions`
- `list_tasks`
- `list_flows`
- `save_open_question`
- `save_entity`
- `import_analysis_report`
- `import_manifest_artifact`
- `link_entities`
- `save_flow`
- `save_task`
- `update_task_status`
- `project_checkpoint`
- `build_project_dashboard`
- `build_memory_map`
- `build_cartridge_layout_view`
- `build_disk_layout_view`
- `build_flow_graph_view`
- `build_annotated_listing_view`
- `build_all_views`

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

A seeded sample workspace is included at:

- `examples/polarbear-in-space-example`

It contains persisted knowledge JSON, sample manifests, session history, checkpoints, and derived view-model files for the imaginary project `Polarbear in Space`.
