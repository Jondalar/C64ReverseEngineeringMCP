# C64RE Product Vision and Unified Workbench Contract

Status: CANONICAL PRODUCT DIRECTION (2026-05-25 CEST)  
Scope: agent workflow, runtime evidence, semantic disassembly, and human UI  
Implements through: `docs/agent-doctrine.md`, `docs/re-phases.md`, Specs 705, 708, 710-712, 720-721

## 1. Product Purpose

C64RE is an agent-guided reverse-engineering workbench for Commodore 64
software. Its product value is not simply extracting binaries or running a C64.
It joins:

- a persistent project knowledge store;
- a faithful, inspectable C64/1541/cartridge runtime (provided by the TRX64
  backend, which C64RE orchestrates rather than owns);
- durable full-trace evidence and focused runtime queries;
- disassembly and semantic annotation;
- one human workbench in which runtime observations link back to bytes, media,
  code, findings, and interventions.

The quality target is a project where a human and an LLM can explain how a title
loads, runs, protects itself, renders assets, and can be changed, with each
important claim backed by reproducible evidence.

The reference standard for semantic output is the connected, evidence-backed
quality achieved in the Accolade Comics / EasyFlash work: readable routines and
flows explained using static structure together with observed execution.

## 2. Primary User Journey

The canonical first-run experience is conversational and agent-directed:

1. The user starts a Claude or Codex session in a directory and asks to make a
   C64 project using the MCP.
2. The agent connects to C64RE, calls onboarding/project-status tools, and
   reports whether the directory is a new or resumed project.
3. For a new project, the agent asks what the objective is, for example:
   crack, EasyFlash conversion, general analysis, bug fix, or targeted routine.
4. The agent initializes the directory using the C64RE project contract and
   selects the corresponding workflow/profile, for example `cracker-only`.
5. The agent requests input media in the project input location and registers
   `.d64`, `.g64`, `.crt`, `.prg`, and related context as tracked artifacts.
6. The agent runs deterministic ingestion/extraction sufficient to inventory the
   medium and discover executable payloads.
7. For media-driven crack/port work, the agent proposes an early runtime run:
   mount the real medium, run the title, capture frames/checkpoints, and retain
   a DuckDB runtime trace suitable for later queries.
8. The agent asks for human interaction when necessary: fire button, joystick
   direction, menu choice, disk flip, password, or external background sources.
9. From extraction plus runtime evidence, the agent creates or refines:
   - loader flow;
   - memory map;
   - medium/file/payload overview;
   - runtime phases and significant screens;
   - protection or banking observations;
   - tasks and open questions.
10. The agent proposes disassembly once the important payload and execution
    chain are sufficiently understood.
11. Disassembly is enriched first mechanically and then semantically using
    retained runtime evidence, with byte-identical rebuild verification where
    applicable.
12. The work becomes interactive: the user runs the game, inspects visible
    assets, views monitor state beside annotated disassembly, rewinds to prior
    behavior, creates findings, and tests patch/intervention branches.

At each stage the MCP/agent proposes the next valid action; the user steers
intent and approves meaningful branches of work.

## 2A. Project Lifecycle — the first-level experience (BINDING)

C64RE is a **workflow workbench**, not a data/relations browser. The product's
first-level structure is a five-phase reverse-engineering **project lifecycle**.
The human + LLM move **forward and backward** through it and iterate; the workbench
exposes, per phase, the relevant **tools, evidence, decisions, open questions, agent
roles, next actions, and outputs**. TRX64 is the forensic runtime backend throughout
(Leitregel §3); C64RE owns meaning/workflow/knowledge.

The five phases (this replaces "12 flat data tabs" as the top-level concept):

1. **Onboarding** — start/resume a project; optionally play/watch the title together
   (via TRX64); capture the actual human **goal** (EasyFlash port, cheat, trainer,
   enhancement, loader replacement, bugfix, docs, crack, general analysis). *Outputs:*
   goal brief, initial complexity impression, project strategy + selected workflow
   profile. *Tools:* onboarding/project-init, goal capture, runtime "just run it" beat,
   Docs.
2. **Discovery** — media extraction + payload inventory; loader analysis; packer/depacker
   detection + select/build; define the agent team + workflow profile. *Outputs:*
   inventory, loader hypothesis, payload map, workflow profile. *First-class tools:*
   **Disk** and **CRT/Cartridge** forensic surfaces (see below), Payloads, Memory Map,
   Graphics, depacker tools.
3. **Reverse Engineering** — disassembly; semantic annotation; payload classification
   (code/engine, helper, level, asset+type, loader, tables, data blobs); TRX64 runtime
   evidence, but **C64RE owns interpretation**. *Outputs:* annotated knowledge, verified
   findings, open questions, semantic map. *Tools:* Annotated Listing, Flow/Load-sequence,
   Scrub, **Disk + Cartridge** (still first-class here), Payloads, runtime evidence.
4. **Build** — build the new target medium / new loader / target feature in loops;
   preserve traceability between decisions, code/data changes, and runtime validation.
   *Outputs:* working modified artifact. *Tools:* workflow runner, source/versions,
   rebuilt-prg, build pipelines / patch recipes. (The code-overlay patch/validate loop is
   Spec 711 — currently a follow-on.)
5. **Release Management** — local test/QA; external tester loops; test notes, release
   candidates, known issues, final package. *Outputs:* release-ready artifact + docs.
   *Tools:* Docs/reports, audit, version "final", packaging/export.

**Disk and CRT/Cartridge are first-class expert surfaces (binding).** They carry high-value
forensic information and their information density + visual design are keepers. They belong
prominently to **Discovery and Reverse Engineering** and must remain **directly reachable**
as phase tools — never buried behind a dashboard or a low-priority "more tools" menu. They
may be repositioned/contextualized as phase surfaces, but not demoted or replaced.

**How the existing pipelines nest (reconciles §5):** the lifecycle is the top human/project
axis. The existing **7-phase per-artifact analysis pipeline** (`docs/re-phases.md`) lives
*inside* it — analysis phases 1-2 (extraction, loader) under **Discovery**, phases 3-7
(disasm → segment → semantic V1 → meta → semantic V2) under **Reverse Engineering**. The
project-service **workflow-state phases** (`docs/workflow.md`, `defaultWorkflowPhases`) are
the persisted substrate; the deterministic **step orchestrator** (`workflow-model.ts`) steps
are tagged with their lifecycle stage. No engine is rebuilt; the lifecycle is a thin top
axis + crosswalk (see `specs/773-workflow-cockpit-lifecycle.md`).

**Navigation, not a hard gate.** The UI lets the human move freely across phases; a derived
badge marks the recommended/current phase from workflow state. Per-artifact phase gating
(Model A) stays as the RE-internal discipline; the lifecycle itself is not gated.

## 3. Binding Product Decisions

**Leitregel: Capability → TRX64, Meaning/Memory → C64RE.** TRX64 is the strategic runtime base and the default backend process (the Rust daemon, auto-discovered/spawned) — it produces bytes, events and machine-state and owns runtime, instrument, reverse-debug, trace, checkpoints (`.c64re`/`.c64retrace`), daemon/FFI/CLI. C64RE is the reverse-engineering workbench — project knowledge, method/memory, analysis pipeline, semantic disassembly, findings/entities/questions, UI/orchestration, curation — it turns those bytes/events/state into knowledge. The TypeScript runtime in C64RE is a fallback / parity oracle, not the strategic base. Endstate: two MCP servers — `trx64-mcp` (instrument/runtime) and `c64re-mcp` (workbench/knowledge); today's C64RE `runtime_*` tools are a transition/proxy to the TRX64 backend, not their permanent home.

### 3.1 The Project Is the Persistent Authority

Chat context is not the project database. All durable progress belongs in the
active C64RE project:

- source media and extracted artifacts;
- trace stores, screenshots, checkpoints, and evidence records;
- entities, findings, relations, flows, tasks, and open questions;
- disassemblies, annotations, build outputs, and intervention recipes;
- rendered view models for the human UI.

The existing `ProjectKnowledgeService` is the storage/service authority. No UI
or runtime feature may create a second competing knowledge store.

### 3.2 The Agent Always Leads With Workflow State and Next Action

The MCP is not a bag of unrelated tools. Agent sessions must follow the
agentic contract:

- enter a project through `agent_onboard`;
- initialize through `project_init` when necessary;
- select an explicit workflow/role appropriate to the user's objective;
- use `agent_propose_next` and phase status to guide work;
- persist results rather than leaving them in chat output;
- end a substantive step with `agent_record_step` and a proposed next action.

BMAD-style installed flows may be introduced, but they must compile onto this
same project state, knowledge model, and next-action contract rather than
forming a parallel orchestration system.

### 3.3 Runtime Evidence Is Not Only Post-Analysis Confirmation

For a crack, port, loader, cartridge, or copy-protection project, early runtime
observation is part of discovery. It may precede full disassembly because it
reveals:

- which payloads actually execute;
- how loading changes from KERNAL to custom protocol;
- which banks/medium regions participate;
- when protection paths run;
- which visible states matter to the user.

The workflow must therefore permit an early runtime/loader capture after initial
media inventory, especially for `cracker-only` and port workflows. **The LLM can
start a live trace itself via `runtime_trace_start` on a running session** (promoted
to the default tool surface, Spec 746 — no cold-boot, same shared session the human
drives), so the agent begins capture without manual UI intervention. Runtime may
also be used later to confirm or refine semantic conclusions.

### 3.4 The Binary `.c64retrace` Is the Trace Authority; DuckDB Is a Rebuildable Index

C64RE deliberately supports retained full or high-volume runtime traces. A full
trace is not an accidental debug log; it is a source artifact that enables later
questions which were not known at capture time. The **binary append-only log
(`.c64retrace`, Spec 726.B)** is the authoritative timeline; **DuckDB is a
rebuildable query index** derived from it (Spec 746.x), not the authority.

Rules:

- a retained runtime run is linked to media, checkpoint/experiment, trace
  definition, cycle range, and marks;
- the `.c64retrace` binary log (FileHeader + Event*, cycle=f64) is the immutable
  timeline authority + source artifact; the `trace.duckdb` index is a queryable
  projection built FROM it after stop on a worker thread (stop returns instantly,
  ~12 ms; readers `awaitIndex` before querying; a missing index is lazy-rebuilt on
  read, streaming + >2 GiB-safe);
- raw trace data remains queryable in DuckDB and may be exported/retained as a
  project artifact;
- rollups, anchors, evidence bundles, and views are derived for efficient human
  and LLM consumption;
- the UI must query bounded slices/aggregations rather than repeatedly reading a
  complete raw trace;
- focused traces remain valid when the question is already narrow, but do not
  replace the ability to retain a full exploratory run.

Spec 708's corrective work must make its declarative capture surface honest:
unsupported trigger/capture/policy semantics must be implemented or rejected,
never silently accepted.

### 3.5 Runtime-Informed Semantic Disassembly Is the Goal

Static analysis identifies likely code and data. Runtime evidence establishes
which code actually participates, in which order, with which data and device
effects. The semantic pipeline must combine both:

```text
media/extraction
  -> structural disassembly
  -> runtime trace/evidence
  -> mechanical runtime-derived findings
  -> LLM evidence bundle per routine/flow
  -> annotated, connected, rebuild-verified source
```

Spec 721 is the implementation direction for this link. Runtime-derived
annotations must cite retained trace/evidence references; they must not be
unverifiable prose.

### 3.6 There Is One Human Workbench

The target user experience is one C64RE workbench UI over a single TRX64 runtime
backend — one product from the user's side. TRX64 owns the runtime; C64RE owns
knowledge, semantics, and orchestration.

The workbench contains coordinated views for:

- project/dashboard and workflow state;
- media, extracted payloads, medium layout, and loader flow;
- live runtime screen/audio/control;
- monitor/debugger and trace controls;
- annotated disassembly beside live/current execution;
- frozen visual inspect and promoted evidence;
- snapshots, rewind/replay, and intervention branches.

Different backend transports are appropriate:

- HTTP/API or service calls for project/knowledge persistence and stable views;
- WebSocket/binary streams for live frames, audio, monitor events, runtime
  commands, and inspect responses;
- DuckDB query APIs for retained traces.

These transports serve one UI and one project model. The WebSocket runtime
server is not a second knowledge owner; promoted runtime evidence is persisted
through the existing project knowledge authority.

## 4. Workbench Interaction Model

### 4.1 Live Runtime

The screen is the primary live-machine view. It includes media state, machine
controls, runtime status, audio, monitor access, and trace status. The backend
(TRX64 by default) owns emulator timing; the browser controls and visualizes it.

### 4.2 Monitor and Disassembly

When execution is paused or stopped, the user must be able to see:

- live/register/memory/drive state in the monitor;
- the corresponding annotated disassembly location;
- available trace evidence or findings for that location;
- actions to inspect, bookmark, annotate, branch, or resume.

Monitor and annotated source are not separate workflows; they are two views of
the same runtime/project state.

### 4.3 Frozen Visual Inspect

On a paused checkpoint, the C64 screen becomes an evidence surface. Selecting
visual content resolves to runtime/checkpoint evidence and may be promoted into
project knowledge.

Spec 710 currently provides:

- exact text/charset and bitmap/multicolor cell evidence;
- durable per-raster-line base provenance for supported raster/FLI cases;
- honest `sprite_bounds` evidence, with pixel-exact sprite priority/transparency
  deferred.

Promoted inspect evidence must land in the same `ProjectKnowledgeService`
project as extraction/disassembly findings, not in a temporary parallel store.

### 4.4 Trace Exploration

The UI must eventually provide DuckDB-backed timeline/swimlane exploration:

- overview/rollups for long retained runs;
- bounded instruction/event slices;
- filters for PC, address, device, cycle range, and event family;
- marks/bookmarks linked to inspect, monitor, and semantic findings;
- jumps between a trace event, a runtime checkpoint, and the relevant
  disassembly/knowledge item.

### 4.5 Intervention, Rewind, and Replay

Code/data/media interventions branch from a named retained checkpoint/evidence
root. Rewind and replay operate on the same checkpoint, input-event, trace, and
knowledge model; they must not become a separate timeline feature disconnected
from findings or disassembly.

## 5. Workflow Alignment

Two existing workflow descriptions must be reconciled under this contract:

- `docs/re-phases.md` correctly permits runtime/loader investigation in Phase 2
  for media-driven analysis.
- The project-service default phase plan currently models runtime capture after
  semantic refinement, which is appropriate only as a late confirming pass, not
  as the sole runtime entry point for crack/port work.

Required alignment:

- `cracker-only` and cartridge/loader/port workflows include early retained
  runtime capture after input registration and initial extraction;
- general static-first analysis may retain later runtime confirmation as a valid
  path;
- all modes converge on runtime-informed semantic output and persisted views.

## 6. Existing Implementation Map

| Product concern | Current authority / implementation direction |
|---|---|
| Project knowledge and artifacts | `src/project-knowledge/**`, `docs/workflow.md` |
| Agent onboarding / next action | `src/server-tools/agent-workflow.ts`, `docs/agent-doctrine.md` |
| Workflow roles / cracker mode | `src/agent-orchestrator/workflows.ts`, `docs/re-phases.md` |
| Native checkpoint / evidence base | Spec 705, Specs 707/709/714 |
| Declarative retained traces / DuckDB | Spec 708, `src/runtime/trace-store/**` |
| Frozen visual inspect | Spec 710 |
| Code/data intervention branches | Spec 711 |
| Rewind/replay/branch diff | Spec 712 |
| Runtime-informed semantic annotations | Specs 720-721 |
| Current UI direction requiring unification | README architecture and archived UX Specs 350/354/355 |

## 7. Immediate Consequences for Active Work

### 7.1 Spec 710 UI Integration

The Frozen Inspect UI is useful and should proceed, but it must be implemented
as a workbench capability:

- use the completed checkpoint-bound inspect backend;
- display honest `sprite_bounds` semantics;
- persist promoted evidence through the existing project knowledge service/API;
- avoid adding a second evidence inbox or knowledge database;
- leave an integration path for monitor, disassembly, trace marks, and rewind.

### 7.2 Unified UI Refinement

Before building many independent panels, write/refine the unified workbench UX
against this document. It should supersede the product split implied by
archived UX drafts and settle:

- navigation and layout for project/runtime/disassembly/trace views;
- active project context and service boundaries;
- shared selection/evidence navigation;
- the UI route from live observation to persisted finding/annotation/branch.

### 7.3 Semantic Pipeline Refinement

Spec 721 should be completed alongside, not after, all UI feature work. The UI
is most valuable when it can show real annotated code and trace-derived
relationships; the pipeline is most useful when its evidence can be inspected
and corrected in the workbench.

## 8. Supersession and Non-Authority

This document is the product-level authority for the intended user journey and
integration direction. It does not replace detailed fidelity or implementation
specs.

Where older or archived UX material implies:

- two independent visible products;
- UI-owned inference instead of persisted project evidence;
- runtime only after semantic analysis;
- ad-hoc trace output instead of retained DuckDB evidence;

that implication is superseded by this contract.

Implementation specs remain authoritative for implemented behavior until
updated, reviewed, and merged.
