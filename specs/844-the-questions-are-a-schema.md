# Spec 844 — The questions are a schema

**Status:** DRAFT — the diagnosis is settled, the slot list is not
**Branch:** `spec-844-completeness`
**Repo:** C64RE
**Origin:** the owner, mid-way into Ultima VI with a project session:

> "Das LLM disassembled auch semantisch, merkt sich aber die Zusammenhänge nicht.
> Ich muss immer wieder auffordern, die Doktrin einzuhalten. Das Merken ist echt ein
> Problem, weil ich von aussen die Dinge in Zusammenhang stellen muss durch meine
> Fragen. **Die Fragen sind aber in allen Multi-Disk-Projekten dieselben, die Dinge
> die es zu mappen und in Beziehung zu setzen gilt sind auch immer die selben.**"

and, on the shape of the fix:

> "Ich weiß aus meinen Projekten bei der Arbeit, dass es einfacher, besser und
> bestimmbarer wird je mehr Determinismus einzieht. Mein Bauch sagt, dass es das für
> C64 RE einfach auch braucht."

## 1. The diagnosis

**Same questions every project ⇒ they are not questions. They are a schema with
empty slots.** A multi-disk C64 game has one shape: boot sector → loader stage 1 →
stage 2 → file index → payload chunks → depacker → resident code → per-area assets.
If that shape is in the graph as REQUIRED slots, "what is still unmapped" is a
query — not something the owner has to remember to ask, every session, from outside.

Two consequences follow, and they are the other two things he named:

**The model does not forget.** `save_finding` and `save_entity` exist and are
OPTIONAL. Nothing requires a relationship to be named before work moves on. A model
that disassembles semantically and stores nothing has not forgotten; it was never
asked.

**Doctrine cannot be enforced by asking.** `docs/agent-doctrine.md` works exactly as
long as somebody reads it aloud, and that somebody is currently him, every session.
Three things shipped this week work without anyone reading anything: Spec 834 makes a
tool refuse without a project, 835 makes an undescribed parameter a gate failure, 839
makes a description that names a non-existent verb a gate failure. None of them asks.

## 2. What constrains the answer — his own rule

Spec 775 already names the boundary, quoting Spec 773's decision #1:

> **"C64RE ≠ 2. LLM-Runtime. Harness redet+denkt, C64RE merkt+zeigt."**

So the LangChain/CrewAI shape — an orchestrator that calls the model — is out. C64RE
may not drive the agent; that is the harness's job, and building a second one here is
the failure mode the product refused on purpose.

775 itself is adjacent and does NOT solve this. It makes the agent/flow layer
**portable** (BMAD grammar) and names the real defect in passing — *"the agent/flow
layer is inert data"*, a roster the UI mirrors and nobody executes. Portable inert
data is still inert. This spec is about making it BINDING.

## 3. Decision — determinism lives in exactly two places

Given §2, there are only two places a rule cannot be talked out of:

**D1 — The tool boundary.** A tool refuses while a precondition is unmet, and says
what is missing. Not a hint, not a suggestion in a description: a thrown error with
the name of the empty slot. This is the 834/835/839 pattern, applied to the workflow
instead of the tool surface.

**D2 — The data model.** A required slot that is empty is a QUERY RESULT. "Done"
becomes computable instead of asserted — which is the same move Spec 833 made for
tool output ("a tool may not claim what it did not do"), one level up: **a project may
not be called mapped while its slots are empty.**

What is explicitly NOT the answer, and is what exists today: a doctrine file, a role
roster, a suggested next step. All three are advisory. `agent_next_step` derives "what
do I do now" from real project state and is useful — but it answers a TO-DO question.
The missing one is a COMPLETENESS question: *for this disk set, these five
relationships are unnamed, here they are.*

**D3 — Deterministic spine, model at the leaves.** "What does this routine mean" is
irreducibly a judgement and stays a model call. What becomes code is the frame around
it: which slots must exist, in what order they can be filled, what evidence each one
needs, and what refuses while one is empty. The graph is code; the nodes are models —
the lesson he brought from work.

## 4. Open — the owner is being asked

**The slot list itself.** Which relationships must a multi-disk game have named before
it counts as mapped? He has run this several times and knows the recurring set; it is
project knowledge, not something to be derived from the code. Without it this spec has
a mechanism and nothing to enforce.

Also open, and smaller: whether an unmet precondition REFUSES or REPORTS. Refusing is
what made 834 work. Reporting is what `check:ui-mcp-delta` does. The right answer is
probably both, split by which slot — but that is a decision that follows the list, not
one that precedes it.

## 5. Not in this spec

- Replacing the harness, or running the model from C64RE (§2).
- Spec 775's BMAD portability. Adjacent, unblocked by this, still its own spec.
- Anything that makes the LLM's semantic reading itself deterministic. It is not, and
  pretending otherwise would be the more expensive mistake.
