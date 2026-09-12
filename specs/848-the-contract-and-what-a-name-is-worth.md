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

## 5. Not in this spec

- The saturation guard — "I have recommended this step six times and its completion check
  has not moved". Right shape, needs history the recommender does not keep.
- `workflow-state.json`, frozen at `project_init` in every project and still reporting
  "no source media registered" after 21 extracted payloads. It is either made live or
  deleted; two phase models where one is dead is worse than one.
