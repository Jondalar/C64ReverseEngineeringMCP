# Spec 846 — The critic

**Status:** BUILT — `npm run e2e:846-critic`
**Branch:** `spec-846-critic`
**Repo:** C64RE
**Origin:** the owner, on what he actually wants from the analysis phase:

> "Ich WILL mich wegrationalisieren in der Analysephase. Ich will am Anfang den Scope
> setzen und dann wieder kommen, wenn es die volle Analyse gibt bzw. der 1. PoC läuft."

## 1. What is missing, precisely

Three things stop being present when he leaves. Two of them are built:

| | what he was | built |
|---|---|---|
| the FRAME | his ten questions | Spec 844 — the fourteen slots |
| the MEMORY | the one who saw the connections | Spec 845 — the model layer and its re-entry read |
| the **COUNTER-PRESSURE** | the one who did not believe "create.prg writes nothing" | **this spec** |

Spec 844's ratchet counts runtime calls that leave no record, and that is not
counter-pressure — it is satisfiable with `save_finding("looked at $4100")`. While he is
watching, a cheap record is obvious. Unattended, it is indistinguishable from work. A
counter is not an adversary.

The Ultima VI session built the adversary itself, once it was asked: `contradictions[6]`,
each naming which document was wrong and which was right; `gaps[14]` with a severity and
a `nextRead`; `readyToDesign: false`. Five documents were rewritten as a result, with
nobody standing over it. So the shape is known. What it needs is a home that does not
require a human in the room.

## 2. The part that needs no model at all

This spec's central claim, and the reason it is worth building before the interesting
half: **most of what he caught is mechanically checkable.**

The corpus law from 844 §4.2 — *a scan proves presence, never absence* — cuts both ways.
A negative claim is hard to ESTABLISH by scanning. It is easy to REFUTE by scanning,
because a single contradicting edge is enough. Ultima VI's four false negatives each cost
a rebuild, and every one of them is refutable against that project's own graph:

| the claim | what the graph holds |
|---|---|
| "`$F3` is read by nothing, exhaustive scan" | `USES_ZP` edges into `$F3` |
| "`$4800-$53FF` is unreferenced" | edges landing inside that range |
| "only `$3E83` writes to disk" | other write edges to the same target |
| "create.prg writes nothing" | the store the grep missed |

The check is not "is this claim true" — that needs judgement. It is "this claim is
NEGATIVE and the graph contains a counter-example", which is decidable, high precision
when it fires, and carries its own evidence: the offending edge.

**D1 — The negative-claim detector.** A finding whose text makes a universal negative
("nothing reads", "never called", "unreferenced", "is not used", "only X writes") is
matched against the graph for a counter-example. One counter-example is a CONTRADICTION,
reported with the edge that proves it.

Its limitation is stated rather than hidden: the claim is recognised by phrasing, the
same way 844's S12 vocabulary gate works, so unusual wording escapes it. A check that
catches four out of five confident false negatives at zero cost is worth having; one
pretending to catch all five is not.

**D2 — Six more checks that need nothing but the graph.** Each declares its own severity
(D3) and each must produce the record that proves it, never a bare assertion:

| check | finds | severity |
|---|---|---|
| negative claim refuted (D1) | a standing claim the graph contradicts | **blocking** |
| refutation without a casualty | a `refutation` finding whose target still stands as active | **blocking** |
| finding without evidence | the cheap record — 844's ratchet leak, closed | important |
| overlapping boundaries at one level | two 845 containers claiming the same bytes | important |
| empty boundary | a boundary asserted over nothing | important |
| orphan ratio above threshold | model asserted but most of the graph outside it | important |
| unreachable routine | no incoming edge and not an entry — dead code, or a missed seed | nice-to-have |

"Refutation without a casualty" deserves its severity. Ultima VI's `amended[5]` records
which documents a refutation forced to be rewritten; a refutation that invalidated nothing
either was not acted on, or the thing it refuted is still being believed somewhere. Both
are exactly the state this whole arc exists to prevent.

**D3 — Severity belongs to the CHECK, not to the instance.** The calibration risk is real:
a critic that finds nothing is worthless and one that finds everything blocks. The answer
is not to judge each finding's importance — that is a model call and would be arbitrary
and unauditable. It is to declare, once, per check, what its findings mean: **blocking**
means a downstream claim is unsafe while it stands; **important** weakens the model;
**nice-to-have** is hygiene. The table above is the whole calibration surface, and it can
be argued with.

## 3. The verdict

**D4 — `readyToDesign`, computed, allowed to say no, and it names what would flip it.**

Ready when: every required 844 slot is filled or `n/a`, no blocking critic finding stands,
and coverage is at or above its threshold. Anything else is not ready, and the answer
carries the list — which is the difference between a verdict and a timer.

This replaces nothing: 844 already has `checkPhaseComplete`, and it becomes this. One
question, one answer, one place.

The second return trigger the owner named — *"der 1. PoC läuft"* — is mechanically
cheaper and is NOT this: something runs and produces an expected result. It belongs with
the scenario chain (810–814), not here.

## 4. What is handed over rather than run

**D5 — C64RE never calls a model.** Spec 773 decision #1 holds: *"C64RE ≠ 2.
LLM-Runtime. Harness redet+denkt, C64RE merkt+zeigt."*

The resolution is narrower than it first looked, and it is the whole reason this spec is
allowed to exist: there is a field between REFUSING and DRIVING, and it is ASKING. Handing
the harness a question is not running the model. So the critic has two halves:

- what the graph can decide, C64RE decides (D1, D2)
- what needs reading prose against prose, C64RE **formulates as a question** and the
  harness answers, returning records through the ordinary doors

C64RE holds the schedule, the checks and the verdict. It never holds a model client.

**D6 — `settleBy` gets a carrier.** An open question that does not name the instrument
which would settle it is, after a compact, only a bad conscience. Spec 845 named this as
NOT built because `OpenQuestionRecord` has no tag carrier; this spec adds the field.
Every gap the critic raises carries it, because the critic knows which check produced the
gap and therefore what closes it.

**D7 — When it runs.** On demand (`project_critique`), and as the answer to "is this
done". Not on a timer and not in the background: a critic that runs unasked either burns
budget or trains the session to ignore it.

## 5. Built

| File | What |
|------|------|
| `src/critic/negative-claims.ts` | D1. Five claim shapes, including `only $X writes`, and the counter-example query per verb class. |
| `src/critic/checks.ts` | D2/D3. The seven checks, each with its severity, what settles it, and why that severity. |
| `src/critic/run.ts` | `critique()`, `verdict()`, and D5's `handoverQuestions` — questions, never a model call. |
| `src/server-tools/critic.ts` | `project_critique` and `critic_checks`, both on the DEFAULT surface. |
| `src/slots/gate.ts` | D4. `checkPhaseComplete` is now the verdict: slots AND blocking findings AND coverage, naming every blocker. |
| `src/project-knowledge/types.ts`, `src/knowledge-graph/records.ts` | D6. |
| `scripts/e2e-846-critic.mjs` | 22 cases. |

The test fires D1 at Ultima VI's three address-shaped false negatives and the graph
refutes all three, while the one true statement in the same set is left alone — precision
is the property that matters here, and the test asserts it explicitly.

**D6 was smaller than Spec 845 recorded.** `saveOpenQuestion` has always persisted
`attrs.tags`; only `listOpenQuestions` dropped them on the way back out. So there was a
carrier all along and 845's note that there was none was wrong. Surfacing the field was
the whole change.

**Two corrections the test forced:**

`empty-boundary` and `orphan-ratio` were skipped when a project had no boundaries, and
vanished from the "checks run" list with them. A check that disappears when it has nothing
to look at is exactly what makes a quiet report unreadable — you cannot tell "found
nothing" from "never ran". They are now always listed.

The `only $X writes` refutation printed the claimed address as the place the counter-edge
landed, which is not what it found. It now names the other doer: *"$4A10 also does it:
WRITES edge $4A10 -> $DD00, the same target $3E83 reaches"*.

### 5.1 First run against a real project

Ultima VI, read-only, its graph byte-identical afterwards. 73 ms for the critic, 189 ms
for the slot report over 11 161 nodes.

**Two bugs the synthetic test structurally could not find.**

`USES_ZP` edges point at PLATFORM ids (`c64:zp:00f3`) which are not rows in the project's
`nodes` table — the graph schema says so outright, and the check joined on `nodes`. It
therefore could not see any of that project's 4 970 zero-page edges, which is exactly the
class that refutes "`$F3` is read by nothing". The check missed the claim in the very
project whose rebuild it cost. Single-address claims now also match on the id suffix.

The object-position negative did not parse. Ultima VI's actual wording was *"create.prg
writes nothing"*, and only "nothing writes" was matched.

With both fixed, all four of that project's historical false negatives are refuted against
its own graph, each naming the edge, and the one true statement in the same set is left
alone. The regression cases are in the e2e, including an edge whose target deliberately
has no local node.

**What the critic found in the live project:** six blocking findings, all
`refutation-without-casualty` — none of Ultima VI's six refutations records what it
invalidated. That information exists; it is in the `amended[5]` list inside an HTML file,
not in the graph. Twenty-five `unreachable-routine`, almost all drivecode entry points the
C64-side graph cannot link to. Zero `finding-without-evidence`: that project's records all
carry their proof.

**And the coverage denominator was nonsense.** It summed the `fileSize` of all 321 (of
2 454) registered artifacts — 27 MB of generated `.asm` text, 23 MB of internal files —
and unioned address ranges across every artifact at once, as though `$2000` in one overlay
were the same byte as `$2000` in another. That capped the ratio at a few percent
structurally and reported 0.1 %. Coverage is now computed PER OWNER over loadable
artifacts only: **30.2 % of 1 641 238 bytes**. A number, where there was noise.

## 6. Open

**The prompt shape for the handed-over half.** The deterministic checks can be specified
here; what a prose-against-prose contradiction pass should ASK cannot be, before it has
been tried on a real project. Ultima VI's six contradictions are the only sample, and one
sample is a shape, not a spec.

**The orphan ratio.** Like 844's coverage threshold and its ratchet limit: a number nobody
has. Decidable on the first project that runs the check, not before.

## 7. Not in this spec

- Running the analysis loop itself. The critic is an instrument, not a driver.
- The render — the HTML model. Downstream of this, and the owner has said the document
  itself is beside the point.
- The PoC return trigger. Scenario chain 810–814.
