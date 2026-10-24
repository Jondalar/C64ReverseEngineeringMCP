# Spec 917 — A step is a contract: the architect hands out cards, C64RE checks what comes back

**Status:** DRAFT (2026-10-24) — §3 open, decided with the owner one question at a time.
**Repo:** C64RE only (meaning and memory: what a step promises and whether it was kept).
TRX64: no change.
**Number:** 917 (registry: `specs/README.md`).
**Origin:** the owner, 2026-10-24, after reading a reporter's private `architect-worker`
skill (an Opus session writes small task cards, Sonnet workers execute one each and report
in a fixed form): *"contracts zwischen den Schritten zu haben und einen Architekten bzw.
Orchestrator macht ja total Sinn."* Part of that skill belongs in C64RE's next steps and
roles; the rest (model choice, token budgets, parallelism, git) does not.
**Depends on:** 730 (the step orchestrator), 848/877 (the contract and its teeth),
916 (a scenario tests a build).

---

## §1 The problem

**Who:** an LLM session working an RE project, and the human who wants it to spend its
effort on deciding, not on exploring. More and more the session is two: one that plans
and decides, and subagents that each do one thing.

**What they want:** a step that says, before it starts, what it must leave behind — and
an answer, after it ends, to "was that kept?" that does not depend on the worker's own
words.

**What happens today** (read from the code, 2026-10-24):

- **P1 — Three hand-offs, none a contract.**
  - `agent_next_step` (`src/server-tools/agent-step.ts`) returns a step id, one tool with
    args, and `completionChecks` — names only (`"change-validated"`), nothing evaluates
    them for this step.
  - `c64re_worker_phase` (`buildWorkerPrompt`, `src/agent-orchestrator/phase-tools.ts:157`)
    writes a briefing whose "Required outputs" are prose ("every non-trivial segment has a
    classification") and whose report is free Markdown with a `Phase N done` heading.
  - `agent_record_step` (`src/server-tools/agent-workflow.ts:645`) takes free strings
    (`step`, `next_action`). The worker's "done" is recorded as said.
- **P2 — The briefing is open.** It names a phase and an artifact and every tool of that
  phase. It does not say what to read, what to change, or where to stop. An open brief is
  what makes a worker expensive and unverified — the reporter measured it (one open
  brief: ~1.1 M tokens for four small fixes; Sonnet with open briefs overran too).
- **P3 — Nobody owns the decisions.** The roles (`AgentRoleSchema`, `agent-state.ts:11`:
  analyst, cartographer, implementer, archivist, cracker) say which domain a session works
  in. None says who decides and who executes, and the worker briefing's "the master
  decides next steps" names a master the role model does not know.
- **P4 — A step's result is not the next step's input.** What a finished step established
  (a cause measured, a routine named, a test red on the old bytes) is not something the
  next step can require. Lesson from the same skill: a fix card went out on a cause read
  but not measured, fixed nothing, and broke a passed check.
- **P5 — A stale block.** `change-validate` (`workflow-model.ts:184`) is
  `blockedUntil: "the code-overlay loop ships"`. It shipped: 911 (variants) and 916 (a
  scenario tests the build). The step that most needs a checkable "done" is the one the
  orchestrator never hands out.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: a card states its done-when as checks C64RE can run
  Given a project with a listing whose routine at $0A20 is unnamed
  When  the architect asks for the next card
  Then  the card names goal, what to read (artifact + range), what to change, and
        done-when as checks from a fixed vocabulary (a graph count, a rebuild, a scenario)
  And   no check is prose that only the worker can judge

Scenario: the verdict is C64RE's, not the worker's
  Given a card whose done-when is "scenario fix-lift: test mode, baseline fails, build passes"
  When  the worker reports DONE but the scenario's build variant fails
  Then  recording the card returns NOT KEPT with the failing check and its output
  And   the card stays open; the worker's claim is kept beside the verdict, not instead of it

Scenario: a card can require what an earlier card established
  Given card A "measure the cause at $0A20" and card B "fix it", B requiring A
  When  B is handed out while A is open or not kept
  Then  B is refused, naming A
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1, P2 | card form + check vocabulary | `scripts/e2e-917-cards.mjs` | by hand (no gates) |
| S2 | P1 | verdict by C64RE: kept / not kept, both ways | `e2e-917-cards` | by hand |
| S3 | P3 | only the architect issues and closes cards; a worker records against its own card only | `e2e-917-cards` | by hand |
| S4 | P4 | `requires` refuses an unkept predecessor | `e2e-917-cards` | by hand |
| S5 | P5 | `change-validate` is handed out, its card's done-when is a 916 test-mode scenario | `e2e-917-cards` + `e2e:916` | by hand, sandbox |
| S6 | all | one real project: the architect plans 3 cards, workers return, verdicts match a re-run by hand | by hand, a copy in `/private/tmp` | — |

## §3 Decisions — open

- **D1 — Who writes the card.** (a) C64RE derives it from project state, the architect
  takes it or edits it; (b) the architect writes it, C64RE stores and checks it; (c) both:
  next step proposes, the architect owns the final text. Leaning (c).
- **D2 — The check vocabulary.** Which done-when checks C64RE evaluates itself. Candidates
  that already exist as code: graph counts (`graph_find`), rebuild byte-identical
  (`disasm_prg` stamp), registration (audit: 0 unregistered), scenario verdict (916 test
  mode), contract standing (877). Is a free-text check allowed at all, marked "human"?
- **D3 — Roles.** New roles `architect` / `worker`, or a second axis beside the domain role
  (an analyst can be either)? The domain role decides tools and gating today; the position
  would decide who may issue and close cards.
- **D4 — Where a card lives.** A graph node (claims, evidence, `requires` as an edge, the
  history for free) or a file under `knowledge/`. Spec 822: the graph is the authority.
- **D5 — The worker briefing.** `c64re_worker_phase` becomes the card renderer, or stays
  beside it for phase work and is retired later.
- **D6 — Teeth.** A NOT KEPT card: only reported (the architect decides), or does it also
  block what requires it (S4) and the phase close (877's door)?

**Out of scope, on purpose:** which model runs a worker, token budgets, how many run in
parallel, git and worktrees, "stop after n tool calls". That is the harness and the
owner's own skill; C64RE neither knows the model nor pays the tokens.

## §4 Acceptance

S1–S6 green; the board row and the doctrine (`docs/agent-doctrine.md`: architect / worker,
the card) follow; the stale `change-validate` block is gone.
