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
