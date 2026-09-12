# Spec 845 — The model layer

**Status:** DRAFT
**Branch:** `spec-845-model-layer`
**Repo:** C64RE
**Origin:** the owner, on why the Ultima VI HTML model matters and why the HTML does not:

> "Die Doku ist auch im Grunde egal, weil das Modell durch die Arbeit davor und die
> Zusammenfassung dann das Wesentliche im Kontext hat. Aber genau davon wollen wir ja
> weg: es SOLL NICHT NUR im Kontext sein, sondern **persistent**, damit es nach 3 mal
> compact oder /new auch weiter den Zusammenhang sieht → Graph."

and, on what he wants to do with it:

> "Ich WILL mich wegrationalisieren in der Analysephase. Ich will am Anfang den Scope
> setzen und dann wieder kommen, wenn es die volle Analyse gibt bzw. der 1. PoC läuft."

## 1. What this is not

Not a document, not a renderer, not the HTML. Spec 844 §4 answered "which relationships
must be named"; this one answers "in what SHAPE do they survive a `/new`". The render is
downstream of both and is not in this spec.

## 2. The measurement

The Ultima VI session, driven by the owner's ten questions, produced a model of 177
nodes and 178 edges over three levels (`container` / `component` / `code`), grouped into
three groups, with **a citation on every single node and every single edge** — 0 of 355
uncited.

That project's own graph, at the same moment:

| | graph.sqlite | the session's model |
|---|---|---|
| nodes | 11 161 | 177 |
| edges | 24 780 | 178 |
| owners / groups | 854 | 3 |
| edges carrying evidence | 23 399 (94 %) | 178 (100 %) |
| **nodes carrying evidence** | **0** | **177 (100 %)** |
| hierarchy | `CONTAINS`, 2 083 edges, all `routine → label` | 3 levels with `parent` |

Three things follow, and only the first was expected:

**The coarse level is missing, not a parent pointer.** 11 161 nodes is not a model, it is
an index; it does not fit in a session's head after a `/new` and re-reading it is as
expensive as re-deriving it. The session's 177 nodes fit because they sit one level ABOVE
the graph's granularity. `CONTAINS` cannot carry that: it already means intra-routine
structure (routine → label), and overloading it would make "what contains what" ambiguous
at exactly the moment it has to be unambiguous.

**Node citation is the gap, not edge citation.** The opposite of what this spec was
expected to say. 94 % of edges already carry evidence; the `nodes.evidence` column exists
and is empty on all 11 161. So a fresh session that reads a node gets no reason to believe
it and has to join out to the findings — or, more likely, re-derives it.

**Groups: 854 against 3.** `owner` is the producing run's stem, which is a provenance
axis, not a semantic one. Nothing in the graph says "these forty routines are the loader".

## 3. Decisions

**D1 — A model layer above the graph.** Coarse nodes with an explicit `level`
(`system` / `container` / `component`), each with an address range, and membership
resolved to the fine nodes underneath. It is a LAYER, not a replacement: the 11 161 stay
exactly where they are, and the model layer is what a re-entering session reads first.

**D2 — Boundaries are asserted, membership is computed.** "The engine lives at
$0200-$437E" is a judgement and stays a model call. Which of the 1 853 routines fall
inside it is address containment and is arithmetic. This is Spec 844 D3 one level up:
the spine is code, the nodes are models. It also makes the layer cheap — asserting a
dozen boundaries indexes eleven thousand nodes.

**D3 — Every model node carries its citation.** Not by joining to a finding: on the node,
the way every edge already does it. A model node without evidence is refused at the door
that creates it. The corpus reason is in 844 §4.2 — a claim nobody can check is the one
that costs a rebuild when the next session inherits it.

**D4 — Container edges are rolled up, and inherit their evidence.** If a routine inside
container X calls a routine inside container Y, then X → Y, and the fine edges ARE the
citation. Derived, so it cannot drift from the graph; cited, so it cannot be doubted for
free.

**D5 — Orphans are a query result.** A fine node that rolls up into no container is
visible, and the count is a finer completeness measure than 844's S12 byte coverage:
S12 asks how many bytes are inside a known range, D5 asks how many are inside a NAMED
one. Both may be answered; neither may be asserted.

**D6 — One re-entry read.** A single call returns the whole model: containers with their
citations, the rolled-up edges between them, what is still open, and the REFUTATIONS.
The refutations matter most here — six of them in Ultima VI, each one stopping a rebuild
down a path already known to be wrong. Re-reading is cheap; re-deriving is what we are
paying for.

## 4. Open

**How the coarse boundaries get asserted in the first place.** A tool the model calls is
the obvious answer, and 844's `slot_record` is the shape. But several containers ARE
slots — S3's boot stages, S5's runtimes, S8's engine — so the two may be one door rather
than two, and that decision changes both specs.

**Whether `level` is three values or open.** The session used three. Three is enough for
a C64 game and a closed set is checkable; an open set survives contact with a cartridge
whose bank structure is a fourth level.

## 5. Not in this spec

- The critic and the verdict — contradictions, gaps with `nextRead`, a computed
  `readyToDesign` that may say no. That is the unattended-run half and its own spec.
- The render. It is downstream of this and of the critic, and the owner has said plainly
  that the HTML itself is beside the point.
- Anything that drives the model from C64RE. Spec 773 decision #1 still holds.
