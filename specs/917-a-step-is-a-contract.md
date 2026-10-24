# Spec 917 — A step is a contract: the plan is agreed at kickoff, the architect writes cards from it, C64RE checks what comes back

**Status:** BUILT on branch spec/917-step-contract (2026-10-24), not merged. S0–S5 green in `e2e-917-cards` (81/0); S6 done on a copy of the owner's Newcomer project (P1 planned, worked by Sonnet workers, verdicts checked by hand, package closed); every S6 finding fixed with a test. Nothing open.
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

## §3 Decisions — all decided (2026-10-24)

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

### D2–D6
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
  - The **position** is new: `architect` | `worker` | `unset` (as first decided; amended below). It decides who may write
    the plan's cards, issue and close them (the architect), and who records against one
    card only (a worker, bound to that card's id).
  - A card names both: `worker (cracker)`. `agent_set_role` takes the position beside the
    role. `unset` is today's behaviour: no cards required, nothing refused.
  - Rejected: `architect` / `worker` as two more domain roles — a worker would lose its
    domain, and a card could not ask for an analyst worker.
  - **Amended after S6 (owner, 2026-10-24): no worker position.** Workers are subagents of
    the same MCP server; the server cannot tell their calls from the architect's, and a
    stored `worker` replaced the architect's position. The position is `architect` |
    `unset`; a worker sets none and names its card in `agent_record_step(card=…)`, which
    records the report as `worker (card <id>)`. The card binding is gone; an agent state
    written with `worker` loads as `unset`.
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
- **D5 — decided (owner, 2026-10-24): the card briefing replaces the phase briefing.**
  - A new prompt `c64re_worker_card(card_id)` renders the worker's card from the graph,
    with the rules every worker keeps: read only what the card lists, change nothing
    outside it, stop on the card's stop lines, report in the fixed form
    (`agent_record_step(card=…, result=DONE|STOPPED, …)`).
  - `c64re_worker_phase` and `buildWorkerPrompt` (`phase-tools.ts`) are removed, with their
    references: `agent_propose_next`'s "Spawn worker subagent for phase N" block, the setup
    text (`setup-cli.ts`), `docs/re-phases.md`, and the smoke `scripts/sprint34-35-smoke.mjs`. `agent_propose_next` no longer proposes
    a worker without a card; with the position `unset` the session works the step itself.
  - Rejected: keeping the phase briefing beside it for the card-less mode — two ways to
    brief a worker, and the open one stays the convenient one.
- **D6 — decided (owner, 2026-10-24): a verdict blocks in exactly two places.**
  - A card whose `requires` names a card that is not KEPT is not issued; the refusal names
    the card and its state (S4).
  - A plan package closes only when every card of it is KEPT and the package's own
    done-when holds.
  - Nothing else is blocked: a report, a finding, `agent_record_step` always go through
    (877 D1 — a door that eats records destroys what the contract asks for).
  - Rejected: reporting only — `requires` and the package would be hints, and the fix on
    an unmeasured cause (P4) goes out again.

**Out of scope, on purpose:** which model runs a worker, token budgets, how many run in
parallel, git and worktrees, "stop after n tool calls". That is the harness and the
owner's own skill; C64RE neither knows the model nor pays the tokens.

## §4 Acceptance

S0–S6 green; the kickoff (`agent_onboard`, the cockpit) asks for the plan; the board row and the doctrine (`docs/agent-doctrine.md`: architect / worker,
the card) follow; the stale `change-validate` block is gone.

## §5 As built (branch spec/917-step-contract, 2026-10-24)

- **Part A.** `src/work/{store,checks,tools}.ts`: plan packages and cards as graph nodes (`plan_package`, `card`,
  edges PART_OF / REQUIRES), producer id `work-plan`; the MCP tools `plan` and `card`; card fields on
  `agent_record_step`; `position` / `card` on the agent state via `agent_set_role`. Test `scripts/e2e-917-cards.mjs`.
- **Part B.**
  - D1: `pickPrimary` takes the plan's step after the project-init and inventory-sync rungs (`src/work/next.ts`):
    `plan-gate` (WAITING, a `human_question` naming the card and its `[human]` lines), `plan-replan` (NOT KEPT or
    STOPPED), `plan-next-card` (open package without a card), `plan-await-workers` (cards issued, not reported),
    `plan-close` (every card of the open package KEPT). Steps are in `workflow-model.ts`; unmapped in the lifecycle
    crosswalk like `ask-human`. Without a plan the ladder is unchanged.
  - P5: `change-validate` is handed out with `runtime_feature_run`; `blockedUntil` is no longer set by any step and its
    special cases in `agent-step.ts` are gone.
  - D5: prompt `c64re_worker_card(card_id)` (`src/work/briefing.ts`); `c64re_worker_phase` and `buildWorkerPrompt` are
    removed with their references; `agent_propose_next` and `c64re_whats_next` list issued cards for an architect and
    propose no worker otherwise.
  - S0: `agent_onboard` prints "No plan yet" with the check vocabulary when a contract exists and no plan does, and the
    plan standing (`plan show`) when one does. `KICKOFF_QUESTIONS` is the contract_set field list, so the plan question
    lives in onboarding only.
  - Docs: `docs/agent-doctrine.md` (onboarding step 8, "Architect and worker"), `docs/re-phases.md`,
    `docs/wiki/Planning-with-Cards.md`.
- **Decisions the build made.** One verdict row per card (claim `verdict`), the history of verdicts in the card's
  `history` attrs. `plan close` takes `by` + `why` when only a `[human]` package line is left. The position is stored in
  the project's agent state (`knowledge/agent-state.json`). The next step looks at the lowest-order open package only; a
  package with cards that are all KEPT is "close" (the architect may issue another card instead).
- **S6 run (2026-10-24, a copy of the owner's Newcomer project, 15 D64).** Kickoff with the owner: contract + 7-package
  plan (EF3/EFXL port). P1: four cards (c1 register, c2 medium, c3 context, c2b re-plan), Sonnet workers, the architect
  checked each verdict by hand: c1 WAITING → KEPT by the owner's gate, c3 KEPT, c2 STOPPED on its stop line (correct),
  c2b KEPT, c2 superseded by c2b, P1 closed with all four package lines PASS. `requires` refused c2 before c1 was KEPT. What the run found, each fixed with a test:
  - a `[contract]` line naming an unstated promise passed forever — refused at plan set / card issue / evaluation;
  - stale views ranked above the plan and hid a STOPPED card — only untracked files / unimported manifests come first;
  - a re-planned card had no way to replace the STOPPED one, so the package could never close — `supersedes`
    (issue) and `card supersede`; the old card is SUPERSEDED, `requires` follows to its replacement;
  - the plan standing omitted STOPPED cards, onboarding omitted the position, and a re-plan step offered a
    human-gate branch with no card waiting;
  - outside 917: `list_artifacts` walked `analysis/` instead of reading the registry (no media, no ids, no
    `project_dir`); a D64 without a BAM was refused by every reader (only G64 had been made tolerant); a D64 data disk
    was judged a custom-GCR candidate; media in a subfolder such as `disk/` were invisible to init and the scan — the first `project_init` now registers media in the user's folders where they are (a re-run does not look; moving broke paths into the folder, copying made one file two artifacts — both tried, both broke smokes).
- **Added after S6 (owner, 2026-10-24): usage per run.** The harness reports a subagent's tokens, tool calls and
  duration to its parent only, so the architect records them: `card` action `usage` (worker run, any card state —
  superseded runs cost too) and `plan` action `usage` (the architect's own run on a package). `plan show` sums per
  package (worker / architect, by model) and in total; `card show` lists each run. S6 numbers: P1 279k (4 workers),
  P2 1.44M (architect 310k Opus + 14 workers 1.13M Sonnet; re-plans 35 % of the worker total).
- **P2 run (an Opus architect subagent, 14 Sonnet workers, 1.44M tokens; the owner closed P2 at the human gate).** Its
  findings outside 917, each fixed with a test RED→GREEN: `extract_disk`'s rebuild by-products counted as unregistered
  (now not debt, never payloads); a document demand only met through a boundary name (a document titled as the demand
  answers it); a load over a KERNAL vector ($0302-$0333) now names the entry and the vector bytes are data; an alias onto
  a generated routine no longer seeds the next analysis (it pinned a wrong decode and rejected the real entry); entry
  points outside the load window are refused, naming the hex/decimal mix-up; a raw analysis file gave its payload a
  second owner (`main_0801_0801`) and a render after `graph_remove_owner` did not re-seed control flow; the 1541 DOS ROM
  table held 96 labels and seven invented rows (now 1108 from the source). Old projects keep a doubled owner until
  `graph_remove_owner` on it. Decided after it (owner): a boot stage registers before data-geometry when its loader is
  on record (`register_payload` `boot_stage`: loaded by the KERNAL = its span starts a directory file, or by a
  boot-stage payload registered before it); game payloads still wait; the check vocabulary had no "no node at X" — decided (owner): `max` beside `min` on graph lines, `max: 0` = none left.
- **D3 amended after S6:** no worker position (see D3). In S6 workers already reported by `card=` without one.
