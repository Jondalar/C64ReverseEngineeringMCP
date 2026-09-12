# Spec 844 — The questions are a schema

**Status:** BUILT — D1, D2, D4, D5. `npm run e2e:844-slots` + `npm run e2e:844-teeth`
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

## 3. Decision — where determinism can live

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

**D4 — A citation must RESOLVE, not match.** The read-before-runtime gate that already
exists was cited to the owner as precedent for a door with teeth. He read the predicate
and answered in one sentence: *"was ist denn die Hypothese ohne die verweigert wird?
doch einfach Text"*. He is right — `discipline-gate.ts` checked a `$XXXX` regex and
twenty characters of prose, so `hypothesis="$C000 the loader probably copies the payload
there"` passed on pure invention. A citation with teeth resolves against records the
project already holds — routine nodes, findings, entities, graph nodes — all of which
are produced by reading. A model cannot invent one that is already there. **The resolver
is dormant while the project holds no analysis**, because a gate that fires before there
is anything to cite bricks day one, which is worse than no gate.

**D5 — The accrual ratchet.** §4 catches "a slot is empty". It does not catch what the
owner actually had to break by hand: the Ultima VI session that ran runtime → build →
runtime → build and would not come out until he forced it back to reading, analysing,
documenting, concluding. No slot was violated there; work was happening and nothing was
ACCRUING. So: count gated runtime/build calls since the durable record count last grew,
and past a threshold the doors refuse and ask what those runs established. The way OUT
is to write something down — including a NEGATIVE result, which S14 wants anyway. The
count is derived by comparing the graph's record counts, not by hooking `save_*`, so a
record written by any path at all releases the gate. Ultima VI measures the same thing
after the fact: 39 of 41 findings on one date, two from the fifty-commit arc that
followed.

## 4. The slot list

Answered by the owner, and cross-checked against seven finished projects — Accolade
Comics, Brubaker, Fire King, Lykia, Wasteland, Neuromancer, Ultima VI — each read by an
isolated agent that was asked what actually mattered in the reverse engineering. Ten of
the slots are his list verbatim. Four came out of the corpus: the projects failed on
them repeatedly and never once wrote the failure down as a slot.

A slot is: a NAME, the EVIDENCE that fills it, whether it is required for every project
or only under a condition, and what happens while it is empty. The last column is the
§3 open question — REFUSE or REPORT — decided per slot rather than globally, which is
what the list makes possible. REFUSE means a tool throws with the slot name in the
message. REPORT means it appears in a completeness query and in `agent_next_step`.

### 4.1 The slots

| # | Slot | Filled by | Required | Empty ⇒ |
|---|------|-----------|----------|---------|
| S1 | **Context** | The game's identity: c64-wiki (or equivalent) URL, year, publisher, how many disk sides / what cartridge. One link is enough — he said so, and no project in the corpus ever recorded it. | always | REPORT |
| S2 | **Medium** | The media set as artifacts: every d64/g64/d81/crt/tap, which one boots, and for G64 whether the GCR is standard or custom. | always | REFUSE — the payload doors already do this (`extract_disk*`), the slot makes it visible instead of a surprise |
| S3 | **Boot chain** | Each stage named with its entry address and what hands over to what: disk = BAM + directory + KERNAL stub → stage 2; cart = cold-start vector → first resident. Fully disassembled, not "it loads something". | always | REFUSE |
| S4 | **Data geometry** | Where payloads sit and how they are addressed — track/sector list, LUT, chunk table, file index — plus per payload its packing and the identity of the depacker that reads it. | always | REFUSE for payload registration |
| S5 | **Runtime count** | How many resident images exist, each with the address window it occupies. One is an answer; so is nine. | always | REPORT |
| S6 | **Runtime linkage** | With more than one: who loads whom, over which shared RAM they talk, at which address the handover happens. His own note — more than one runtime is itself the indicator that a loader exists. | when S5 > 1 | REFUSE |
| S7 | **Engine presence** | His inference rule, made a slot: *structured reloading without a per-level runtime ⇒ there MUST be an engine.* The slot holds either an engine at a named address or an explicit refutation of the rule for this game. It may not be silently skipped. | when S4 shows structured reload and S5 shows no per-level runtime | REFUSE |
| S8 | **Engine architecture** | The dispatcher, the main loop, the subsystem table — and, where one exists, the script/bytecode VM with its opcode set. This is where the corpus is sharpest: Accolade's SQ bytecode VM and Brubaker's `$1D5C` interpreter with 36 opcodes were each the finding that unlocked everything after them. | when S7 says an engine exists | REPORT, then REFUSE at the phase gate |
| S9 | **Modules** | The module inventory: id, load address, who loads it, who frees it, how long it lives. "Loaded" without "freed" is half a slot and counts as empty. | when the game has modules | REFUSE |
| S10 | **Save model** | What the game persists, of what types, how often, and to what place — track/sector or file. | when the game saves | REFUSE |
| S11 | **Memory map / free RAM** | Every free-RAM claim carries HOW it was established. Read-derived is a hypothesis; only a run confirms or falsifies it. Four corpus projects made this claim from reading and all four were corrected by running — it is the single most repeated failure in the set. | always | REFUSE for anything that allocates (overlay, injection, cart bank) |
| S12 | **Coverage** | Bytes accounted for against bytes present, per artifact — computed, never asserted. Neuromancer's documentation says EXHAUSTIVE at roughly 15 % coverage. The words "complete", "exhaustive" and "fully mapped" are claims about this slot and are refused while it is below its threshold. | always | REPORT, and BLOCK the completeness vocabulary |
| S13 | **Evidence standard** | Per project: which instrument counts for which kind of claim. Fire King and Brubaker both carry a `substrate-verdict.json` that states a verdict no instrument produced. | always | REPORT |
| S14 | **Refutations** | A retracted claim is not deleted — it stays, naming **the instrument that was wrong**. Ultima VI has six of these as `kind=refutation` findings and they are the most valuable records in that project, because each one stops a rebuild that would otherwise be attempted again. | always | REPORT |

### 4.2 The rule that runs across the slots

The corpus produced one law, and it is the reason S11, S12 and S14 exist at all:

> **A scan proves presence, never absence.**

Ultima VI alone produced four false negatives, each from a grep or a partial decode,
each costing a rebuild: *"create.prg writes nothing"* (it writes the save), *"only
`$3E83` writes to disk"*, *"`$F3` is read by nothing"*, *"`$4800-$53FF` is
unreferenced"*. Accolade carries a 96-entry table that is reportedly never read.

So a NEGATIVE claim is its own claim kind and may not be filled by the instrument that
fills a positive one. Filling a slot with "there is none here" requires an instrument
that can see the whole space — a complete decode, an exhaustive cross-reference, a run
— and the slot records which one was used. A grep is never that instrument.

The same defect exists in our own tooling and is not the projects' fault: a false
`exomizer_sfx` detection made two Ultima VI `$C000` overlays render as an 80 % `.byte`
desert until recursive descent replaced it, and an incomplete opcode-length table
desynchronised a run and INVENTED a `JSR` at `$1BC9` that is in truth the operand of
`LDA #$20`, plus six phantom routine entries. Spec 833's rule — a tool may not claim
what it did not do — is the same rule one level down, and S13 is where a project says
which of our tools it trusts for what.

### 4.3 Universal against medium-dependent

Lykia and Accolade are cartridges; the rest are disk. The split is smaller than
expected, and it is entirely inside S2, S3 and S4 — identity, boot chain and geometry
change shape with the medium (BAM + stub + custom GCR against cold-start vector + bank
LUT + EAPI), while every slot from S5 on is the same question either way. That is worth
stating because it means the schema is ONE schema with three medium-shaped slots, not
two parallel schemas.

### 4.4 Built

| File | What |
|------|------|
| `src/slots/schema.ts` | The fourteen slots as data: question, what fills it, `always` or conditional, REFUSE or REPORT, which doors it gates. `KNOWN_PENDING_DOORS` is the 834-shaped allowlist for a door that lives on another branch — it may shrink, not grow, and each entry carries a reason. |
| `src/slots/state.ts` | D2. `slotReport(projectDir)` → per slot `filled / hypothesis / empty / n·a` plus the computed coverage. Fills either EXPLICITLY (a record tagged `slot:S3`) or DERIVED (registered media fill S2, ordered `loader-stage` entities fill S3, refutation findings fill S14). |
| `src/slots/gate.ts` | D1. `checkSlotGate(door, …)`, the S12 vocabulary gate `checkCompletenessClaim`, and `checkPhaseComplete`. `C64RE_SLOT_GATE=0` disables all three. |
| `src/server-tools/slots.ts` | `project_slots` (the completeness question) and `slot_record` (fill one, with evidence). Both in `DEFAULT_TOOLS` — a refusal that names a hidden tool is a dead end. |
| `src/server-tools/citation-resolver.ts` | D4. |
| `src/server-tools/runtime-ratchet.ts` | D5. `knowledge/runtime-ratchet.json`, threshold 4, `C64RE_RUNTIME_RATCHET=0` disables. |
| `scripts/e2e-844-slots.mjs`, `scripts/e2e-844-teeth.mjs` | Both can fail; both do when the code is wrong. |

Gated doors, from §4.1: `register_payload` and `extract_disk_custom_lut` (S4, S2),
`link_payload_to_asm` / `link_cart_chunk_to_asm` (S3), `runtime_candidate_patch` and
`runtime_overlay_run` (S11), `render_docs` (S7/S9/S10), and `save_finding` for the S12
vocabulary.

**Two things the build changed about §4 itself, both found by the test:**

**S4 may not be derived from payload entities.** It gates `register_payload`, so deriving
it from the payloads that call produces would let the door feed itself — the first
registration fills the slot that was supposed to precede it. The geometry is read off the
directory or the LUT BEFORE anything is registered, so S4 is an explicit claim or it is
nothing.

**"Has this project begun" is one knowledge record.** Below that, no door is gated at all.
A slot list applied to an empty directory refuses the first call anyone makes, which is
the failure mode that is worse than having no gate.

### 4.5 What the slot list still does not settle

The coverage threshold in S12 is a number and nobody has one. It is per artifact, it is
certainly not 100 % (padding, unused table space, genuine dead code exist), and picking
it wrongly either blocks finished work or blesses Neuromancer's 15 %. It is a build
decision, taken with the first project that runs the gate — not a spec decision.

## 5. Not in this spec

- Replacing the harness, or running the model from C64RE (§2).
- Spec 775's BMAD portability. Adjacent, unblocked by this, still its own spec.
- Anything that makes the LLM's semantic reading itself deterministic. It is not, and
  pretending otherwise would be the more expensive mistake.
