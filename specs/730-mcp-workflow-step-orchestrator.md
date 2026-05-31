# Spec 730 — MCP Workflow Step Orchestrator + Project Inventory Sync

**Status:** DONE (2026-05-31) — orchestrator + facades + recommendation rewrite +
machine-readable `agent_next_step` shipped; BUG-005 fixed and gated.  
**Owner:** MCP product workflow / project knowledge / tool surface  
**Depends on:** Specs 725, 727, 728, 729  
**Closes:** BUG-005 (fixed) + BUG-019 Part B (§7 artifact version store).  

> **DONE note (2026-05-31).** 730.1–730.6 + §7 shipped (default=99). The final
> closure slice added the machine-readable `agent_next_step` JSON block
> (`phase, step, reason, primary_action{tool,args,label}, secondary_actions[],
> blocked_by[], human_question?, ui_hint?, do_not_call[]`) so the LLM parses a
> structured callable next-action. Gates: `e2e-mcp-step-loop` 31/31,
> `e2e-mcp-no-internal-recommendations` 10/10, `e2e-mcp-project-inventory` 29/29,
> `probe-tool-surface` 23/23. Zero internal-tool leakage across onboard/audit/UI/
> playbooks (audited). Only `change-validate` remains blocked (Spec 711).

## 1. Problem

The MCP product surface still leaks internal implementation steps to the consuming
LLM. Examples seen in real project use:

- `agent_onboard`, audit output, and UI banners recommend
  `register_existing_files`, `scan_registration_delta`, or
  `import_manifest_artifact`.
- Those names are not callable from the default MCP surface.
- The LLM gets stuck: it is told what internal maintenance action is needed, but
  not given a callable product action.

This is not a request to expose every internal tool. The MCP must own the phase
and step orchestration. The LLM should execute a small set of default facade
actions.

## 2. Product Rule

The MCP tells the LLM:

```text
current phase
current step
why this step matters
which callable default tool to run
what evidence/result to save
what human input is needed, if any
```

The MCP must not tell a normal external LLM to call an internal or advanced tool.
If an internal action is needed, the MCP wraps it behind a default facade.

## 3. Non-Goals

- No `C64RE_FULL_TOOLS` workaround for normal product flow.
- No VICE fallback in the product workflow.
- No UI redesign in this spec.
- No full autonomous cracking pipeline. This spec defines the step contract and
  the first required inventory/sync facade.
- No raw SQL workaround for trace readers.

## 4. Required Default Tools

### 4.1 `agent_next_step`

Returns the next MCP-owned step for the project.

Inputs:

- `project_dir?`
- optional `context?` free text from the human/LLM

Returns:

```ts
interface AgentNextStepResult {
  project: { name: string; dir: string };
  phase: {
    id: string;
    title: string;
    status: "ready" | "blocked" | "done";
  };
  step: {
    id: string;
    title: string;
    why: string;
    defaultTool: string;
    defaultArgs: Record<string, unknown>;
    humanPrompt?: string;
    completionChecks: string[];
    expectedOutputs: string[];
  };
  doNotCall: string[];
}
```

Rules:

- `defaultTool` must be callable in the default MCP surface.
- `doNotCall` may mention internal implementation tools only as forbidden
  leakage, not as suggested actions.
- If the project cannot continue without a human-supplied file or decision, the
  step is `blocked` and `humanPrompt` is concrete.

### 4.2 `agent_run_step`

Runs a step selected by `agent_next_step`.

Inputs:

- `project_dir?`
- `step_id`
- optional step-specific `args`

Returns:

```ts
interface AgentRunStepResult {
  stepId: string;
  status: "done" | "blocked" | "failed";
  actions: { label: string; result: string }[];
  createdArtifacts: string[];
  updatedViews: string[];
  findingsToReview: string[];
  nextStepHint: string;
}
```

Rules:

- The tool may call internal maintenance functions.
- The response must summarize product concepts, not internal tool names.
- Failures must include one callable next action or one concrete human request.

### 4.3 `project_inventory_sync`

The first mandatory facade from this spec.

Use when:

- media/files are present but not registered;
- manifests exist but have not been imported;
- views are stale/missing;
- `agent_onboard` or the UI audit sees unregistered files;
- after extraction/disassembly/import steps.

Behavior:

1. Scan the project inputs and known media/artifact folders.
2. Register unregistered project files as artifacts.
3. Import disk/CRT/PRG manifests when present.
4. Rebuild project views that depend on changed inventory.
5. Report skipped files with reasons.
6. Stay idempotent: running it twice should be safe.

Expected response:

```ts
interface ProjectInventorySyncResult {
  status: "done" | "blocked" | "failed";
  registered: number;
  importedManifests: number;
  rebuiltViews: string[];
  skipped: { path: string; reason: string }[];
  remainingProblems: string[];
  nextStepHint: string;
}
```

Product copy:

```text
Run project_inventory_sync
```

Forbidden product copy:

```text
Run register_existing_files
Run scan_registration_delta
Run import_manifest_artifact
```

Internal implementation may still use those functions.

### 4.4 Disk / G64 Raw-Inspection Product Facade

The normal LLM workflow must be able to inspect real disk structure, not only DOS
directories. Copy protection, custom loaders, orphan sectors, half-tracks, and
raw GCR details are product RE work, not internal MCP development.

Current tool-surface audit (2026-05-30):

```text
disk/image/sector/track-like tools: 16
default: 3
advanced/hidden: 13
```

Already default:

- `inspect_disk`
- `extract_disk`
- `disk_sector_allocation`

Product capabilities currently hidden but required:

- `list_g64_slots`
- `inspect_g64_track`
- `inspect_g64_blocks`
- `inspect_g64_syncs`
- `scan_g64_headers`
- `read_g64_sector_candidate`
- `extract_g64_sectors`
- `extract_g64_raw_track`
- `analyze_g64_anomalies`
- `suggest_disk_lut_sector`
- `extract_disk_custom_lut`
- `set_payload_disk_hint`

`build_disk_layout_view` should remain internal and be called by
`build_all_views` / `project_inventory_sync`.

Refinement decision (2026-05-30):

Do **not** invent a new wrapper layer for Disk/G64 in the first implementation.
Promote the existing required tools directly to the default surface, rewrite
their descriptions capability-first, and gate them as product RE tools. They are
already the right capability shape for an LLM doing disk reverse engineering.

`build_disk_layout_view` remains internal.

Acceptance:

- A default LLM can inspect a G64 half-track/track and its decoded sectors.
- A default LLM can inspect raw GCR block/sync/header anomalies.
- A default LLM can extract raw sectors/tracks and custom-LUT payloads.
- A default LLM can persist disk hints that feed the UI heatmap.
- No `C64RE_FULL_TOOLS=1` is needed for normal disk RE.

### 4.5 CRT / Cartridge Extraction Product Facade

CRT extraction must follow the same rule as Disk/G64. If cartridge extraction,
chunking, bank/slot mapping, packer notes, or ASM linking are currently hidden,
they must be either promoted to default or wrapped by a default facade.

Current quick audit (2026-05-30):

```text
cart/crt/cartridge/bank/slot/chip-like tools: 10
default: 1
advanced/hidden: 9
```

Already default:

- `extract_crt`

Likely product capabilities to expose or wrap:

- `bulk_create_cart_chunk_payloads`
- `link_cart_chunk_to_asm`
- `record_cart_chunk_packer`

Internal / not normal product actions:

- `build_cartridge_layout_view` should stay internal behind `build_all_views` /
  `project_inventory_sync`.
- `vice_*` matches stay internal-dev oracle only.
- False-positive names from the audit must not be promoted just because they
  contain `cart`, `bank`, or `slot`.

Required story:

1. Audit all CRT/cartridge tools and classify them as product facade,
   internal-view-build, internal-dev-oracle, or obsolete.
2. Ensure the default LLM can inspect cartridge banks/chunks and create payloads
   from useful chunks.
3. Ensure packer/format metadata and ASM links for cart chunks are callable from
   the product workflow.
4. Ensure the UI can show the result after `project_inventory_sync` /
   `build_all_views`.

Acceptance:

- A default LLM can run `extract_crt`, then inspect/promote relevant cartridge
  chunks into payloads.
- A default LLM can link a cartridge chunk to the best ASM/TASS artifact.
- A default LLM can record packer/format notes for a cartridge chunk.
- No cartridge workflow tells the LLM to call hidden tools directly.

Refinement decision (2026-05-30):

For the first implementation, promote the existing product cartridge tools
directly where they are already usable:

- `bulk_create_cart_chunk_payloads`
- `link_cart_chunk_to_asm`
- `record_cart_chunk_packer`

Do not promote view-build internals or VICE tools. If a later audit finds a
missing cartridge capability, add a small facade then.

## 5. Step Model

The orchestrator must treat the workflow as a loop, not as a fixed waterfall.

Valid next-step families:

- project setup / onboarding
- media inventory
- extraction
- runtime trace
- static disassembly
- trace validation
- visual inspection
- raw disk / GCR inspection
- cartridge bank/chunk inspection
- semantic annotation
- change / validation (blocked until Spec 711)
- documentation / dashboard refresh

The LLM may move through these in different orders:

```text
trace -> disassemble -> change
disassemble -> change -> trace
disassemble -> trace -> refine disassembly -> change
```

The MCP chooses the next useful step from project state, not from hardcoded
spec-history.

Refinement decision (2026-05-30):

730 does not invent a new workflow. It operationalizes the existing
LLM-human-MCP-runtime swimlane as code.

Create the machine-readable workflow model close to the implementation:

```text
src/agent-orchestrator/workflow-model.ts
```

Use a small typed constant, not a JSON loader or generated framework:

```ts
export const C64RE_WORKFLOW_STEPS = [
  {
    id: "inventory-sync",
    phase: "media-inventory",
    actor: "mcp",
    defaultTool: "project_inventory_sync",
    completionChecks: ["no-unregistered-files", "views-fresh"],
    branches: ["static-analyze", "runtime-trace", "ask-human"],
  },
] as const;
```

`agent_next_step` must use this model as the source for:

- step IDs;
- phase IDs;
- callable tool names;
- branch IDs;
- completion checks.

Only the explanation (`why`), counts, concrete file paths, and human prompts are
computed dynamically from project state.

### 5.1 MVP Workflow Steps

The 730 MVP workflow model must include these product swimlane steps:

| Step | Purpose | Primary tool / action |
|---|---|---|
| `project-init` | Initialize a C64RE project. | `project_init` |
| `inventory-sync` | Register/import/rebuild/version project state. | `project_inventory_sync` |
| `media-inspect` | Inspect known media before extraction. | `inspect_disk` / `extract_crt` metadata path |
| `media-extract` | Extract DOS files / CRT banks / basic payloads. | `extract_disk` / `extract_crt` |
| `disk-raw-inspect` | Inspect raw G64/disk structure when directory is not enough. | G64/raw disk tools |
| `cart-chunk-inspect` | Promote/inspect cartridge bank chunks. | cart chunk tools |
| `static-analyze` | Produce structural PRG analysis. | `analyze_prg` |
| `static-disassemble` | Produce ASM/TASS source. | `disasm_prg` / `disasm_menu` |
| `semantic-annotate` | Add semantic labels/comments/segment knowledge. | `propose_annotations` + human/LLM review |
| `runtime-trace` | Run Headless and capture trace/marks/screens. | `runtime_session_start` + trace tools |
| `trace-query` | Query traces for executed code/data/loader facts. | trace reader tools |
| `visual-inspect` | Resolve screen pixels/assets to runtime/VIC evidence. | `runtime_vic_inspect_at` |
| `record-knowledge` | Persist findings/entities/relations. | `save_finding`, `save_entity`, link tools |
| `ask-human` | Ask the cracker/operator for a decision. | human prompt |
| `change-validate` | Patch/change/validate loop. | blocked until Spec 711 |

Steps are product phases, not one-to-one wrappers for every MCP tool.

### 5.2 Step Selection Priority

`agent_next_step` must use simple deterministic priority, not hidden LLM magic:

1. Project missing -> `project-init`.
2. Inventory dirty -> `inventory-sync`.
3. Media present but not extracted -> `media-inspect` / `media-extract`.
4. G64, sparse directory, high occupancy, or protection signs -> branch
   `disk-raw-inspect`.
5. CRT/cart with bank/chunk data -> branch `cart-chunk-inspect`.
6. Payloads without analysis -> `static-analyze`.
7. Analysis without source -> `static-disassemble`.
8. Source without semantic annotations -> `semantic-annotate`.
9. Runtime questions or unknown loader behavior -> branch `runtime-trace`.
10. Trace exists but is not mined -> `trace-query`.
11. Visual evidence needed -> `visual-inspect`.
12. Unsaved facts -> `record-knowledge`.
13. Human decision needed -> `ask-human`.
14. Patch/change request -> `change-validate` (blocked until Spec 711).

`inventory-sync` outranks almost everything. Do not run analysis against stale
views or unregistered files.

### 5.3 `agent_next_step` Output Shape

When multiple paths are useful, return one primary action plus explicit branches:

```ts
interface AgentStepSuggestion {
  stepId: string;
  phase: string;
  tool?: string;
  args?: Record<string, unknown>;
  label: string;
  why: string;
  completionChecks: string[];
}

interface AgentNextStepResult {
  project: { name: string; dir: string };
  primary: AgentStepSuggestion;
  branches: AgentStepSuggestion[];
  blockedBy: Array<{
    id: string;
    prompt: string;
    choices?: string[];
  }>;
  doNotCall: string[];
}
```

Rules:

- `primary` is the safest next action.
- `branches` are valid iterative swimlane alternatives, not random suggestions.
- `blockedBy` is only for real human decisions.
- Every `tool` must be callable in the default surface.
- A branch may be human-only (`ask-human`) and then has no tool.

## 6. End-of-Step Hygiene

Every workflow step must finish by checking:

- unregistered project files;
- unimported manifests;
- stale/missing views;
- missing required JSON sidecars;
- open questions created by the step;
- findings/entities created by the step;
- trace/store artifacts that should be registered or referenced.

If hygiene is not clean, the next step should normally be
`project_inventory_sync` or a concrete human input request.

## 7. Artifact Version / Visibility Rule

`project_inventory_sync` must make user-created and generated artifacts visible
to the product UI and MCP. This closes the class of BUG-019 issues where a
better hand-made/semantic file exists on disk but is invisible to the artifact
resolver.

Required inventory patterns:

- project input media: `.d64`, `.g64`, `.crt`, `.prg`;
- extracted payloads and raw sectors;
- analysis sidecars: `*_analysis.json`, `*_annotations.json`, manifests;
- generated source: `*_disasm.asm`, `*_disasm.tass`;
- semantic / hand-curated source: `.asm`, `.tass`, `.sym`, `.md` under analysis
  folders that are not already registered.

Version preference rule for source artifacts:

1. final/curated semantic source;
2. semantic `.tass` / `.asm`;
3. registered hand-made source with unknown role;
4. generated `_disasm.*`.

The UI may expose old versions, but the default action must use the current best
artifact.

This is MVP product behavior, not a PoC. It is accepted only when:

1. The UI clearly shows the current version for the selected payload/artifact.
2. The UI lists all known versions in the Inspector.
3. The user can set a version as current from the UI.
4. That decision persists in the project knowledge store.
5. `project_inventory_sync` respects manual current decisions.
6. Conflicts are visible as `needs decision` / open question, not silently
   guessed.
7. Disk Inspector, Payloads, Annotated Listing, and ASM overlay use the same
   resolver.

### 7.1 Artifact Version Store

Persist version state as small metadata records in the project knowledge store.
Do not put file contents into the record.

Minimal shape:

```ts
interface ArtifactVersionGroup {
  id: string;
  subjectId: string; // payload/entity/artifact this group describes
  currentArtifactId: string;
  currentSource: "auto" | "manual";
  needsDecision?: boolean;
  versions: Array<{
    artifactId: string;
    role: "generated" | "semantic" | "manual" | "curated" | "final" | "related";
    format: "kickass" | "64tass" | "markdown" | "json" | "sym" | "other";
    rank: number;
    status: "current" | "available" | "stale" | "missing";
  }>;
}
```

Required operations:

- list versions for one subject;
- get current artifact for one subject/purpose;
- set current artifact manually;
- mark version stale/missing.

These operations must be targeted. No tool should dump every version of every
artifact into the LLM context.

### 7.2 Current-Version UI

Show versions in the existing Inspector, not a new global tab.

For a selected payload/artifact, the Inspector should show:

```text
Source / Versions

Current
  02_2.0_semantic.tass   64tass   semantic   current

Other versions
  02_2.0_disasm.asm      kickass   generated
  02_2.0_disasm.tass     64tass   generated
  02_2.0_notes.md        docs      related
```

Required actions:

- `open`
- `make current`
- `mark stale`

Optional later:

- compare/diff;
- branch history;
- code overlay integration.

Overlay headers may show:

```text
2.0 · current: 02_2.0_semantic.tass · 64tass · versions ▾
```

### 7.3 Sync Rules For Versions

`project_inventory_sync` creates or updates version groups conservatively.

It may automatically set current when the rule is unambiguous:

```text
final > curated > semantic > manual/unknown > generated > stale
```

`mtime` is only a tie-breaker within the same rank.

It must not overwrite a manual current choice.

If two candidates have equivalent rank, create or update an open question /
`needsDecision` marker instead of guessing.

It must not delete, rename, or move files.

## 8. Recommendation Contract

All of these surfaces must obey the same recommendation rule:

- `agent_onboard`
- `agent_next_step`
- project audit
- UI warning banners
- generated playbooks
- dashboard current-focus text

They may recommend only:

1. callable default tools;
2. explicit human actions, such as "copy the `.g64` into `input/disk/`";
3. internal-dev tools only when clearly labeled unavailable to normal product
   workflow and paired with a default facade.

If the output names an internal tool as the next normal action, this spec fails.

## 9. Path-Portability Rule

All orchestrator tools must work when the MCP is invoked from any directory.

Inputs may be:

- absolute paths;
- project-relative paths;
- user-provided media files outside the C64RE repo.

No default workflow may silently fall back to repo `samples/`.

`project_inventory_sync` must not move or copy files. File movement belongs to
`project_init` / explicit media ingress. Sync may register files where they are
and may report `suggestedMove`, but it must not rewrite project layout silently.

`project_inventory_sync` always performs a full view rebuild in the MVP. Project
sizes are expected to be small enough that correctness is more important than
incremental invalidation. It must report what was rebuilt and what changed.

## 10. Acceptance Scenarios

### A — Fresh Project With Media

1. Create a project outside the C64RE repo.
2. Put `.d64`, `.g64`, `.crt`, and `.prg` files under the project.
3. Call `agent_onboard`.
4. Call `agent_next_step`.
5. The next step is inventory/media sync, using only a callable default tool.
6. Call `project_inventory_sync`.
7. Views/dashboard are rebuilt.
8. No output tells the LLM to call an unexposed internal tool.

### B — Dirty Inventory After Extraction

1. Run extraction/disassembly that creates manifests or sidecars.
2. Call `agent_next_step`.
3. The MCP sees stale/missing views or unimported manifests.
4. The next action is `project_inventory_sync`.
5. Running it twice is safe and converges.

### C — UI Banner

When the UI detects unregistered files, its banner must say the product action:

```text
Run project_inventory_sync
```

It must not display internal tool names as the action.

### D — No Workaround Surface

Repeat the gates without `C64RE_FULL_TOOLS=1`.

The default LLM must succeed through facade tools only.

### E — Disk Raw Inspection

1. Use a `.g64` project disk with sparse directory entries and occupied raw
   tracks/sectors.
2. From the default MCP surface, inspect G64 slots/tracks/blocks/headers.
3. Extract at least one raw sector or raw track.
4. Persist a disk hint or finding from that inspection.
5. Rebuild/sync views so the UI can surface the finding.

### F — Cartridge Chunk Inspection

1. Use a `.crt` project cartridge with bank/chunk structure.
2. From the default MCP surface, extract the CRT and inspect/promote useful
   chunks.
3. Link one chunk to an ASM/TASS artifact or record that no artifact exists yet.
4. Record packer/format metadata for one chunk when known.
5. Rebuild/sync views so the UI can surface the cartridge chunk state.

## 11. Gates

Add or extend product-surface gates:

- `probe-tool-surface`: `agent_next_step`, `agent_run_step`, and
  `project_inventory_sync` are default; internal inventory tools stay advanced or
  private.
- `e2e-mcp-project-inventory`: fresh external project can run
  `project_init -> agent_onboard -> agent_next_step ->
  project_inventory_sync -> build_project_dashboard`.
- `e2e-mcp-no-internal-recommendations`: scan default tool descriptions,
  playbooks, onboarding output, audit output, and UI banner strings for forbidden
  internal tool names as recommended actions.
- `e2e-mcp-step-loop`: after sync, `agent_next_step` advances to a useful next
  phase rather than repeating stale inventory work.
- `e2e-mcp-disk-raw-default`: default surface can perform the Disk Raw
  Inspection scenario above, with no hidden tool recommendation.
- `e2e-mcp-crt-chunk-default`: default surface can perform the Cartridge Chunk
  Inspection scenario above, with no hidden tool recommendation.
- `e2e-mcp-artifact-best-version`: a project with both
  `*_disasm.asm` and `*_semantic.tass` resolves the UI/default ASM action to the
  semantic/current artifact; unregistered hand-made source becomes visible after
  `project_inventory_sync`.

No runtime proof is required unless runtime behavior changes.

## 12. Implementation Slices

### 730.1 — Default Surface Exposure For Required Disk/CRT Tools

Change `tier-tools.ts` so these tools are default:

- Disk/G64:
  - `list_g64_slots`
  - `inspect_g64_track`
  - `inspect_g64_blocks`
  - `inspect_g64_syncs`
  - `scan_g64_headers`
  - `read_g64_sector_candidate`
  - `extract_g64_sectors`
  - `extract_g64_raw_track`
  - `analyze_g64_anomalies`
  - `suggest_disk_lut_sector`
  - `extract_disk_custom_lut`
  - `set_payload_disk_hint`
- Cartridge:
  - `bulk_create_cart_chunk_payloads`
  - `link_cart_chunk_to_asm`
  - `record_cart_chunk_packer`

Do not promote:

- `build_disk_layout_view`
- `build_cartridge_layout_view`
- `vice_*`

Gates:

- `npm run build:mcp`
- `node scripts/probe-tool-surface.mjs`

### 730.2 — Capability-First Descriptions

Rewrite descriptions for the promoted tools so a fresh LLM knows when to use
them. Descriptions must include:

- normal use case;
- when not to use it;
- expected input path style;
- what artifact/finding/view it affects, if any.

No Spec numbers in product descriptions. No VICE references.

Gate:

- `probe-tool-surface` must assert no promoted tool description starts with
  "Spec" or points to `C64RE_FULL_TOOLS`.

### 730.3 — `project_inventory_sync`

Implement the default facade.

It must internally handle:

- file registration;
- manifest import;
- view rebuild;
- generated and hand-curated source visibility;
- stale-view status;
- idempotent repeat runs.

It may call existing internal helpers. Its output must not leak internal helper
names as required user actions.

Gates:

- external temp project with media and unregistered generated files;
- run `project_inventory_sync` once: files registered, manifests imported, views
  rebuilt;
- run it twice: no duplicate artifacts and no failure;
- project with `*_disasm.asm` + `*_semantic.tass`: semantic source wins as best
  artifact.

### 730.4 — `agent_next_step` And Minimal `agent_run_step` — DONE

Implement:

- `agent_next_step`
- `agent_run_step` for at least the inventory/media-sync step

The first real decision tree:

1. project not initialized -> `project_init`;
2. unregistered files / unimported manifests / stale views -> `project_inventory_sync`;
3. media present but not extracted -> `inspect_disk` / `extract_disk` /
   `extract_crt`;
4. extracted payloads without analysis -> `analyze_prg`;
5. analysis without disassembly -> `disasm_prg`;
6. otherwise propose trace/static/visual next action based on open questions and
   findings.

Gate:

- fresh project outside repo walks from init to inventory to next useful action
  without internal tool names.

### 730.5 — Replace Product Recommendations

Replace recommendation strings in:

- `agent_onboard`;
- project audit;
- UI warning banners;
- playbooks/docs used by external LLMs;
- dashboard current-focus text.

Forbidden as normal next-action text:

- `register_existing_files`
- `scan_registration_delta`
- `import_manifest_artifact`
- `build_disk_layout_view`
- `build_cartridge_layout_view`

Gate:

- grep/static probe over product descriptions, UI banner strings, playbooks, and
  onboard/audit fixture output.

### 730.6 — E2E Product Workflow Gates

Add:

- `e2e-mcp-project-inventory`
- `e2e-mcp-no-internal-recommendations`
- `e2e-mcp-step-loop`
- `e2e-mcp-disk-raw-default`
- `e2e-mcp-crt-chunk-default`
- `e2e-mcp-artifact-best-version`

Run:

```text
npm run build:mcp
npm run check:mcp-product-surface
```

No runtime proof unless runtime code changed.

## 13. Migration Plan

1. 730.1 + 730.2: expose required Disk/CRT tools and fix descriptions.
2. 730.3: implement `project_inventory_sync`.
3. 730.4: implement `agent_next_step` + minimal `agent_run_step`.
4. 730.5: replace all product recommendations.
5. 730.6: add and run E2E gates.
6. Mark BUG-005 fixed only after the real DDD/Wasteland-style workflow no longer
   exposes internal tool names.

## 14. Bug Link

This spec is the resolution plan for:

- `bugs/BUG-005-unexposed-tools-recommended-by-agent-audit.md`
