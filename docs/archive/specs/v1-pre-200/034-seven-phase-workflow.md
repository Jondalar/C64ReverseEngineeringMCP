# Spec 034: Seven-Phase Reverse-Engineering Workflow

## Problem

C64RE today exposes ~150 MCP tools without strong ordering. The
agent-doctrine doc describes a workflow but is read once and decays.
The per-artifact status (Spec 022) lists six low-level steps that do
not match the cognitive loop the user actually wants. Result: agents
deviate — skip extraction, jump to semantic analysis without
inspecting segments, claim "done" without rebuild verification, etc.

## Goal

Make the seven-phase workflow first-class. Every artifact carries a
current phase. Tools are tagged with the phase they belong to.
`agent_propose_next` only proposes phase-consistent next actions.
Hard-gate refuses tool calls that skip phases when the project opts
in. Reminders keep the phase visible after each tool call. Per-
artifact tracking — asset PRGs can stop at phase 3 if cracker mode
flags them as not-relevant.

## The Seven Phases

| # | Phase | Core action | Tools |
|---|-------|------------|-------|
| 1 | Extraction / Inventarization | Pull bytes off the medium, register every artifact | `extract_disk`, `extract_crt`, `extract_disk_custom_lut`, `register_existing_files`, `bulk_create_cart_chunk_payloads` |
| 2 | Loader / Load behaviour / Sequence | Understand how the title actually loads — KERNAL? Custom fastloader? Container? Sub-entries? | `inspect_disk`, `inspect_g64_*`, `analyze_g64_anomalies`, `declare_loader_entrypoint`, `register_load_context`, `register_container_entry`, VICE trace |
| 3 | Heuristic Disasm | Deterministic Phase-1 analysis + first-pass disassembly | `analyze_prg`, `disasm_prg` (no annotations), `ram_report`, `pointer_report` |
| 4 | Segment Analysis | Inspect every non-trivial segment, classify, hypothesize | `inspect_address_range`, `scan_graphics_candidates`, `c64ref_lookup`, manual `save_open_question` |
| 5 | Semantic Analysis V1 | Merge findings into entities, reclassify segments, write annotations, re-disasm | `save_finding`, `save_entity`, annotation files, `disasm_prg` (annotated) |
| 6 | Meta Connections | Cross-artifact relations, flow graphs, payload chains | `save_relation`, `save_flow`, `link_entities`, `link_payload_to_*`, `bulk_import_analysis_reports` |
| 7 | Semantic V2 | Re-evaluate findings under meta-context, refine annotations, lock in rebuild verification, render docs | `save_finding` (refined), `disasm_prg` final pass, `assemble_source --compare_to`, `render_docs` |

Each phase has explicit done criteria — see `docs/re-phases.md`.

## Approach

### Schema

Extend `ArtifactRecord`:

```ts
phase?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
phaseFrozen?: boolean;        // cracker stopped here on purpose
phaseFrozenReason?: string;
```

Default `phase = 1` for new artifacts. `phase` advances only via
explicit `agent_advance_phase(artifactId, toPhase, evidence?)`.

### Tool tagging

Every MCP tool description gets a `[Phase N]` (or `[Phase N+]`)
prefix. The tool registry exposes a `phase: number` metadata field
read by `agent_propose_next` and the phase gate.

### `agent_propose_next` (soft gate, default on)

For each artifact:

1. Read `artifact.phase`.
2. List tools tagged with the same or next phase as candidates.
3. Demote tools tagged for phases > `phase + 1` to "out of order"
   list with explanation.
4. Output ordered by phase ascending so the agent always sees the
   "current phase next action" first.

### Hard phase gate (opt-in via project profile)

When `projectProfile.phaseGateStrict === true`:

- Tools whose phase tag exceeds the artifact's current phase by more
  than 1 are refused.
- Refusal output is a structured plain-text response (not an error
  envelope) explaining: current phase, requested phase, why refused,
  and what to do instead.

```
# Phase Gate Refused

Tool: save_finding
Artifact: 11_riv1.prg (phase 3)
Requested phase: 5+ (semantic analysis)
Why: phase 4 (segment analysis) is not yet complete on this
artifact. Findings written before phase 4 are usually
under-contextualised and need revision in phase 5.

Recommended next action:
  inspect_address_range(artifact_id="...", start=$1000, end=$1FFF)

Override:
  set projectProfile.phaseGateStrict to false, or
  call agent_advance_phase(artifactId="...", toPhase=4,
    evidence="phase 4 done out-of-band: ...").
```

### Reminder loop

Every `agent_record_step` and every Spec-022 status-changing tool
appends a single line to its output:

```
Currently in phase 4 on artifact X (60% of phase). Next required:
agent_propose_next(artifact_id="X").
```

So even mid-tool-call the phase context stays visible in the LLM
context window.

### Per-artifact freeze (cracker mode)

Cracker can mark an asset PRG as frozen at phase 3:

```
agent_freeze_artifact(artifact_id, reason)
```

Freeze sets `phaseFrozen = true`. Status pct counts the artifact as
done at its frozen phase. `propose_next` skips frozen artifacts
unless the user asks for them explicitly.

## Acceptance Criteria

- A new artifact starts at `phase = 1`.
- `agent_propose_next` against an artifact in phase 3 lists phase-3
  and phase-4 tools first; phase 5+ tools appear in an "out of
  order" section with explanation.
- With `phaseGateStrict = true`, calling `save_finding` against an
  artifact in phase 3 returns the structured "Phase Gate Refused"
  output, not an error envelope.
- Frozen artifacts contribute to per-project completion at their
  frozen phase and are skipped by `propose_next`.

## Tests

- Smoke: walk a fixture artifact V0 → phase 1 → 2 → ... → 7 with
  explicit advances; assert `propose_next` output ordering at each
  step.
- Smoke: enable strict gate, attempt skip, assert refusal output.
- Smoke: freeze an artifact, assert pct change and propose_next
  skip.

## Out Of Scope

- Auto-advancing phase based on tool calls (manual advance keeps
  the user in control).
- Per-step (within-phase) granularity — coarse phase tracking only.

## Dependencies

- Spec 022 (per-artifact status) — extend schema, do not replace.
- Spec 026 (project profile) — `phaseGateStrict`,
  `phaseReminders` fields.
- Spec 035 (worker prompts) — uses the same phase tagging.
