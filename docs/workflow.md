# Reverse-Engineering Workflow Contract

The intended model is a **project-centric reverse-engineering
workspace** where each step leaves behind stable, inspectable artifacts.

The key promise is not only better extraction. The key promise is that
an LLM can turn those extracted facts into an explanation of the
program.

That is the moment where reverse engineering becomes dramatically more
useful:

- the heuristic pass finds structure
- the generated `.asm` files make that structure inspectable
- the semantic pass explains what a routine does and, more importantly,
  why it exists
- runtime evidence then strengthens, corrects, or confirms that
  explanation

This is the difference between:

- `segment $7C21-$7F4F contains code`

and:

- `this routine is the menu-side dispatcher for loading a saved game,
  restoring the relevant state, and handing control back to the active
  scene`

The contract is:

- tools produce manifests, reports, and structured metadata
- the knowledge layer links those outputs into entities, findings,
  relations, flows, tasks, and open questions
- the UI renders persisted JSON views and should infer as little as
  possible on its own
- raw runtime traces are source artifacts; compact runtime summaries are
  a later phase

`project_init` should create this contract up front, and
`project_status` should explain where the project currently sits inside
it.

## Why The LLM Matters

The deterministic tooling is necessary, but it is not the main insight
engine.

The deterministic phases answer:

- what bytes exist
- where code and data probably live
- which files, sectors, banks, and addresses are involved
- which addresses reference which others

The semantic phase is where the project starts to become legible:

- routines gain responsibilities
- tables gain meaning
- control flow turns into scenario flow
- loaders, menu handlers, room logic, savegame logic, render setup, and
  state transitions become explainable in human terms

This is where the best results usually appear. Even before any runtime
trace is added, the LLM can often extract much more meaning from the
generated `.asm`, cross-references, RAM reports, pointer reports, and
medium manifests than the heuristic layer alone.

After that first semantic pass, the LLM should not stop. It can feed
that understanding back into the project model:

- a generic little-endian table can become a meaningful
  `level-data table`, `room handler table`, or `script pointer table`
- a too-large segment can be split into code, table, and state regions
- multiple segments can be merged when they really belong to one logical
  unit
- ambiguous regions can trigger a targeted static re-analysis or
  disassembly pass for only the affected range
- manifests and metadata can be used to create stronger relationships
  between payloads, files, banks, and resident regions

This feedback loop is one of the most valuable parts of the workflow.
The LLM is not only interpreting the first heuristic output. It is
helping improve the static model itself.

Runtime data does not replace this semantic step. It deepens it.

Runtime evidence helps answer:

- is this interpretation actually exercised at runtime?
- in which order do these routines and payloads participate?
- which branch is the real hot path?
- what happens after a player action such as `Load saved game`?

So the intended model is:

1. heuristic facts
2. semantic understanding
3. runtime-backed semantic confidence

## Phase Overview

| Phase | Goal | Typical outputs |
|---|---|---|
| `workspace-init` | create project structure and workflow contract | `knowledge/project.json`, `knowledge/phase-plan.json`, `knowledge/workflow-state.json` |
| `input-registration` | register source media and raw inputs | tracked input artifacts with stable roles |
| `deterministic-extraction` | run reproducible analyzers/extractors | manifests, analysis JSON, reports, generated source |
| `structural-enrichment` | lift deterministic outputs into entities/relations/placement | entities, relations, structural flows, medium placement |
| `semantic-enrichment` | capture meaning, hypotheses, and work state | findings, tasks, open questions, semantic annotations |
| `semantic-feedback-refinement` | use semantic insight to improve the static model | refined analysis, stronger payload/file relations, clarified segments |
| `runtime-capture` | collect raw VICE/headless runtime evidence | trace artifacts, snapshots, raw runtime summaries |
| `runtime-aggregation` | condense raw runtime evidence into cheap reusable artifacts | `runtime-summary`, `runtime-phases`, `runtime-scenarios`, `memory-activity` |
| `view-build` | generate stable backend JSON view-models | `views/*.json` |

## Phase Contract

### 1. Workspace Init

Purpose:
- create the project directory structure
- persist project metadata
- persist the phase/workflow contract so a later `/new` session knows
  what the project expects

Required before:
- any project-centric work

Artifacts created:
- `knowledge/project.json`
- `knowledge/phase-plan.json`
- `knowledge/workflow-state.json`

Recommended tools:
- `project_init`

### 2. Input Registration

Purpose:
- register the real analysis targets and source media as tracked
  artifacts instead of relying on ad-hoc local paths

Required before:
- deterministic extraction

Artifacts created:
- input artifacts with roles such as:
  - `analysis-target`
  - `disk-image`
  - `cartridge-image`

Design rule:
- later phases should refer to tracked artifacts, not only raw
  filenames

### 3. Deterministic Extraction

Purpose:
- run the reproducible tooling layer without semantic interpretation

Examples:
- `analyze_prg`
- `disasm_prg`
- `ram_report`
- `pointer_report`
- `extract_crt`
- `inspect_disk`
- `extract_disk`

Artifacts created:
- `analysis-json`
- `disk-manifest`
- `crt-manifest`
- `kickassembler-source`
- `64tass-source`
- `ram-report`
- `pointer-report`

Design rule:
- this phase should produce facts, not opinions

### 4. Structural Enrichment

Purpose:
- turn deterministic outputs into reusable project structure

Artifacts and knowledge created:
- entities
- relations
- structural flows
- medium placement metadata such as `mediumSpans`
- medium roles such as loader/data/startup/code
- initial payload/file/bank relationships

Required before:
- persisted deterministic outputs, typically `analysis-json` and/or
  medium manifests

Design rule:
- physical placement on disk/cartridge should be stored explicitly in
  metadata, not rediscovered in the UI

### 5. Semantic Enrichment

Purpose:
- capture meaning, hypotheses, confirmations, and open work in
  structured form
- explain routines, tables, handlers, stages, and data in a way that a
  human or later LLM session can directly use

Artifacts and knowledge created:
- findings
- tasks
- open questions
- semantic annotations

Design rule:
- do not hide important project knowledge in markdown only; use
  structured records first and markdown as supporting notes
- when you do write project-level markdown (CLAUDE.md, docs/*.md,
  BUGREPORT.md, TODO.md, status notes, plans), register it via
  `save_artifact(kind="other", scope="knowledge", format="md",
  path="<relative path>", title="<doc title>")` so it appears in the
  workspace UI Docs tab and can be linked from findings/entities. The
  server also auto-enumerates unregistered `*.md` via `/api/docs` as a
  fallback, but explicit registration gives docs a stable id.

This is often the biggest value jump in the whole workflow. It is the
phase where "interesting bytes" become an explanation of the game or
system.

### 6. Semantic Feedback Refinement

Purpose:
- feed the first semantic understanding back into the static model
- refine the project structure instead of accepting the first heuristic
  cut as final

Artifacts and knowledge created:
- refined segment boundaries or classifications
- strengthened table meanings
- targeted re-analysis outputs for ambiguous ranges
- explicit relationships between payloads, files, banks, loader stages,
  and resident code/data

Typical examples:
- turn a generic lo/hi table into a `level-data table` with meaningful
  labels
- split a coarse segment into a routine block plus table block
- merge two adjacent segments that form one logical loader stage
- trigger another static disassembly pass for a specific address window
- link `file A` to `payload B`, `payload B` to `resident region C`, and
  `loader stage D` to the transition that activates it

Design rule:
- semantic analysis should be allowed to improve heuristic structure,
  not only comment on it

### 7. Runtime Capture

Purpose:
- gather raw runtime evidence from VICE/headless sessions

Artifacts created:
- traces
- snapshots
- raw runtime summaries or indexes

Design rule:
- these artifacts are source evidence, not direct UI material
- runtime is part of semantic understanding, but the raw trace itself is
  still only evidence

### 8. Runtime Aggregation

Purpose:
- condense large runtime outputs into cheap, stable artifacts
- make runtime evidence reusable by later semantic passes, the
  knowledge layer, and the UI

Artifacts created:
- `runtime-summary`
- `runtime-phases`
- `runtime-scenarios`
- `memory-activity`

Design rule:
- the UI and later LLM sessions should consume compact runtime artifacts
  instead of reparsing huge trace streams every time

### 9. View Build

Purpose:
- build stable JSON view-models from persisted backend knowledge

Artifacts created:
- `views/project-dashboard.json`
- `views/memory-map.json`
- `views/disk-layout.json`
- `views/cartridge-layout.json`
- `views/annotated-listing.json`
- `views/load-sequence.json`
- `views/flow-graph.json`

Design rule:
- the frontend renders backend conclusions; it should not become a
  second analysis engine

## Preconditions And Handoffs

Each phase should make the next phase easier and cheaper:

- `input-registration` gives deterministic tools stable targets
- `deterministic-extraction` produces the manifests and reports that
  structural enrichment consumes
- `structural-enrichment` gives semantic work stable entities and
  relations
- `semantic-enrichment` is where the main explanation of the system is
  formed
- `semantic-feedback-refinement` lets the LLM push that explanation back
  into better tables, segments, and payload/file relationships
- `runtime-capture` creates raw evidence that can confirm or challenge
  the semantic model
- `runtime-aggregation` turns that evidence into compact project facts
  that the semantic layer and UI can cheaply reuse
- `view-build` only depends on persisted knowledge and aggregated
  runtime artifacts

If a phase cannot start, the missing inputs should be visible in
`knowledge/workflow-state.json`.

## LLM Operating Rules

When working inside a project:

1. prefer tracked artifacts over loose file paths
2. emit manifests and structured metadata whenever a tool can do so
3. persist reusable facts in JSON, not only in prose
4. treat semantic analysis as the main explanation step, not as an
   afterthought to heuristics
5. let semantic analysis refine the static model itself when better
   structure becomes visible
6. use manifests/metadata to link payloads, files, banks, and resident
   regions explicitly
7. use runtime as semantic evidence and verification, not only as raw
   telemetry
8. treat runtime aggregation as a distinct phase after raw trace capture
9. build views from persisted knowledge, not from UI heuristics

## MCP Prompts

| Prompt | Description |
|---|---|
| `project_workspace_workflow` | Return this project-centric workflow contract. |
| `c64re_get_skill` | Return the canonical C64 RE skill text. |
| `full_re_workflow` | Strict PRG-centric 3-phase sub-workflow for one binary. |
| `disk_re_workflow` | Triage and analyze D64/G64 disk images. |
| `debug_workflow` | VICE runtime and breakpoint-driven debugging guidance. |

## Relationship To The Older 3-Phase PRG Workflow

The classic PRG-oriented flow still exists and remains useful for a
single binary:

1. deterministic analysis
2. semantic annotation
3. rebuild verification

In the project-centric model, that older flow now lives mostly inside:

- `deterministic-extraction`
- `semantic-enrichment`

and its outputs should be persisted as project artifacts and knowledge
instead of staying as one-off local files only.

If runtime evidence is available, it should be treated as an additional
semantic-evidence layer over that same flow, not as a completely
separate worldview.
