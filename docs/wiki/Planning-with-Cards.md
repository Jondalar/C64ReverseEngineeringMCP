# Planning with Cards

A project is more than one session's afternoon. You and the assistant agree what the
work is, in which order, and what "done" means for each part. Then one session decides
and hands out small, closed tasks, other sessions do one each, and C64RE, not the
worker's own words, says whether a task was kept.

Three levels, each checkable:

- the **contract** says what the project owes (goals, slots, thresholds);
- the **plan** says how: work packages, their order, a done-when for each;
- a **card** is one step of one package, with its own done-when.

## 1. Agree the plan (kickoff)

Once the project has a contract, the assistant asks you for the work packages, their
order and, for each, how you will know it is done. It writes them with the `plan` tool
(action `set`). A package's done-when is a list of checks from a fixed vocabulary:

| check | holds when |
|---|---|
| `graph` | a routine at an address carries a human name; a finding with a tag exists |
| `rebuild` | the listing rebuilds byte-identical |
| `registration` | nothing on disk is unregistered |
| `scenario` | a scenario's verdict, including a test-mode run (the build passes, the baseline fails) |
| `contract` | the contract's standing reaches a threshold |
| `human` | only you can judge it |

Nothing else is allowed to be prose. A line you alone can judge is a `human` line, and
a package or card with one waits for you.

## 2. Two positions

Besides its domain role (analyst, cracker, ...), a session has a **position**:

- `architect` writes cards, issues them and closes packages;
- `unset` is the ordinary session that does every step itself. Nothing is required of
  it and nothing is refused.

Set it with `agent_set_role` (`position`). A **worker** — the subagent that executes one
card — sets no position. It works through the same server as the architect, so a
position of its own would replace the architect's. It names its card in every report
instead, and the report is recorded as that card's worker.

## 3. A card

The architect writes a card for a step of an open package with the `card` tool
(action `issue`). Example:

```text
Card c-07  "Lift bug: measure the cause"      package: fixes
Role       analyst           requires: -
Goal       Know why the lift sticks in level 3 at $0A20.
Read       main_disasm.tas:812-840. Nothing else.
Change     none (a measuring card)
Done when  1 scenario tests/lift-l3.feature ran, verdict recorded      [scenario]
           2 a finding tagged "cause" at $0A20 with evidence          [graph]
Not        no fix, no other level
Stop if    the code at $0A20 differs from the listing

Card c-08  "Lift bug: fix"                    package: fixes
Role       cracker           requires: c-07
Change     fixes/lift.tas: init $47 before $0A20
Done when  1 tests/lift-l3.feature in test mode: baseline fails, build passes  [scenario]
           2 the listing rebuilds byte-identical                              [rebuild]
```

A card belongs to a package, a card outside every package is refused, and a card whose
`requires` names a card that is not yet KEPT is not issued (the refusal names it).

## 4. A worker

The architect hands the card to a worker with the `c64re_worker_card` prompt. The
briefing is the card plus fixed rules: read only what the card lists, change nothing
outside it, start no further subagents, stop on a stop line or when the code differs
from the card. The worker finishes with
`agent_record_step(card, result=DONE|STOPPED, report)`.

## 5. The verdict is C64RE's

On DONE, C64RE runs the card's done-when itself:

- **KEPT** when every line holds;
- **NOT KEPT** when one fails; the answer names the line and what it measured, and the
  card stays open;
- **WAITING (human gate)** when every machine line holds and only a `human` line is
  left. You decide with `card` (action `judge`): kept or not kept, who you are, why.

The worker's report is stored beside the verdict, never instead of it.

## 6. What the next step says

With a plan, `agent_next_step` takes its answer from the plan: a card waiting for you
(it asks you the question, naming the card and its `human` lines), a card that came
back NOT KEPT or STOPPED (re-plan it), an open package without a card (write the next
one), cards out with workers, or a package whose cards are all KEPT (close it with
`plan`, action `close`). `plan` (action `show`) lists everything at a glance.

A card that came back is re-planned with a new card that names it in `supersedes`.
The old card becomes SUPERSEDED: it keeps its report in the history, the package no
longer waits for it, and a `requires` on it now means its replacement.

A package closes only when every card of it is KEPT and its own done-when holds. These
two (an unkept `requires`, an unclosable package) are the only blocks. Reports,
findings and `agent_record_step` always go through.
