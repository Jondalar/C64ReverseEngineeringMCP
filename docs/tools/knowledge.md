# Project Knowledge Tools

Persistent project-knowledge layer (entities, findings, flows, relations,
tasks, labels, open questions). Imports analysis output into a structured
knowledge store and renders the JSON views the workspace UI consumes. See
[Semantic UI layer](../semantic-ui-layer.md) for the bigger picture.

## Project lifecycle

| Tool | Description |
|---|---|
| `project_init` | Initialise a project workspace (directory layout + empty knowledge files). |
| `project_status` | Report project state, open task counts, and last checkpoint. |
| `project_checkpoint` | Save a named checkpoint of the current knowledge state under `session/checkpoints/`. |

## Entities, findings, relations

| Tool | Description |
|---|---|
| `save_entity` | Create or update an entity (memory region, routine, chip, asset, symbol, …). |
| `list_entities` | Filter / search entities. |
| `save_finding` | Record a finding (observation, hypothesis, confirmed fact). |
| `list_findings` | Filter / search findings. |
| `link_entities` | Add a typed relation between two entities. |
| `list_relations` | Filter / search relations. |
| `save_open_question` | Track an unresolved RE question against entities or findings. |
| `list_open_questions` | Filter / search open questions. |

## Tasks + flows

| Tool | Description |
|---|---|
| `save_task` | Create or update a task. |
| `update_task_status` | Move a task between statuses. |
| `list_tasks` | Filter / search tasks. |
| `save_flow` | Persist a flow (load chain, runtime phase, structural call graph). |
| `list_flows` | Filter / search flows. |

## Artifacts

| Tool | Description |
|---|---|
| `save_artifact` | Register an artifact (path + role + scope) so views can reference it. |
| `list_project_artifacts` | Filter / search registered artifacts. |
| `import_analysis_report` | Pull entities, findings, relations, flows, and open questions out of a TRXDis analysis JSON. |
| `import_manifest_artifact` | Pull entities + relations out of CRT or disk manifest JSON. |

## View builders

| Tool | Description |
|---|---|
| `build_project_dashboard` | Render `views/project-dashboard.json` (metrics + section status). |
| `build_memory_map` | Render `views/memory-map.json` (memory regions + entity links). |
| `build_cartridge_layout_view` | Render `views/cartridge-layout.json` (cart-type-aware bank grid + ROML / ROMH / EEPROM mapping). |
| `build_disk_layout_view` | Render `views/disk-layout.json` (per-disk file list + sector chains). |
| `build_load_sequence_view` | Render `views/load-sequence.json` (loader / depacker phases). |
| `build_flow_graph_view` | Render `views/flow-graph.json` (structure / load / runtime modes). |
| `build_annotated_listing_view` | Render `views/annotated-listing.json` (semantic listing window). |
| `build_all_views` | Re-render every view in one call. |
