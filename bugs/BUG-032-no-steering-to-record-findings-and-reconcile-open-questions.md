# Bug: No steering/persona that makes the agent record findings + reconcile open questions after each action

- **ID:** BUG-032
- **Date:** 2026-06-02
- **Reporter:** llm
- **Area:** mcp-tool / agent-steering (persona / whats-next / orchestrator)
- **Severity:** medium
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->
  <!-- Spec 748.1 shipped the STEERING VEHICLE (<project>/knowledge/steering.md via
  project_steering_set, injected verbatim at the top of agent_onboard). Spec 748.2
  (e2e:748 10/10) ships the ENFORCEMENT half:
  - T1 de-rot: heuristic analyze_prg "Validate: …" prompts (source=heuristic-phase1
    / kind=validation) are hidden from the default question surfaces behind a count
    (isHeuristicQuestion/partitionQuestions); list_open_questions, the dashboard, and
    the next-step candidates surface only the real questions (verified 242→10 real on
    Wasteland_EF).
  - T2 reconcile teeth: agent_propose_next emits a concrete, ID-prefilled reconcile
    step when a real open question's address range overlaps an active finding not yet
    linked to it (save_open_question status=answered answered_by_finding_id=…), so an
    already-answered question no longer rots open. save_open_question gained
    address_range for the match.
  - T3 steering: ensureDefaultSteering provisions the record/reconcile discipline into
    every project's steering.md (injected each agent_onboard).
  Heuristic prompts remain triageable via auto_resolve_questions / archive_phase1_noise. -->

## Environment

- Branch / commit: master
- Surface: mcp full (the whole knowledge loop: save_finding / save_open_question /
  list_open_questions / c64re_whats_next / agent_record_step / agent_propose_next)
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`

## What happened

The MCP has all the knowledge-capture tools (`save_finding`, `save_open_question` with
`status=answered` + `answered_by_finding_id`, `register_payload`, `link_entities`,
`list_open_questions`) but **nothing steers the LLM to use them after each action**. There
is no persona / system-prompt / per-step instruction that says "after an analysis step:
save the finding, link it, and reconcile (answer/defer) any open question it resolves."

Observed symptom in this project:
- The open question *"What does the drive-resident code (B-E track 18) read, and where is
  the copy protection?"* (high prio) stayed **open for days** even though the work had
  **fully answered it** (drive code disassembled, read model proven, protection located).
  It only got `status=answered` when the human noticed it in the Questions tab and asked.
- The agent saved many `save_finding`s during the session but never **linked them to** or
  **closed** the questions they resolved → findings and questions drift apart.
- The Questions tab shows **128 open**, of which ~127 are auto-generated heuristic noise
  ("Validate: RAM region $XX behaves like buffer/mode_flag" from the analyze_prg pass) that
  is never triaged. The 1 real question was buried among them. So the tab rots: real
  answered questions stay open, noise never gets deferred/invalidated.

Net: the knowledge graph goes stale because capture/reconciliation is **discretionary**, not
steered. A human has to manually spot "this is already answered, close it."

## Expected

A steering mechanism so the agent reliably keeps the knowledge graph current. Options
(any/combination):
1. **Persona / system steering**: a standing instruction in the MCP's agent context —
   "after each analysis action, persist the finding, link entities, and reconcile open
   questions it answers (set status=answered + answered_by_finding_id)."
2. **Orchestrator nudge**: `c64re_whats_next` / `agent_propose_next` surfaces *"N open
   questions are now answerable from existing findings — reconcile them"* and *"answered
   question X is still marked open"* as an explicit next action.
3. **Auto-resolve pass**: questions flagged `auto_resolvable` (the field already exists)
   should be re-checked after each disasm/finding and closed when their hint is satisfied.
4. **Autogen lifecycle (per human review — the key one)**: the heuristic questions DO have
   limited value (they flag real RAM regions worth validating) — so don't just dump+delete
   them. Instead:
   - **Tag them `autogen`** (the `source` field already exists: `heuristic-phase1`) and
     render/filter them distinctly from human-review questions in the UI, so the screen
     isn't buried.
   - **Reconcile per pipeline step**: when a file/region/payload is (re)processed
     (analyze_prg / disasm / new finding), the pipeline should **revisit that artifact's
     autogen questions** and **close / update / delete** the ones the new info now answers
     (or supersede stale ones). The `auto_resolvable` / `auto_resolve_hint` fields already
     exist for exactly this — they're just never acted on.
   - Net: autogen questions have a **lifecycle bound to their source artifact**, not an
     ever-growing pile. Otherwise the Questions screen accumulates stale entries and stops
     being meaningful to the human ("der ganze Screen macht keinen Sinn").

### Expected lifecycle (concrete)

```
analyze_prg(file)  → emits autogen questions (source=heuristic-phase1, tag=autogen)
disasm/finding on file/region → reconcile pass:
   for each autogen Q bound to this artifact:
     answered by new finding?  → status=answered (+ answered_by_finding_id)
     superseded / no longer true? → invalidated / deleted
     still genuinely open?      → keep, but stays tagged autogen + correct priority
UI: human-review questions prominent; autogen filtered/collapsed, never burying the real ones.
```

## Repro steps

1. Work a project: disassemble, save findings, register payloads over a session.
2. `list_open_questions status=open priority=high`.
3. Observe: a question fully answered by the saved findings is still `open`; ~all other
   high-prio questions are heuristic "Validate RAM region $XX" auto-noise, untriaged.
4. Nothing in the tool flow prompted reconciliation.

## Evidence

```text
list_open_questions status=open priority=high  → 28 shown of 128 total:
  27 × "Validate: RAM region $XX behaves like buffer/mode_flag"  (auto, c≈0.54-0.58)
   1 × "What does the drive-resident code (B-E track 18) read..." (the real one, c=0.50)
     — fully answerable from the session's findings/disasm, but stayed open until a human
       flagged it; then a manual save_open_question(status=answered) closed it.
```

## Scope guess (optional)

- Agent persona / steering text (wherever the agent system context is assembled for this MCP)
  + `c64re_whats_next` / `agent_propose_next` to include a "reconcile open questions" step.
- Honor the existing `auto_resolvable` / `auto_resolve_hint` fields in a post-disasm pass.
- Re-tier the analyze_prg heuristic questions below `high` (they dominate + bury real ones).

## Notes / follow-up

- This is the meta-cause behind several "why is the UI stale?" observations this session
  (open questions, and relatedly the thin-payload / disk-view gaps BUG-024/BUG-031): the
  capture+reconcile loop isn't steered, so the graph lags the actual understanding.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
