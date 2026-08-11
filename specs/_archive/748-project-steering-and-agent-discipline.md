# Spec 748 — Project Steering + Agent Discipline

**Status:** DONE — closed 2026-08-11. 748.1 and 748.2 shipped (`e2e:748` 10/10);
**748.3 is SUPERSEDED by Spec 784**, which reversed its direction rather than
delivering it. See §748.3 below for the decision and what survives of it.

The KIRO "steering file" analogue for a C64RE project: persistent, project-scoped,
always-in-context rules that steer the consuming LLM every session, so disciplines
survive context loss / compaction. Motivated by BUG-032 (no steering makes the agent
record findings / reconcile questions after each action) and the trace→cartography
gap (a captured trace is never translated into structured `medium_spans` / disk-view,
because nothing makes the agent do it).

## Three strengths of steering (weakest → strongest)

1. **Prose steering (this Kiro analogue).** Always-injected markdown rules. Easy,
   but advisory — the agent can skip it (that is BUG-032's whole point). Works only
   because it is always in context.
2. **Active orchestrator steering.** `agent_next_step` derives the next action from
   real project state; encode the disciplines as state-rules so the per-turn nudge
   enforces them (e.g. "finalized load-trace + empty loader-events / no payload spans
   → derive the cartography"; "action done + finding not recorded / question not
   reconciled → do that first").
3. **Hard automation.** The tool DOES the expensive/error-prone translation, so
   steering only points at it (e.g. a trace→cartography extractor that correlates
   drive GCR T/S reads with C64 store targets → emits `loader-events` +
   `register_payload(medium_spans)`).

## Slices

- **748.1 — Project steering file (DONE).** `<project>/knowledge/steering.md`, written
  via `project_steering_set` (default tool, cap 108→109), injected VERBATIM at the TOP
  of `agent_onboard` every session; a fresh project's onboard names the tool. Gate
  `e2e:748` 6/6.
- **748.2 — Orchestrator teeth (DONE, `e2e:748` 10/10).** Encodes the post-action
  disciplines as state. T1: heuristic analyze_prg validation prompts hidden from the
  default question surfaces behind a count (`isHeuristicQuestion`/`partitionQuestions`;
  `listOpenQuestions({excludeHeuristic})`). T2: `agent_propose_next` emits an
  ID-prefilled reconcile step when a real open question's address range overlaps an
  active unlinked finding (`save_open_question status=answered
  answered_by_finding_id=…`; `save_open_question` gained `address_range`). T3:
  `ensureDefaultSteering` provisions the record/reconcile discipline into every
  project's `steering.md`. Closes the enforcement half of BUG-032.
- **748.3 — Trace→cartography extractor (SUPERSEDED by Spec 784, 2026-08-11).**
  As written, this wanted a tool that reads a finalized `.c64retrace`/DuckDB,
  correlates drive-side sector reads with the C64 store targets, and emits
  `loader-events` + `register_payload(medium_spans)` so the cartography lands in
  the view **automatically**.

  784 built the correlation and the bulk registration — `buildReadSet`,
  `buildLandingMap`, `register_payloads_from_manifest` with full ordered spans,
  `validate_extraction` — and then **decided against the automatic direction this
  slice assumed** (784 §4): *"No full-emulation bulk extraction as the default —
  emulation is the validation oracle / physics-blocked fallback, never the default
  bulk path."*

  The reason is not taste, it is the Pawn belastungstest. Attributing landed bytes
  to the sector under the head at write time **was the exact bug class the
  automation was meant to catch**: all 78 "landings" attributed to T35, when they
  were the copy-loader relocating already-loaded bytes while the head idled on the
  last chain block. So the extraction now comes from a per-project extractor
  written off the loader disassembly, and the trace only validates it — drive-side
  truth (`BLOCK_READ`), not time correlation.

  **What survives:** `loader-events` as first-class records. That was never this
  spec's subject — it is the pointer model of **Spec 750**, which is where it now
  lives. Nothing else of 748.3 is outstanding.

## Cross-links

- BUG-032 (record/reconcile discipline) — 748.1 ships the steering vehicle; 748.2 the
  enforcement.
- BUG-031 (disk-layout overlays payload `medium_spans`) — 748.3 is the automation that
  feeds it from a trace instead of manual `register_payload`.
- `docs/agent-doctrine.md` (repo-level doctrine) + `agent_onboard` (project memory)
  are the existing steering surfaces; 748.1 adds the project-scoped, file-backed layer.
