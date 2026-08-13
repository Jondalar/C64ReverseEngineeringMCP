# Project Knowledge Tools

Persistent project-knowledge layer (entities, findings, flows, relations,
tasks, labels, open questions). Imports analysis output into a structured
knowledge store and renders the JSON views the workspace UI consumes. See
`docs/product-vision-and-workbench-contract.md` for the bigger picture.

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
| `project_inventory_sync` | Register unregistered project files, import disk/CRT/PRG manifests, and rebuild stale views in one idempotent call. Use this as the default product action for inventory/sync work. |
| `import_analysis_report` | Pull entities, findings, relations, flows, and open questions out of a TRXDis analysis JSON. |

## View builders

| Tool | Description |
|---|---|
| `build_project_dashboard` | Render `views/project-dashboard.json` (metrics + section status). |
| `build_memory_map` | Render `views/memory-map.json` (memory regions + entity links). |
| `build_load_sequence_view` | Render `views/load-sequence.json` (loader / depacker phases). |
| `build_flow_graph_view` | Render `views/flow-graph.json` (structure / load / runtime modes). |
| `build_annotated_listing_view` | Render `views/annotated-listing.json` (semantic listing window). |
| `build_all_views` | Re-render every view in one call (including disk and cartridge layouts). |

## Addressing — the tables a medium is indexed by (Spec 750)

Reverse-engineering a medium means eventually finding a table: a cartridge index, the
CBM directory, a custom LUT. Recording it is what lets **every byte be traced to a
payload and through it to a purpose** — a byte is *identified* when a row claims it, and
what no row claims is the list of what is not yet understood.

| tool | what it is for |
|---|---|
| `declare_lut_descriptor` | describe a table you found: identity (`index` / `key-bytes` / `nested`), layout (`packed` = contiguous records, `columns` = parallel arrays), and one column per role with its address. Structurally checked, and answered with a **probe** of the first resolved rows. |
| `list_lut_descriptors` | which tables are already recorded |
| `resolve_lut_rows` | read what a table claims, resolved against the bytes |
| `link_payload_to_lut_row` | the claim: this payload is claimed by *(table, row)* |
| `declare_loader_entrypoint` | the code side — the routine that reads the table; point its `lut_descriptor_id` at it |

**Rows are never stored.** They are derived from the descriptor plus the medium bytes,
so correcting a descriptor corrects every row at once. Only the *claim* persists,
because that is what must survive without the image.

**Give it the parts that cannot be read off the bytes.** These are silently wrong for
every row when guessed, and the wrong numbers still look plausible:

- `deref` — `destination` holds a POINTER into the medium, not the destination.
- `polarity` — `codec` runs `value` (0 = none), `flag` (a bit; set = packed), or
  `inverted` (**0 = packed**). Nothing in the byte tells them apart.
- `length_bias` — the stored figure was already biased by whoever wrote it.
- `header_offset` — the offset cell points PAST a codec header; the payload starts
  earlier. Both forms are reported, so matching a manifest span cannot silently drift.

Hold the probe against the disassembly you just read before trusting the rest of the
table. Three rows are enough to see a flipped polarity.
