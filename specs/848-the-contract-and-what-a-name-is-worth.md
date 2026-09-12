# Spec 848 — The contract, and what a name is worth

**Status:** BUILT — `npm run e2e:848-contract`
**Branch:** `spec-847-documents-declare`
**Repo:** C64RE
**Origin:** the first unattended run, and the owner's correction of its premise:

> "Ne moment, ich würde ja schon klar sagen was ich erwarte BEVOR ich weggehe."

and, on what the run actually produced:

> "Er MUSS SEMANTISCH disassemble machen und dabei die Synthese wegschreiben."

## 1. What the run showed

An agent was given four Neuromancer disks, a scope, and no mention of Specs 844–847. In
27 minutes it produced 273 entities, 209 findings, 21 extracted payloads, a complete
static model of the fastloader and the save path — and:

```
routine nodes:        0
annotation files:     0
coverage:         99.2 %
NAMED:             0.0 %
```

It understood a great deal and named none of it. The understanding went into 140
`hypothesis`-kind findings as prose. Meanwhile Ultima VI, months of attended work, reads
30.2 % coverage and **78.9 % named**. Coverage alone ranks the unattended run above it.

And one thing jammed, in a way neither spec could have predicted alone. The agent hit
844's S4 gate, complied, and filled five slots with `slot_record` — which wrote its
evidence as prose and left every one of those findings `ungrounded`. Spec 752's L1 rule
then saw nine of them and parked the step recommender on "run analyze_prg" for the rest of
the session. Rule 8 — *"source exists but has no annotations"* — was true the whole time
and was never reached.

**The more correctly the agent followed one spec, the harder it jammed another.**

## 2. Decisions

**D1 — The contract.** What the human expects, written once before leaving, in the
vocabulary the checks already speak. It asks about DELIVERY, never about FACTS: at a
kickoff nobody knows whether the game saves or where free RAM is — that is the work, and a
contract that asks collects a guess and then wears it like a finding. It may demand LESS
than the default: 844's slot list is a template, not a law, and a game with no save owes
no S10. It is also where the three numbers nobody had finally live — the coverage
threshold, the runtime ratchet and the orphan ratio were global defaults picked blind.

Precedence: a contract the human wrote > an env override > the default.

**D2 — Named-ness is its own measure.** Coverage asks how many bytes sit inside a known
RANGE. This asks how many things carry a name a human would recognise. A machine name
(`unknown_3E00_41D8`, `addr_0006`, `W9000`) does not count.

**D3 — A blocker may veto; it may never decide.** The step recommender was a hand-ordered
cascade of thirteen rules returning one primary, where the top entry could be permanently
unsatisfiable. Rule 7b now vetoes the RUNTIME branch — which is what Spec 752 L1 always
meant, since annotation is static work that would improve the grounding it complains about
— and states the cure instead of repeating the trigger. **A rule whose recommendation
cannot repair its own trigger is an infinite loop by construction.**

The invariant, asserted in the e2e: *while any step can advance, the primary is a step and
not a complaint.*

**D4 — `slot_record` grounds what it writes.** Its evidence goes into `evidence[]`, and the
slots that are not claims about bytes (S1 context, S13 evidence standard, S14) are marked
`not-artifact-scoped` rather than left looking like unfinished work. That is a carve-out in
L1's own words — *"every finding about a file/payload"* — not a loophole.

**D5 — The contract is handed over first.** `agent_onboard` leads with it, before the
refutations and the model, because it is the frame the rest is judged against.

## 3. Three corrections the real data forced on D2

Named-ness was measured wrong three times before it was measured right, and each attempt
failed on something no synthetic fixture contains.

**`payload` cannot count.** A payload node is named after its directory entry — `a`, `i`,
`01_neuromancer` — and spans the whole file. One of them reported a project 100 % named
while 176 of its 208 nodes carried machine names.

**The layers must be merged by id first.** The graph stores one id in up to two rows; the
machine layer carries `owner` and the extent, the human layer carries the name an
annotation gave it. Ultima VI holds 1853 routine nodes: 799 with owner+extent, 978 with a
real name, **zero with both**. A query joining on owner can never see a name.

**It is counted per NODE, not per byte.** An annotation gives a name and a start address,
never an extent — all 978 named routines in Ultima VI carry `end_address = null`.
Measuring bytes, because coverage measures bytes, reported 0 % for a project with 978
named routines.

## 4. Built

| File | What |
|------|------|
| `src/contract/contract.ts` | D1. Load, save, defaults, and the kickoff questions C64RE supplies for the harness to ask. |
| `src/slots/state.ts` | D2 + the contract's slot set and coverage threshold. |
| `src/server-tools/agent-step.ts` | D3. |
| `src/server-tools/slots.ts` | D4. |
| `src/server-tools/agent-workflow.ts` | D5. |
| `src/server-tools/contract.ts` | `contract_show`, `contract_set`, on the DEFAULT surface. |
| `src/critic/run.ts`, `runtime-ratchet.ts` | The verdict and the ratchet read the contract. |
| `scripts/e2e-848-contract.mjs` | 19 cases, fixtured on the real run's signal shape. |

## 5. The validation run

Same four disks, same folder, **the same prompt word for word** as the run in §1. The only
difference was the machinery, and the contract — which said nothing the prompt said.

| | run 1 | run 3 |
|---|---|---|
| annotation files | 0 | 5 |
| named routines | 0 | 40 |
| **NAMED** | **0.0 %** | **39.3 %** |
| model boundaries | 2 | 9 |
| declared documents | 0 | 1 |
| slots filled | 7 | 9 |
| entities / findings | 273 / 209 | 634 / 287 |

It missed the contract by 0.7 points, and its own closing plan reads *"danach ist auch die
40-%-Namensquote erledigt"* — planning against a number that was never in its prompt. It
also reported, unprompted, that `save_finding` marked a finding UNGROUNDED and it re-saved
with `artifact_ids`; that `project_critique` said not-ready and it removed the overlapping
and empty boundaries it had made itself; and that S11 stayed a hypothesis because no
runtime was reachable — its own words in the slot: *"NOT established — nothing has been
run, so no byte has been shown free"*. That is the discipline four corpus projects failed.

### 5.1 The re-entry test

A second session, fresh, was dropped into the finished project and asked six questions
about the game under one rule: **do not re-analyse anything**. It answered all six from the
project alone in ten tool calls — the boot chain with addresses, the single disk gateway
at `$4BEC`/`$4BEE` with its calling convention, four save slots of 2301 bytes, the
container format, no copy protection.

Its answer to "what is still uncertain, and how do you know" is the one that matters: it
found that nothing had ever been executed, that S11 was explicitly not established, that
two boundaries were empty, and that an earlier claim had already been retracted. **The
memory carries the uncertainty, not only the assertions.**

And it found the worst defect of the day, which was mine.

## 6. What the run cost me to learn

**Every read tool built across 845–848 was throwing its report away.** They paired the
formatted text with a `structuredContent` summary, and the client shows only the
structured half. `model_read` — the one tool built for exactly that re-entry — returned
`{"boundaries":9,"orphans":121,…}`. Counters instead of the model. In the session's words:
*"das eine Tool, das für genau diesen Einstieg gebaut ist, ist das einzige, das nichts
gebracht hat."*

`agent_onboard` was never affected, because it returns text and nothing else. That is
exactly why the handover worked while these did not, and it is the rule now: the reader is
a model, the report is the product, and a machine summary that hides it is worse than
none.

**A document demand had to speak the same language as `annotate`.** The run wrote the
document that was asked for and declared it with the ranges it covers; the check compared
the literal word "loader" against `$3E00-$42F9` and reported none existed. The session
named it itself — *"kein Wissens-, sondern ein Deklarationsproblem"*. A role now resolves
through the model to a range, and overlap satisfies it.

**And `createId` is not deterministic, by design.** It appends a timestamp and a random
suffix so two ids made in the same millisecond cannot collide — which meant the
"deterministic" key used for version-decision questions deduplicated nothing, and every
inventory sync filed the question again. The trial ended with 13 open questions of which
11 were this, `04_i` and `02_a` four times each, burying the two that were about the game.
An open question already asking this about this subject IS the question; it is reused.

## 7. Not in this spec

- The saturation guard — "I have recommended this step six times and its completion check
  has not moved". Right shape, needs history the recommender does not keep.
- `workflow-state.json`, frozen at `project_init` in every project and still reporting
  "no source media registered" after 21 extracted payloads. It is either made live or
  deleted; two phase models where one is dead is worse than one.
