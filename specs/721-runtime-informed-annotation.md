# Spec 721 — Runtime-Informed Semantic Annotation

**Status:** DRAFT (2026-05-20)
**Parent specs:** `specs/720-disasm-output-quality.md` (static heuristic labels — prerequisite), `specs/708-declarative-trace-definitions-tracedb-control.md` (retained runtime trace definitions/runs), `specs/042-*` (`propose_annotations`), revives `specs/_archive/249-disasm-annotations-table-discovery.md` + `specs/_archive/235-runtime-disasm-link.md` onto the V2 runtime substrate.
**Scope:** wire RUNTIME EXECUTION EVIDENCE (taint / swimlane / follow-path / profile / events) into the SEMANTIC ANNOTATION layer — both a mechanical extraction pass (deterministic) and an LLM-synthesis step (the "runtime explains the code again" workflow that produced the Accolade Comics gold annotations).

## 1. Why this spec exists

The gold annotations (`EF_Version_C/003_runtime_library.asm` — 42 routines with accurate prose, semantic labels, segment comments) were authored by an LLM (Claude) reading the disasm **while observing runtime traces alongside**. That is what makes the annotation *coherent / connected* ("zusammenhängend"): static structure explained by dynamic ground-truth.

**2026-05-20 audit finding:** the pipeline FORESEES this loop but does NOT wire it.

- Seven-phase workflow (`docs/re-phases.md`) has the slots: Phase 2 collects runtime evidence, Phase 5/6/7 do semantics — but separate silos.
- `propose_annotations` (Spec 042) reads **static analysis only** — no trace input.
- Runtime forensic tools (`runtime_trace_taint`, `runtime_swimlane_slice`, `runtime_follow_path`, `runtime_profile_loader`, `runtime_query_events`) are **read-only**. None emit findings or annotation hints.
- Two archived specs designed exactly this and were never built:
  - **Spec 249** — runtime-tables analyzer → `<artifact>_runtime_tables.json` → consumed by `propose_annotations`.
  - **Spec 235** — runtime evidence ↔ disasm link; resolution exists read-only (`runtime_resolve_pc`), no auto-generation.

**Now feasible** because the V2 runtime substrate exists (taint graph, swimlane, follow-path, profile-loader, snapshot/trace per Spec 701) — it did not when 249/235 were archived (2026-05-08).

**Prerequisite:** Spec 720 (static heuristic labels). Clean `sub_`/`loop_`/`tbl_`/`ptr_` baseline first, then runtime evidence layers semantic meaning on top.

## 2. Two layers

Full automation = two distinct layers. Do NOT conflate.

- **(a) Mechanical extraction (deterministic).** Runtime forensics → structured findings + annotation hints. No LLM. Produces: confirmed routine boundaries, call-graph edges, data-flow facts, table classifications, protection-pattern tags, RAM-role hypotheses. This is Spec 249 revived.
- **(b) LLM synthesis (agent-in-the-loop).** Agent receives an *evidence bundle* (disasm slice + taint + swimlane + profile + the mechanical findings) for a routine → writes coherent prose + semantic name. This is the "runtime erklärt's nochmal" step. Not fully deterministic, but heavily evidence-fed so it's grounded, not guessed.

Layer (a) makes (b) cheap + accurate. (a) can ship + run unattended; (b) is orchestrated per-routine.

## 3. Mechanical layer — runtime forensics → findings (revive Spec 249)

A pipeline post-pass `analyzeRuntimeEvidence(artifactId, traceRef)` that reads existing V2 forensic outputs and emits findings + annotation hints. Triggers:

| Runtime signal | Source tool | Emitted annotation hint |
|---|---|---|
| Address executed as code (in trace PC set) but flagged data by heuristic | `runtime_query_events` PC set | `SegmentAnnotation kind=code` (confirm island) |
| JSR target hit at runtime | PC set + call events | `RoutineAnnotation` (confirmed entry) + call-graph edge |
| Indirect-JMP target consistency across runs | `runtime_follow_path` | `LabelAnnotation` on resolved target |
| Indexed read sweep over a region | taint + event addr ranges | `SegmentAnnotation kind=table` + `tbl_` label |
| Byte written from N sources / RMW chain | `runtime_trace_taint` TaintGraph | RAM-role finding (`flag`/`counter`/`pointer`) → feeds ROUTINE CONTEXT |
| IO/IEC touch pattern | `runtime_profile_loader` | `RoutineAnnotation` hint (`loader`/`disk`/`io` role) |
| Protection-pattern detector hit | `runtime_profile_loader` (5 detectors) | finding + `RoutineAnnotation` (`protection_check`) |
| C64↔drive interaction at a PC | `runtime_swimlane_slice` | finding linking C64 routine ↔ drive response |

Output: `<artifact>_runtime_evidence.json` (findings + hints) consumed by an extended `propose_annotations` (Task 721.4). Hints carry `confidence` + `provenance: "runtime"` so they're distinguishable from static heuristics and from LLM prose.

All emitted via the existing `save_finding` / `save_entity` knowledge layer — no new persistence format.

## 4. LLM synthesis layer — evidence bundle → coherent prose

The "runtime explains it again" step. For a target routine, assemble an **evidence bundle** and hand it to the annotating agent (or a dedicated tool that calls the model):

The bundle (§5) gives the agent everything the human-with-traces had:
- what the routine IS structurally (disasm + static facts),
- what it DOES dynamically (taint = data in/out, swimlane = who it talks to, profile = IO/protection role),
- what the mechanical layer already concluded (findings/hints).

Agent writes: `RoutineAnnotation.name` + `.comment` (prose), `LabelAnnotation`s for local targets, `SegmentAnnotation.comment`. Written to the annotations JSON → re-render via `disasm_prg` → gold-style output.

This step is agent-orchestrated (master/worker per Spec 035). Not a single deterministic tool, but the bundle makes it reproducible + grounded. A routine annotated this way cites its runtime evidence (so a reviewer can check the prose against the trace).

## 5. Evidence bundle format

`buildEvidenceBundle(artifactId, routineAddr, traceRef) → EvidenceBundle`:

```
{
  routine: { entry, range, static_facts },     // from AnalysisReport + Spec 720 labels
  disasm: "<the routine's asm slice>",          // rendered listing for this range
  taint:   { inputs: [...], outputs: [...] },   // runtime_trace_taint summarized
  callers: [...], callees: [...],               // call-graph edges (mechanical layer)
  ram_touched: [{ addr, role, evidence }],      // taint-derived RAM roles
  interactions: [...],                          // runtime_swimlane_slice C64↔drive
  io_profile: { regs, iec, protection_tags },   // runtime_profile_loader
  mechanical_hints: [...],                       // §3 findings for this routine
}
```

Bundle is the single input to the LLM step. Compact + token-bounded (one routine at a time, not the whole binary).

## 6. Phase integration

Slots into the seven-phase workflow without new phases:

- **Phase 2** (loader/runtime) records a retained Spec 708 trace run and its reusable `traceRef`, so later phases consume declared evidence rather than one-off diagnostics.
- **Phase 5** (Semantic V1): mechanical layer (§3) runs → enriches `propose_annotations` draft with runtime hints.
- **Phase 6** (Meta Connections): call-graph + C64↔drive interaction edges (from swimlane) become relations (`save_relation`, `link_entities`).
- **Phase 7** (Semantic V2): LLM synthesis (§4) per routine using the evidence bundle → final prose. This is where "runtime explains it again" lands.

`phase-tools.ts` tags: add the new mechanical pass to Phase 5 tooling, the bundle builder to Phase 7.

## 7. Acceptance

1. **Mechanical pass runs unattended:** `analyzeRuntimeEvidence` on a traced artifact emits `<artifact>_runtime_evidence.json` with ≥1 finding per category that the trace supports. Deterministic (same trace → same output).
2. **propose_annotations consumes runtime hints:** the draft annotations JSON gains runtime-provenance routines/labels/segments distinct from static heuristics.
3. **Evidence bundle builds + is token-bounded:** `buildEvidenceBundle` for a routine returns a complete bundle under a fixed token budget; one routine at a time.
4. **End-to-end demo on a known target:** re-annotate a slice of the EF/Accolade `003` library (which has gold annotations to compare against) via mechanical + LLM-synthesis. Resulting routine prose is *coherent* (cites runtime evidence) and semantic labels match the dynamic behavior. Not byte-identical to gold (prose varies) but materially closer than Spec 720 static-only output.
5. **Byte-identical rebuild stays green** — annotations are comments/labels only (inherited from Spec 720 §10.1 hard gate).
6. **Provenance traceable:** every runtime-derived annotation carries `provenance: "runtime"` + a reference to the trace evidence that produced it.

## 8. Out of scope

- Replacing the static heuristic labels (Spec 720) — this layers ON TOP.
- Fully deterministic prose generation — §4 is agent-in-the-loop by design.
- New runtime forensic tools — reuse existing V2 (taint/swimlane/follow-path/profile/events).
- Trace capture/control mechanics — Specs 701/708 and V2 own that; this consumes retained `traceRef`s.
- Cross-artifact / whole-game synthesis — one artifact at a time first.
- NTSC / hardware variants — orthogonal.

## 9. Tasks

| ID | Task | Layer | Depends |
|---|---|---|---|
| 721.1 | Consume a reusable retained `traceRef` from a Spec 708 Phase-2 runtime trace run (checkpoint/media/definition-linked evidence later phases can re-open). | infra | Spec 708 |
| 721.2 | `analyzeRuntimeEvidence(artifactId, traceRef)` mechanical pass — §3 trigger table → findings + `<artifact>_runtime_evidence.json`. | (a) mechanical | 721.1 |
| 721.3 | Emit findings via `save_finding`/`save_entity` with `provenance:"runtime"` + confidence. Call-graph + C64↔drive edges via `save_relation`. | (a) | 721.2 |
| 721.4 | Extend `propose_annotations` to consume `_runtime_evidence.json` (runtime hints rank above static heuristics, below LLM prose). | (a)→draft | 721.2 |
| 721.5 | `buildEvidenceBundle(artifactId, routineAddr, traceRef)` — §5 bundle, token-bounded. | (b) | 721.2 |
| 721.6 | LLM-synthesis orchestration: per-routine bundle → `RoutineAnnotation`/`LabelAnnotation`/`SegmentAnnotation` prose. Master/worker per Spec 035. | (b) | 721.5 |
| 721.7 | End-to-end demo on EF `003` library slice; compare coherence vs gold + vs Spec 720 static-only. | verify | 721.4 + 721.6 |
| 721.8 | Phase-tool tagging (`phase-tools.ts`): mechanical→Phase 5, bundle/synthesis→Phase 7. | infra | 721.2 + 721.6 |
| 721.9 | Byte-identical rebuild gate + provenance audit. Memory note + close. | verify | 721.7 |

## 10. References

- `specs/720-disasm-output-quality.md` — static heuristic labels (prerequisite).
- `specs/_archive/249-disasm-annotations-table-discovery.md` — original runtime-table-discovery design (revived here).
- `specs/_archive/235-runtime-disasm-link.md` — runtime↔disasm resolution (read-only `runtime_resolve_pc` exists).
- `specs/042-*` — `propose_annotations` (static; extended in 721.4).
- `docs/re-phases.md` — seven-phase workflow (slots in §6).
- `src/agent-orchestrator/phase-tools.ts` — phase tool tags.
- V2 runtime tools: `runtime_trace_taint` (taint.ts), `runtime_swimlane_slice` (swimlane.ts), `runtime_follow_path`, `runtime_profile_loader`, `runtime_query_events`, `runtime_resolve_pc`.
- Gold reference: `EF_Version_C/003_runtime_library.asm` + `analysis/003_runtime_library_annotations.json` (42 routines, the coherence target).
- `specs/035-*` — master/worker pattern (for 721.6 orchestration).
- `specs/701-*` — autonomous runtime substrate.
- `specs/708-declarative-trace-definitions-tracedb-control.md` — retained trace-run and `traceRef` authority consumed here.
