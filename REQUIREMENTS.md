# C64ReverseEngineeringMCP — Requirements / Refinement Backlog

Captured while reverse-engineering Murder on the Mississippi (Activision 1986).
Project root: `/Users/alex/Development/C64/Cracking/Murder`.

These are *enhancements* — not bug fixes. Bugs live in [`BUGREPORT.md`](./BUGREPORT.md).

Severity / Priority labels: **Critical** (blocks productive RE), **High** (frequent friction), **Medium** (nice-to-have), **Low** (polish).

---

## R1 — Per-file workflow status badge in UI

**Priority**: High

**Problem**: Today the workflow phases are global (workspace-init, input-registration, deterministic-extraction, structural-enrichment, semantic-enrichment, …). A phase flips to `completed` as soon as **any one** PRG has been processed. There is no per-PRG view of what has been done and what is pending.

**Want**: For each registered PRG (and other input artifact), show a status badge:

| Step | Tool | Done? |
|------|------|-------|
| 1. Heuristic analysis | `analyze_prg` | ✓ |
| 2. First-pass disasm | `disasm_prg` (no annotations) | ✓ |
| 3. Annotations file | manual: write `*_annotations.json` | ⨯ |
| 4. Annotated disasm | `disasm_prg` with annotations | ⨯ |
| 5. RAM facts report | `ram_report` | ⨯ |
| 6. Pointer report | `pointer_report` | ⨯ |
| 7. Findings linked | at least 1 `save_finding` referencing the artifact | ✓ |

Click a badge → jump to that artifact's open-questions, segments, evidence.

**Implementation hint**: server endpoint `/api/per-artifact-status` walks artifacts.json + analysis-runs + listings and returns the matrix.

---

## R2 — Per-artifact platform marker

**Priority**: High (closely tied to Bug 12)

**Problem**: Disasm assumes C64. Drive code (1541 6502), C128, VIC-20, plus-4 etc. need different annotation tables.

**Want**:
- New artifact metadata field `platform: c64 | 1541 | c128 | vic20 | plus4 | other`
- Default = `c64` for backwards compat
- `analyze_prg` / `disasm_prg` accept `platform` argument
- Annotation tables in `src/platform-knowledge/{platform}.ts`:
  - I/O register names + bit-fields
  - ZP RAM-fact lookups
  - ROM routine names ($A47C = `dos_search_header` for 1541, $FFD2 = `CHROUT` for C64)
- UI badges artifacts with platform tag.

---

## R3 — Auto-`bulk_import_analysis_reports` after analyze_prg / agent_onboard

**Priority**: Medium (related to Bug 16)

**Problem**: User has to manually call `bulk_import_analysis_reports` when the dashboard warns about unimported runs.

**Want**: `agent_onboard` and `project_audit` auto-import any analysis-run artifact whose `imported: false` flag is set. No manual step.

---

## R4 — Default glob set for `register_existing_files`

**Priority**: Medium

**Problem**: After running c64re tools, many output files are not in `artifacts.json` because the agent has to enumerate every output extension manually:

```
analysis/disk/motm/raw_sectors/**/*.bin   (raw sectors)
analysis/disk/motm/raw_sectors/**/track-metadata.json
analysis/disk/motm/raw_sectors/*.prg      (drive PRG wrappers)
analysis/disk/motm/raw_sectors/*_analysis.json
analysis/disk/motm/raw_sectors/*_disasm.asm
analysis/disk/motm/*_analysis.json
analysis/disk/motm/*_disasm.asm
analysis/disk/motm/*.tass
analysis/disk/motm/manifest.json
…
```

**Want**: `register_existing_files` with no `patterns` argument runs a built-in default glob set covering all c64re-produced extensions and assigning the canonical `kind`/`scope`/`role` for each:

| Glob | kind | scope | role |
|------|------|-------|------|
| `input/disk/*.{d64,g64}` | d64 / g64 | input | source-disk |
| `input/cart/*.crt` | crt | input | source-cart |
| `input/prg/*.prg` | prg | input | source-prg |
| `analysis/disk/*/manifest.json` | manifest | analysis | disk-manifest |
| `analysis/disk/**/*_analysis.json` | analysis-run | analysis | prg-analysis |
| `analysis/disk/**/*_disasm.asm` | listing | analysis | disasm |
| `analysis/disk/**/*_disasm.tass` | generated-source | generated | disasm-tass |
| `analysis/disk/**/raw_sectors/**/*.bin` | raw | analysis | raw-sector |
| `analysis/runtime/**/session.json` | checkpoint | session | vice-session |
| `analysis/runtime/**/trace/summary.json` | report | session | trace-summary |
| `analysis/runtime/**/trace/trace-analysis.json` | report | session | trace-analysis |
| `analysis/runtime/**/trace/events.jsonl` | trace | session | trace-events |
| `views/*.json` | view-model | view | (auto from filename) |
| `docs/**/*.md` | other | knowledge | doc |

Agent calls `register_existing_files()` with no args → full sync.

---

## R5 — Per-file phase plan / sub-phases

**Priority**: Medium

**Problem**: Workflow phases (`structural-enrichment`, `semantic-enrichment`, `view-build`, …) are project-global. Unclear when a phase is "done" — does it mean every PRG is annotated, or just one?

**Want**: Each phase that operates on PRGs / artifacts has a sub-phase list:

```yaml
structural-enrichment:
  per_artifact:
    - artifact_id: prg-01-murder
      analyze: done
      disasm-pass1: done
      annotations: pending
      disasm-pass2: pending
    - artifact_id: prg-02-ab
      …
```

Phase status = aggregate (all done? then phase done; some done? in_progress; none? ready).

Surfaced as part of `agent_onboard` and dashboard.

---

## R6 — Open-question source tagging

**Priority**: Medium

**Problem**: Open questions saved by `analyze_prg` (heuristic Phase-1 ambiguities, e.g. "ranges $XXXX-$YYYY classification uncertain") mix with questions saved by humans / runtime observation. Cannot filter "what's left after Phase-1 noise vs. genuinely open research questions."

**Want**: New field `source: "heuristic-phase1" | "human-review" | "runtime-observation" | "other"` on every open question. Default for tool-generated = `heuristic-phase1`. UI filterable.

Bonus: status `auto-resolvable` for questions that the next disasm-pass-2 should answer; flag them for the agent to revisit during annotation.

---

## R7 — Disk-layout view with sector status

**Priority**: Medium

**Problem**: Disk-layout view shows files (BAM-derived) but does not show:
- Which raw sectors have been extracted (T1/S0, T14/S0..S20, T15/S0..S20, …)
- Which sectors are linked to PRG artifacts (file → T/S map from manifest)
- Protection-related sectors (bad-sector mask, sync-only, off-track, fill patterns)

**Want**: Cylindrical 2D heatmap (track × sector) with cell colors:
- green: valid data, linked to a registered file
- yellow: valid data, no link (gap)
- red: bad data (CRC fail, protection)
- gray: missing / no header
- blue: raw-extracted but unanalyzed
- purple: drive code (T1/S0 stage-1 etc.)

Click a cell → links to raw-sector artifact (if extracted) and parent PRG (if linked).

---

## R8 — Memory-map view with multi-context load destinations

**Priority**: High

**Problem**: A custom fastloader can load the same disk file to a different runtime address than the PRG header says. Or load multiple files into overlapping ranges (KERNAL replacement at $E000 is a classic). Today's memory-map view shows one address per file, picked from the PRG header.

**Want**: Memory-map supports multiple "load contexts" per artifact:
- "as-stored" (PRG header load addr)
- "runtime" (custom fastloader dest, taken from cmd-code table)
- "after-decompression" (if file is packed)

UI toggle to switch context. Agent can declare contexts via `save_artifact` evidence or via a new `register_load_context(artifact_id, runtime_address)` tool.

Memory-map highlights overlaps (multiple files mapped to the same range under different contexts).

---

## R9 — `NEXT.md` items propagate to a TaskList

**Priority**: Medium

**Problem**: `analyze_prg` and `disasm_prg` print "NEXT STEP: read the full ASM, then create *_annotations.json". This text goes into NEXT.md and the agent's console output. It does NOT become a tracked task — so on session resume, the agent has to re-read NEXT.md and remember.

**Want**: Tools that emit a "NEXT STEP" hint also call `save_task` automatically:

```
save_task(
  kind="annotation",
  title="Annotate 11_riv1.prg",
  description="Read /abs/path/11_riv1_disasm.asm, write 11_riv1_disasm_annotations.json with reclassifications + semantic labels + routine docs, then re-run disasm_prg with annotations.",
  artifact_ids=[<analysis-run-id>],
  status="ready"
)
```

`agent_onboard` lists ready tasks. Closes auto when annotations file exists + disasm pass-2 completed.

---

## R10 — Generated-docs pipeline (Findings → Markdown)

**Priority**: High (related to Bug 15)

**Problem**: Findings, open questions, entities, flows, relations live in `knowledge/*.json`. UI Docs-tab renders only Markdown. Result: rich knowledge layer is invisible.

**Want**: A renderer that produces and keeps in sync:

| Source | Generated doc |
|--------|---------------|
| `knowledge/findings/*.json` | `docs/FINDINGS.md` (grouped by tag/topic) |
| `knowledge/questions/*.json` | `docs/OPEN_QUESTIONS.md` (grouped by priority) |
| `knowledge/entities/*.json` | `docs/ENTITIES.md` (grouped by kind) |
| `knowledge/flows/*.json` | `docs/FLOWS.md` |
| `views/memory-map.json` | `docs/MEMORY_MAP.md` |
| `views/disk-layout.json` | `docs/DISK_LAYOUT.md` |
| `views/cartridge-layout.json` | `docs/CARTRIDGE_LAYOUT.md` |
| `views/load-sequence.json` | `docs/LOAD_SEQUENCE.md` |
| `knowledge/phase-plan.json` + workflow-state | `docs/PROJECT_STATUS.md` |

Triggered by:
- `save_finding` / `save_open_question` / `save_entity` / etc. (incremental rebuild)
- `build_all_views` (full rebuild)
- New tool `render_docs(project_dir)` for explicit invocation

These auto-generated docs are tagged `produced_by_tool: "render_docs"` so the agent doesn't try to edit them by hand.

---

## R11 — Doctrine hints in tool descriptions

**Priority**: Low (related to Bug 15 / Bug 4)

**Problem**: An LLM agent reading `save_finding` description has no way to know that the finding will be JSON-only and invisible to the user. Same for `save_entity`, `save_flow`, etc.

**Want**: Each `save_*` tool description carries a one-line doctrine hint:

```
save_finding: "...Persists structured semantic finding... Note: findings render in
the UI Findings tab (R12) once that ships. Until then, also call render_docs or
save_artifact(kind=other, scope=knowledge, format=md) for human-readable summaries."
```

Cheaper than R10 short-term, complements R10 long-term.

---

## R12 — Dedicated UI panels for Findings / Questions / Entities / Flows

**Priority**: High (the right long-term answer to Bug 15 + R10)

**Problem**: UI has tabs for Memory-Map, Disk-Layout, Cart-Layout, Load-Sequence, Flow-Graph, Annotated-Listing, Docs. NO tab for the structured knowledge layer that c64re uniquely produces.

**Want**: New UI tabs:
- **Findings** — sortable/filterable table: title, kind, status, confidence, tags, evidence count. Click row → detail card with body, evidence excerpts (with source-file links), linked artifacts.
- **Questions** — table: title, kind, priority, status, linked findings, source (per R6). Action button: "mark answered with finding …"
- **Entities** — table by kind (zp_pointer, sub_routine, sprite_data, dialog_string, etc.) with addresses, confidence. Cross-link to listing artifacts.
- **Flows** — sequence diagrams (loader chain, IRQ flow, save flow).
- **Relations** — graph view: artifact ↔ entity, entity ↔ entity, finding ↔ entity.

Each panel reads new server endpoints (`/api/findings`, `/api/open-questions`, `/api/entities`, `/api/flows`, `/api/relations`).

---

## R13 — Per-PRG analysis quality metrics

**Priority**: Low

**Problem**: After `analyze_prg`, the JSON has segments classified with confidence values. The agent / user has no aggregated quality score: "what % of riv2.prg is confidently classified vs. unknown?".

**Want**: Per-artifact metrics in the project-dashboard:
- bytes classified as code / data / text / sprite / unknown (% breakdown)
- average segment confidence
- count of "unknown" segments above N bytes (likely missed structures)
- ratio of named labels vs. raw `WXXXX` labels (indicates annotation maturity)

Sortable on the dashboard so the user can prioritize the lowest-quality PRGs for hand-annotation.

---

## R14 — Cross-PRG linking via runtime trace

**Priority**: Medium

**Problem**: A custom fastloader chains many PRGs; we know which command code loads which range (host-side dest table) but the link from PRG-on-disk to actual disk track/sector to runtime memory range is not first-class. After running a VICE trace, that link is observable but not persisted.

**Want**: New entity kind `load_event { source_track, source_sector, source_artifact_id, runtime_addr_start, runtime_addr_end, triggered_by_pc, captured_at }`. Trace tools auto-emit these when they observe disk reads. Memory-map and disk-layout views consume them to draw arrows from disk → memory.

---

## R15 — Annotation-helper LLM workflow

**Priority**: Medium

**Problem**: Step 3 of the per-file workflow ("write `*_annotations.json` with reclassifications + semantic labels + routine docs") is the most labor-intensive and most ambiguous. Currently the agent reads the ASM and writes annotations in free-form judgment.

**Want**: A scaffolding tool `propose_annotations(prg_path)` that:
- Walks the analysis JSON
- For each `unknown` segment, runs a deeper second-pass classifier with more context (cross-references, neighboring segments, KERNAL/DOS routine fingerprints, common-pattern matchers)
- Emits a *draft* annotations file with confidence-marked suggestions + open questions
- Agent reviews/edits the draft instead of writing from scratch

Cuts annotation effort 5-10x in many cases.

---

## R16 — Project audit: integrate with phase-plan

**Priority**: Low

**Problem**: `project_audit` lists issues but does not link them to phase progression. User sees "12 unregistered files" but doesn't know whether that blocks Phase 4 or not.

**Want**: Each audit item links to a phase + a suggested next tool. Audit becomes the action queue for the agent at session start.

---

## R17 — Project profile bootstrap from real crack/port constraints

**Priority**: High

**Source**: Accolade Comics EF port.

**Problem**: Real projects need project-specific rules before useful work starts: goals, non-goals, hardware constraints, loader model, destructive-operation warnings, build rules, active version folder, and known danger zones. In Accolade this emerged manually as `CLAUDE.md`, `docs/arc42.md`, `docs/GLOSSARY.md`, and `docs/ANTI_PATTERNS.md`.

**Want**: `project_init` / `agent_onboard` support a project-profile layer:
- canonical docs: `PROJECT_PROFILE.md`, `GLOSSARY.md`, `ANTI_PATTERNS.md`, optional `ARCHITECTURE.md`
- structured records for quality goals, non-goals, constraints, active workspace, build command, test command, destructive-operation warnings
- onboarding summary that says "read these first" and surfaces the hard constraints before tool suggestions
- optional scaffold generator that asks the agent to create a minimal profile from discovered files and user walkthrough notes

Acceptance: a fresh project can produce a compact profile before deep analysis, and later sessions load it without relying on chat history.

---

## R18 — Patch recipe model with byte assertions and relocation rules

**Priority**: Critical

**Source**: Accolade Comics EF build pipeline.

**Problem**: Crack/port work repeatedly patches extracted binaries. Today patches live in shell/Python snippets or hand notes. The important safety properties are not first-class: expected original bytes, file offset, runtime address, relocation bias, source assembler, backup/original artifact, verification command, and resulting derived artifact.

**Want**: New knowledge record / artifact role `patch-recipe` plus tooling:
- `save_patch_recipe` with target artifact, expected bytes, replacement bytes or source file, offset/runtime address, relocation transform, reason, evidence
- `apply_patch_recipe` verifies expected bytes before writing and refuses mismatches unless explicitly overridden
- recipe output registers patched artifact as derived from original
- UI shows patch table: target, status, original hash, patched hash, verification result
- generated docs list all intentional modifications

Acceptance: a patch like Accolade `/0` prompt skip or `/1` F7 remap can be represented, applied, rebuilt, and audited without hiding logic inside an ad-hoc build script.

---

## R19 — Custom loader ABI / application file API model

**Priority**: Critical

**Source**: Accolade Comics Kevin loader.

**Problem**: Many C64 titles do not use KERNAL `LOAD`. Accolade routes content through a private engine jump table and a `$1998` sector-loader ABI with 2-byte file keys, param blocks, container sub-entries, sentinel calls, and disk-side state. C64RE has disk/CRT/payload abstractions, but no explicit model for the game's own loader API.

**Want**: First-class `loader-abi` model:
- entities for jump-table entries, loader stages, param-block layouts, file-key formats, sentinel values, side/disk selector state
- relation kinds for "loads-key", "dispatches-to", "registers-subentry", "invalidates-cache", "mirrors-disk-state"
- tool to declare loader entry points and decode observed calls from static code or runtime trace
- UI view for "game file API": key -> container/file -> runtime destination -> caller chain

Acceptance: Accolade's `$0800-$082F` API, `$081B/$1998` sector load, `/0` disk-swap flow, and `M! -> GB -> UL -> SQ -> Q!/R!` chain can be modeled without flattening everything into generic xrefs.

---

## R20 — Runtime scenario traces with original-vs-port diff

**Priority**: High

**Source**: Accolade Comics Bug 5 and orphan-file lessons.

**Problem**: Static analysis produced false orphan conclusions in Accolade. The useful evidence was scenario-specific runtime trace: original disk vs EF port, breakpoints on loader entries, compare which file keys/load destinations occur before a gameplay milestone.

**Want**: Scenario trace workflow:
- `define_runtime_scenario(title, target, start_media, breakpoints, stop_condition, expected_milestone)`
- capture normalized events: PC, key/file id, T/S, destination, bank, caller, side index, success/fail, timestamp/frame
- compare two scenario runs: original vs port, old build vs new build
- emit compact diff: missing loads, extra loads, different source medium, different payload hash, different destination, divergent PC
- persist as `runtime-scenario`, `runtime-event-summary`, and `runtime-diff` artifacts

Acceptance: "Story 2 after Robots win" can become a repeatable scenario that proves whether `WT` / `/1` subentries were loaded and retained.

---

## R21 — Negative knowledge / do-not-repeat lessons

**Priority**: High

**Source**: Accolade Comics `ANTI_PATTERNS.md` and `BUG5_CURRENT.md`.

**Problem**: Findings and open questions capture what may be true. Real work also needs explicit "do not try this again" knowledge: refuted theories, failed heuristics, dangerous commands, stale assumptions, and project-specific rules like "do not trust memory system for Bug 5; read trace first".

**Want**: Structured negative-knowledge support:
- new record kind or finding status for `anti-pattern`, `refuted-theory`, `dangerous-operation`, `stale-assumption`
- evidence links to failed attempts, traces, commits, or docs
- onboarding surfaces high-priority negative knowledge before next actions
- `agent_propose_next` avoids proposing actions blocked by negative knowledge unless new evidence exists
- optional generated `docs/ANTI_PATTERNS.md`

Acceptance: Accolade's "static orphan detection without runtime trace is unreliable" and "single RAM snapshot is only a hypothesis" become machine-readable warnings, not just prose.

---

## R22 — Memory / cartridge / flash constraint checker

**Priority**: High

**Source**: Accolade Comics EasyFlash save implementation.

**Problem**: Crack/port changes are constrained by scarce memory and cartridge geometry: EasyFlash erase sector size, free banks, overlay RAM, `$01` CPU port state, EAPI cart visibility, VIC bitmap/color regions, zero-page preservation. Today these rules live in project docs and build comments.

**Want**: Constraint model and checker:
- declare resource regions: RAM ranges, ZP bytes, VIC-visible ranges, cart banks/chips/erase sectors, EAPI runtime areas
- declare operations: overlay copy, flash erase/write, bank switch, decrunch destination, runtime patch
- checker reports collisions and unsafe assumptions: erase would destroy data banks, overlay overlaps live code, cart hidden during EAPI init, caller ZP not preserved
- build/artifact recipes can attach required constraints and verification results

Acceptance: Accolade's Bank 63 save slots plus Banks 56-62 erase-margin and `$0C23-$0FFF` transient overlay can be checked from data instead of remembered manually.

---

## R23 — Container payload and sub-entry lineage

**Priority**: High

**Source**: Accolade Comics `/0` and `/1` container files.

**Problem**: A disk file may be a container with internal subentries that are not separate BAM/LUT files. Bug 5 showed this matters: a truncated `/1` lost a tail subentry (`WT`) even though the external file list did not expose it independently.

**Want**: Extend payload model for nested/container payloads:
- parent payload can contain named subpayloads with offsets, sizes, keys, load addresses, and registration mode
- relations: `contains`, `registers`, `resident-through`, `replaced-by`, `deduped-with`
- extraction/import tools can register subentries as first-class payloads while preserving parent lineage
- runtime trace can distinguish "loaded external file" vs "registered/executed subentry from resident container"
- UI groups subpayloads under parent artifact and shows missing/truncated tails

Acceptance: Accolade `/1` can show `WT`, `AM`, and sprite-frame tail as subpayloads, with evidence whether each exists physically on disk or is inherited from another side/version.

---

## R24 — Build pipeline as registered workflow artifact

**Priority**: Medium

**Source**: Accolade Comics `ef_build.sh`, `ef_pack.py`, `ef_build_crt.py`.

**Problem**: Port/crack projects often have a meaningful build pipeline: assemble sources, patch extracted files, pack payloads, build CRT, verify byte-exactness, compare hashes, reserve banks. Today C64RE registers outputs, but the pipeline itself remains opaque.

**Want**: Build pipeline model:
- register ordered build steps with command, inputs, outputs, expected hashes/byte identity, and side effects
- attach generated artifacts to the step that produced them
- expose pipeline view: source -> patch -> pack -> CRT
- audit detects stale outputs when inputs changed
- optional `run_build_pipeline` wrapper that records tool-run metadata and verification results

Acceptance: Accolade's EF build can be represented as a reproducible pipeline with explicit outputs, instead of a shell script that the knowledge layer only sees after the fact.

---

## Process / Doctrine items

These are workflow questions that the tool *can* answer but currently leaves open.

### P1 — What does "disassembled" mean for a PRG?

Define a checklist (steps 1-7 from R1) and require at least N steps for a PRG to be marked `done`. Make the bar explicit so users / agents / dashboard agree.

### P2 — Per-PRG vs project-wide priority

When porting / cracking, only some PRGs matter (loader, custom kernal, save logic). Pure asset PRGs (sprite banks, scene data) need only Phase-1 + visual preview, not full annotation. The workflow should support "cracking-priority" or "port-priority" tagging so phases don't demand full annotation of every byte.

### P3 — Cracker-role vs analyst-role workflows

`agent_set_role(role="cracker")` is documented but does not differ visibly from `analyst`. Define explicit cracker-role workflow:
- skip exhaustive content-file annotation
- prioritize loader / protection / save / kernal-replacement
- output target = patched binary or cart layout, not encyclopedic disasm

---

## R25 — Auto-emit routine-findings from `*_annotations.json`

**Status**: DONE — Spec 055 (`055-r25-routine-findings-emit.md`). disasm_prg auto-emits, plus standalone `import_annotations_as_findings` MCP tool. Phase A added effective-segments overlay so cross-boundary annotation reshape is honoured.

**Priority**: High

**Problem**: When agent (or `propose_annotations`) writes routines into an `*_annotations.json` file, those routines never become findings in `findings.json`. So `archive_phase1_noise` (Spec 053) and `auto_resolve_questions` (Spec 052) have nothing to scan, and 1200+ phase-1 hypothesis findings + 570 open questions stay forever.

**Want**: Whenever `disasm_prg` consumes an `*_annotations.json` (Phase 3 final disasm pass), it ALSO walks the file's `routines[]` array and auto-emits one finding per routine via `service.saveFinding(...)` with:
- `kind`: `"classification"` (or new dedicated `"routine"` kind)
- `addressRange`: derived from routine entry's address + segment-end (or until next routine address)
- `tags`: `["routine", "annotation"]`
- `summary`: routine's `comment` field
- `artifactIds`: linked to the source PRG + the annotations file

Same for `segments[]` reclassifications above some confidence threshold (also become findings).

Idempotent — re-running disasm_prg with same annotations should not duplicate findings (use deterministic id, e.g. `finding-routine-<binaryStem>-<startHex>-<endHex>`).

**Depends on**: Bug 25 (save_finding tool needs `address_range` param first).

**Cuts noise budget by**: directly proportional to how many routines the agent annotates. On Murder, ~40 documented routines × auto-emit = 40 routine-findings → archive_phase1_noise can finally find a match for the ~600 RAM-region hypothesis findings whose addresses fall inside those routines.

---

## R26 — Closed-loop noise archive after annotation/finding save

**Status**: DONE — Spec 057 (`057-r26-closed-loop-sweep.md`). disasm_prg + save_finding (when tag=routine + addressRange) auto-run sweep. Footer shows scope-restricted + project totals. propose_annotations + mark_segment_* deferred per refinement.

**Priority**: Medium-High

**Problem**: Agent has to remember to run `archive_phase1_noise` and `auto_resolve_questions` manually after writing annotations or routine-findings. Easy to forget; even then, "0 archived / 0 answered" for several reasons (Bug 25, Bug 23) leaves the agent unsure if the workflow ran.

**Want**: After ANY of the following ops succeed, the responsible MCP tool calls `service.archivePhase1Noise()` + `service.autoResolveQuestions()` in safe mode and returns counts inline:
- `disasm_prg` (when annotations file consumed)
- `save_finding` (when finding has `tags=["routine"]` AND `addressRange`)
- `propose_annotations` (when draft contains `routines[]`)

Tool response gets a footer like:
```
Saved finding: …
Auto-archive sweep: archived 12 hypothesis findings, answered 17 questions.
```

Same closed loop for the Graphics tab (Bug 23 family): after `mark_segment_confirmed/rejected`, run `archive_phase1_noise` so that confirmed/rejected segments propagate into auto-archive.

**Depends on**: R25 (need routine-findings to actually exist) + Bug 25 fix.

**Why this matters**: Per the user request that triggered Bug 25 — "after annotation/semantic conclusion, the file's open-questions should be re-evaluated automatically". This is the closed-loop wiring.

---

## R27 — Per-payload noise scope (run auto-resolve only for the just-touched file)

**Status**: DONE — Spec 056 (`056-r27-per-payload-scope.md`). archive_phase1_noise + auto_resolve_questions accept optional `artifact_id`. Match strict `artifactIds.includes`. Output footer surfaces scope.

**Priority**: Medium

**Problem**: `archive_phase1_noise` and `auto_resolve_questions` walk the ENTIRE project. On big projects this is slow and produces non-actionable output ("checked 1200 findings, archived 0 in this scope").

**Want**: Both tools accept an optional `artifact_id` or `payload_id` filter. When provided:
- archive only hypothesis-findings whose `artifactIds` includes that artifact (or whose addressRange falls inside one of the artifact's load contexts)
- answer only open-questions whose `artifactIds` includes that artifact

The post-annotation closed loop (R26) automatically scopes to the artifact whose annotations were just saved.

**Why**: turns the auto-archive into a per-file feedback signal: "you just annotated 02_ab.prg → 18 of its hypotheses are now archived, 23 of its questions answered". Much more actionable than project-wide totals.

---

## UX1 — View-centric tabs (16 → 11)

**Status**: SPEC WRITTEN — Spec 059 (`059-ux1-view-centric-tabs.md`).

**Problem**: workspace UI exposes 16 top-level tabs, with one tab per knowledge record kind (Entities, Flows, Relations) plus the standalone Load Sequence. Real navigation happens via Memory Map / Flow Graph / Listing / Disk; the entity-list-style tabs are noise.

**Want**: organise tabs by VIEW (Memory Map, Flow Graph, Listing, Disk, Cart, Graphics), not by record type. Knowledge (entities / findings / relations) is surfaced INSIDE every view via three layered mechanisms:
1. Inspector pane with uniform layout per item type (linked entities / findings / relations / artifacts + actions).
2. Overlays / badges on view items (finding count, status icon, confidence colour).
3. Filter facets per view (kind, status, confidence) with URL-persisted state.

**Removed tabs**: Entities, Flows, Relations, Load Sequence (folded into Flow Graph as "Load" sub-mode), Recent Activity (collapsed into Dashboard widget).

**Power-user / debug access**: removed from UI. JSON files in `knowledge/*.json` + MCP `list_*` tools + LLM-on-demand markdown reports cover that.

**Migration**: big bang on feature branch (two-person team).

---

## UX2 — Canonical payload flow (no UI dedupe; fix at the data layer)

**Status**: SPEC WRITTEN — Spec 060 (`060-ux2-canonical-payload-flow.md`).

**Reframed (per user feedback)**: original UX2 framing called for UI-side dedupe in the Payloads tab. Refinement showed the real defect is in the data layer (Bugs 30 + 31): artifact saver doesn't dedupe by path when callers pass different `input.id`, and importers create parallel payload entities for the same content under different names (`murder` vs `01_murder`). UI patches would only mask the corruption.

**Rule**: every code-modify / asset-extract / discovery action MUST honour Spec 025 lineage. The UI ALWAYS shows only the latest version. No special-case dedupe in the UI.

Implementation tracks:
- Bug 30 — artifact saver path-dedupe + `dedupe_artifact_registry()` migration.
- Bug 31 — payload entity importer hygiene, `aliases: string[]` schema, `dedupe_payload_entities()` migration.

For legacy projects (Murder, etc.), the spec ships an agent-driven migration prompt that walks the cleanup with dry-run previews + reference remap verification.

---

## UX3 — Questions tab bulk re-evaluation via task queue

**Status**: SPEC WRITTEN — Spec 061 (`061-ux3-questions-bulk-revaluate.md`).

**Problem**: Questions tab on Murder shows 570 open. User filters down to 66 (open + static-analysis), wants to ask the LLM to re-evaluate the selection against the current state of findings + annotations and auto-close the unambiguous ones — as a single bulk action.

**Want**: bulk action "Re-evaluate selection (N) via LLM" that:
1. Runs the deterministic `archivePhase1Noise` + `sweepQuestionResolutions` sweep scoped to the selection's linked artifacts (Phase 1, immediate).
2. Saves a single task to the project task queue carrying the remaining question IDs and a structured prompt; the agent picks it up via `c64re_whats_next` polling and processes per question with one of four outcomes (`answered`, `invalidated`, `researching`, `still-open`).
3. UI surfaces progress: toast on submit + Dashboard task tile + per-question `re-eval pending` badge + auto-poll while any bulk task is active.

Schema add: `TaskRecord.kind: "human" | "automation"` so the UI can distinguish UI-triggered automation tasks from manual human TODOs.

Aligns with the user's broader workflow: "Claude initialisere das Projekt" → "Starte das UI" → "Polle alle 30 Sekunden ob es ein Todo gibt aus dem UI".

## R28 — Headless 1541 drive-bus emulation for custom-loader runtime traces

**Status:** Implementation **DONE** (Sprints 60-64, Spec 062). Drive 6502 + IEC bus + GCR I/O + persist + VSF round-trip all shipped. Murder full-boot acceptance pending session-manager integration (deferred follow-up). Plus Spec 063 captures full-C64-headless vision (long-term roadmap).


**Severity:** high (blocks runtime tracing of every game with a custom drive loader — virtually all C64 commercial software 1985+)
**Discovered during:** Murder on the Mississippi headless boot attempt (2026-05-03). Auto-boot trap loaded `murder.prg` ✓, KERNAL-LOAD-trap loaded `ab.prg` ✓, but ab.prg's drive-install sequence (`LISTEN 8 / SECOND $6F / CIOUT M-W bytes / UNLSN`, then M-E to start drive code) had no responder. Calls fall through to bare KERNAL serial routines that spin on `$DD00` IEC handshake forever, SP underflows, RTS pulls garbage → drift to $C000 BRK chain at cycle 12413.

### Symptom

Headless emulator's trap layer covers KERNAL `LOAD` / `SAVE` only. Anything that touches the serial bus directly — drive-RAM writes (M-W), drive-execute (M-E), block-read (U1/B-R), custom $DD00 bit-bang protocols — is unhandled. For Murder this means we can boot exactly two PRGs (the trapped LOAD chain) before the runtime derails. Most non-trivial C64 software fails the same way.

### Why this matters

- **Spec 060+ migration validation:** without runtime traces from headless we can't generate `define_runtime_scenario` / `record_runtime_event_summary` data for the Murder project — the entire `runtime-aggregation` workflow phase is unblockable.
- **EF-port spec prerequisite:** the EF port plan's Phase 0 needs traced evidence of the original loader behaviour (which addresses fastloader-write to, what cmd-byte → load-address dispatch actually does, where save-disk-write code lives) before we can write port patches. VICE works but doesn't integrate with the C64RE trace pipeline; headless does.
- **Generality:** any future RE target that uses a custom loader hits this immediately. Murder is just the first to surface it.

### Proposed solution (three escalation levels)

**Level 1 — IEC bus message trap (smallest):**
Pattern-match the standard KERNAL serial sequences in the trap layer:
- `LISTEN($FFB1) device=8` → start capturing
- `SECOND($FF93) sa=$6F` → expect command channel
- `CIOUT($FFA8)` stream → buffer command bytes ("M-W" + addr-lo + addr-hi + count + payload, "M-E" + addr-lo + addr-hi, "U1" + ch + dev + track + sector, etc.)
- `UNLSN($FFAE)` → parse buffer, dispatch
- For M-W: write into a virtual 2KB drive-RAM buffer.
- For M-E: stub-execute (no-op return — so drive code does nothing, but C64 control-flow doesn't desync).
- For U1/U2/B-R/B-W: serve / store via the attached G64/D64.
- For TALK + read-back: replay drive-RAM content / OK status bytes ("00, OK,00,00\r").

Effort: medium. Catches every game that uses KERNAL serial routines for drive comms (vast majority). Does NOT catch games that bypass KERNAL and bit-bang $DD00 directly during the install phase (rare for install — common for runtime fastload). Won't actually run drive code — only stub-acks it.

**Level 2 — drive 6502 sandbox + VIA skeleton (recommended):**
Add a second 6502 instance to the headless step loop with:
- Drive RAM $0000-$07FF, drive ROM stubs at $C000-$FFFF (or refuse to fetch from there and stub-return),
- VIA1 ($1800-$180F) PB modeling IEC ATN/CLK/DATA in/out wired to C64's CIA2 PA ($DD00) via shared bit-state,
- VIA2 ($1C00-$1C0F) drive control register (LED, motor, head-step) — observable but no platter,
- Job-loop ZP byte ($00) intercepted: writes trigger "fake job done" with ack code.

Both CPUs tick in lockstep on the same clock. M-W actually writes drive-RAM, M-E sets drive-PC and the drive CPU runs custom code, raw $DD00 bit-bang protocols (Murder's runtime fastloader uses this) work because the drive CPU sees and toggles its own VIA1 pins. No GCR decode, no platter physics — block reads served from the attached image when drive code requests them via standard sector-read pathways.

Effort: large but bounded. Covers ~95% custom-loader use cases. Drive ROM unhandled means games that JSR into drive ROM ($C000-$FFFF) need targeted stubs, but those are well-known KERNAL-equivalents (SCAN, DRDBYT, etc.) and there are <50 hot ones.

**Level 3 — full 1541 (out of scope):**
Complete drive ROM, GCR encode/decode, head positioning, write-protect, sync-detection. Equivalent to VICE's drive emulation. Multi-sprint effort, mostly redundant since VICE exists. Reject unless someone needs it for protection-cracking work where GCR-level fidelity matters.

### Recommendation

Ship **Level 1 first** (small, unblocks LOAD-only games + games whose drive-install is M-W stubs), then **Level 2** as a follow-up (unblocks Murder + every custom-fastloader title). Level 3 only if a project demands it.

### Acceptance criteria

- After Level 1: Murder boots through ab.prg's KERNAL-serial drive-install sequence without SP underflow. Last-trap shows recognised IEC commands, not "SETLFS lfn=47 device=223". Test: trace runs >50k instructions before any fault.
- After Level 2: Murder boots through ab.prg's full custom-loader install, dispatches its first runtime cmd-byte ($0F → riv1 load), and the trace shows the loaded payload arriving in RAM at $0700. Test: `record_runtime_event_summary` captures load events for at least riv1+riv2+love.

### Cross-reference

- Spec 060 — migration applied successfully on Murder; this FR unblocks the runtime-aggregation phase that would consume the migrated data.
- EF port spec (pending) — Phase 0 (Prerequisites) calls for runtime trace evidence; that work depends on this FR landing.
- VICE integration tools (`vice_session_*`, `vice_trace_*`) — alternative route, but heavier and outside the headless trace pipeline.

### Reference implementation available

VICE source tree is now checked out at `/Users/alex/Development/C64/Tools/vice/vice/`. Relevant directories for Level 2 / Level 3 work:

- `src/drive/` — drive top-level: `drive.c`, `drivecpu.c` (drive 6502 emulation main loop), `drivecpu65c02.c` (65C02 variants), `driveimage.c`, `drive-snapshot.c`, plus `drive-writeprotect.c`.
- `src/drive/iec/` and `src/drive/iecbus/` — IEC bus modelling: ATN/CLK/DATA wiring, serial protocol state machine, drive-side VIA handlers (the exact coupling Level 2 needs between C64 CIA2 and drive VIA1).
- `src/diskimage/`, `src/imagecontents/` — D64/G64 mounting, GCR encode/decode (Level 3).
- `src/c64/cart/` — cartridge handling reference (informs CRT support already, listed for completeness).

Use VICE as: (a) algorithmic reference for the IEC handshake state machine, (b) ground-truth oracle to diff our headless drive-stub behaviour against during testing, (c) source for drive-ROM stub addresses + their KERNAL-equivalent semantics. Licensing: VICE is GPL — keep clean-room separation if our headless emulator must remain non-GPL; otherwise direct lift of `drivecpu.c`-style code substantially accelerates Level 2.
