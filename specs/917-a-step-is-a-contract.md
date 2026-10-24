# Spec 917 — A step is a contract: the plan is agreed at kickoff, the architect writes cards from it, C64RE checks what comes back

**Status:** DRAFT (2026-10-24) — D1–D4 decided; D5–D6 open, decided with the owner one question at a time.
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
- **P6 — Nothing between the promise and the step.** The kickoff writes the contract
  (`contract_set`, 848: goal, the slots owed, thresholds) — *what* is owed. Nobody agrees
  with the human *how*: which work packages, in which order, each with its own "done".
  So every step is chosen fresh from project state, and the human sees the plan only as
  the trail of steps already taken.
- **P5 — A stale block.** `change-validate` (`workflow-model.ts:184`) is
  `blockedUntil: "the code-overlay loop ships"`. It shipped: 911 (variants) and 916 (a
  scenario tests the build). The step that most needs a checkable "done" is the one the
  orchestrator never hands out.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: the kickoff agrees the plan, not only the promise
  Given a project with a contract and no plan
  When  the kickoff runs with the human
  Then  a plan is stored: packages P1…Pn, their order, and for each a done-when
        from the same check vocabulary as a card
  And   the architect cannot issue a card that belongs to no package

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

Scenario: a human gate waits for the human
  Given a card whose machine lines hold and whose done-when has a [human] line
  When  the worker reports DONE
  Then  the card is WAITING (human gate), not KEPT
  And   it becomes KEPT only when the human says so, recorded with who said it

Scenario: a card can require what an earlier card established
  Given card A "measure the cause at $0A20" and card B "fix it", B requiring A
  When  B is handed out while A is open or not kept
  Then  B is refused, naming A
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S0 | P6 | the kickoff stores a plan; a card outside every package is refused | `e2e-917-cards` | by hand |
| S1 | P1, P2 | card form + check vocabulary | `scripts/e2e-917-cards.mjs` | by hand (no gates) |
| S2 | P1 | verdict by C64RE: kept / not kept, both ways; a human line waits for the human | `e2e-917-cards` | by hand |
| S3 | P3 | only the architect issues and closes cards; a worker records against its own card only | `e2e-917-cards` | by hand |
| S4 | P4 | `requires` refuses an unkept predecessor | `e2e-917-cards` | by hand |
| S5 | P5 | `change-validate` is handed out, its card's done-when is a 916 test-mode scenario | `e2e-917-cards` + `e2e:916` | by hand, sandbox |
| S6 | all | one real project: the architect plans 3 cards, workers return, verdicts match a re-run by hand | by hand, a copy in `/private/tmp` | — |

## §3 Decisions

Three levels, each checkable by C64RE: **contract** (what is owed, 848) → **plan** (how:
packages, order, done-when per package) → **card** (one step of one package).

- **D1 — decided (owner, 2026-10-24): the architect writes the cards, from the plan.**
  - The kickoff clarifies with the human the contract *and* the plan.
  - The architect writes each card from a plan package. C64RE stores it, checks its form,
    and later checks its done-when.
  - `agent_next_step` no longer proposes steps of its own once a plan exists: it says which
    package is open, which card is blocked (an unkept `requires`), which came back NOT KEPT.
  - Rejected: C64RE deriving cards from project state (an open, generic brief again —
    the state does not know the human's order or what "done" means for this game); next
    step proposing and the architect editing (two authors of one card).

### The card, worked example

```
Card C-07  "Lift bug: measure the cause"          plan: P2 Fixes / lift
Role       worker (analyst)     issued by: architect    requires: C-05 KEPT
Goal       Know why the lift sticks in level 3 at $0A20.
Context    payload ram/main, listing main_disasm.tas:812-840;
           hypothesis (read, not measured): $0A20 reads $47 before its init.
Read       graph_node ram/main:routine:0A20, main_disasm.tas:812-840. Nothing else.
Change     none (a measuring card)
Do         scenario tests/lift-l3.feature from anchor "level3-start", observer on $47 to frame 600
Done when  1 scenario lift-l3 ran, verdict recorded                 [scenario]
           2 a finding tagged "cause" at $0A20 with trace evidence  [graph]
Not        no fix, no other level, no NTSC, no reels
Stop if    code at $0A20 differs from the listing · the anchor is missing
Report     agent_record_step(card="C-07", result=DONE|STOPPED, …)

Card C-08  "Lift bug: fix"                         plan: P2 Fixes / lift
Role       worker (cracker)     requires: C-07 KEPT
Goal       The lift in level 3 runs through.
Read       the finding from C-07, main_disasm.tas:812-840
Change     fixes/lift.tas: init $47 before $0A20 (the value: see the finding)
Done when  1 tests/lift-l3.feature in test mode: baseline fails, build passes  [scenario]
           2 rebuild V1 byte-identical outside the fix window                 [rebuild]
Not        no other test's expected values
```

On DONE, C64RE runs the done-when lines itself and answers KEPT or NOT KEPT; C-08 cannot
be issued while C-07 is not KEPT.

### Open
- **D2 — decided (owner, 2026-10-24): a fixed check vocabulary, plus the human gate.**
  A done-when line is one of:
  - `[graph]` a count or existence in the graph (a routine named at $0A20, a finding
    tagged `cause` with evidence) — `graph_find` / `graph_node`;
  - `[rebuild]` byte-identical rebuild (the listing's stamp, `disasm_prg`);
  - `[registration]` the audit reports 0 unregistered files for the scope;
  - `[scenario]` a scenario's verdict, including 916's test mode (baseline fails, build passes);
  - `[contract]` the contract standing reaches a threshold (877, e.g. named ratio ≥ 0.9);
  - `[human]` free text, judged by the human only — the **human gate**. A card with a
    human line is never KEPT by C64RE alone: when every machine line holds it is
    `WAITING (human gate)` until the human says kept or not kept, and who said it is
    recorded. Nothing else may be prose.
- **D3 — decided (owner, 2026-10-24): a second axis, the position, beside the domain role.**
  - The domain role stays as it is (`AgentRoleSchema`: analyst, cartographer, implementer,
    archivist, cracker) and keeps deciding which tools are proposed and which phase gates
    apply.
  - The **position** is new: `architect` | `worker` | `unset`. It decides who may write
    the plan's cards, issue and close them (the architect), and who records against one
    card only (a worker, bound to that card's id).
  - A card names both: `worker (cracker)`. `agent_set_role` takes the position beside the
    role. `unset` is today's behaviour: no cards required, nothing refused.
  - Rejected: `architect` / `worker` as two more domain roles — a worker would lose its
    domain, and a card could not ask for an analyst worker.
- **D4 — decided (owner, 2026-10-24): in the graph.**
  - Plan packages and cards are nodes; `requires` (card → card) and "belongs to" (card →
    package) are edges.
  - A verdict (KEPT / NOT KEPT / WAITING) is a claim with evidence: the scenario result,
    the rebuild stamp, the graph query and its count, or the human who said it. The
    worker's own report is kept beside it as the worker's claim, never as the verdict.
  - The history (who issued, who reported, who judged, when) comes with the graph; the
    graph tools and the explorer show plan and cards without a new reader.
  - A human-readable view (the plan with each card's state) is rendered from the graph,
    like the other views; it is never the source.
  - Rejected: a file under `knowledge/` — a second store beside the graph, the shape 822
    dissolved.
- **D5 — The worker briefing.** `c64re_worker_phase` becomes the card renderer, or stays
  beside it for phase work and is retired later.
- **D6 — Teeth.** A NOT KEPT card: only reported (the architect decides), or does it also
  block what requires it (S4) and the phase close (877's door)?

**Out of scope, on purpose:** which model runs a worker, token budgets, how many run in
parallel, git and worktrees, "stop after n tool calls". That is the harness and the
owner's own skill; C64RE neither knows the model nor pays the tokens.

## §4 Acceptance

S0–S6 green; the kickoff (`agent_onboard`, the cockpit) asks for the plan; the board row and the doctrine (`docs/agent-doctrine.md`: architect / worker,
the card) follow; the stale `change-validate` block is gone.
