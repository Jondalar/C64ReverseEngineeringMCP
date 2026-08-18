# Spec 810 — Scenario goals and acceptance: what is checked, and who says yes

**Status:** PARTLY BUILT — the notation, the two goal kinds, the mask-on-the-criterion
rule and the frozen-resolution check are in (`src/project-knowledge/scenario-gherkin.ts`,
`npm run e2e:810`, 18/18). 812 widened the same parser for driven steps and built the
runner's substrate — an ephemeral sandbox, driven paused and in cycles, which is measured
deterministic over a socket (BUG-050's control run). **Open, re-scoped 2026-08-17 after
reading what already exists:**
1. the runner for the branch arm — resolve the mark to an anchor, hand the candidate's
   patch-set to `sandbox/run {from, patches, cycles}`, take the end state. Both ends exist;
   nothing joins them.
2. the acceptance store — `Acceptance`/`FrozenTarget` are types with no storage, no write
   path and no tool. Nothing freezes a baseline; nothing records who and when. This is the
   spec's load-bearing idea and the part of which nothing exists.
3. byte-exact criterion evaluation against THAT baseline (not 796's — see §5), with the
   criterion's mask. **Unblocked 2026-08-18 by 813**: the mask used to be per component,
   so a verbal goal over a busy screen ("the intro plays") had no byte-exact form to
   convert INTO. 813's region is the spatial mask — mark the one box that matters and
   the same criterion is byte-exact, which is the conversion §1 promises. The
   classifier already treats `"score" is unchanged` as byte-exact; what is still
   missing here is the STORE to compare it against.
4. the indexer + lint — `# targets:` is parsed and never resolved; an unresolvable name
   must be a lint error.
5. a door. There is no MCP tool for 810 at all.
**Not open:** the runner engine and the branch object. 796 has both.
**Repos:** C64RE only. The runtime capability is **809** in TRX64 — this spec never
emulates anything itself, but it DOES drive the sandboxes (doctrine amended 2026-08-14:
C64RE may spawn ephemeral TRX64 sandboxes for point work, and they end themselves on a
budget).
**Number:** 810 (registry: `specs/README.md`).
**Depends on:** 809 (marks + the sandbox capability), 794 (whitebox component-diff and its
exclusion mask), 797 (build-ready delta from a winning branch).
**Framing:** the owner's model, the middle bullet —

> - was geprüft wird, wird definiert (das wäre eine C64RE Spec, z.B. im Cucumber-Style)
>   und vor allem was das Ziel ist
>   - byte-genau → mega, volle Automation
>   - nur "verbal" → ok, dann BDD-Style und am Ende muss es jemand abnehmen, das erste Mal

---

## §1 The idea that makes the verbal half cheap

The two goal kinds look like two systems. They are not, and this is the load-bearing
observation of the spec:

**Acceptance converts a verbal goal into a byte-exact one.**

The first time, a human looks at the run and says "yes, that is right". At that moment the
resulting state is frozen as a baseline. From then on the same criterion is a 794 diff and
needs nobody.

So the BDD layer does not have to *evaluate* anything. It has to:

1. name the goal in words,
2. present the run for acceptance,
3. freeze the accepted state as the baseline,

and after that it runs in exactly the same machinery as the byte-exact case. One engine,
two entry doors — not two engines.

## §2 What a scenario is here

```gherkin
Scenario: the lives counter stops decrementing
  Given the mark "before-death"
  When branch "patch-dec" runs for 2 frames
  Then $DC08 is unchanged
  And the screen is accepted            # verbal → frozen on first acceptance
```

- **Given** binds a mark (809). C64RE never creates it; it names one that exists.
- **When** names a candidate and a budget. The word in the file stays `branch` because that
  is what it reads like in a sentence; the OBJECT is 796's candidate — baseline anchor,
  accumulating patch-set, bound replay — and 810 adds only the name and whether it won (§5).
  The run itself is `sandbox/run { from, patches, cycles }`: these bytes, this budget, from
  this mark. The runtime hands back an end state and knows nothing about why.
- **Then** is the criterion. Two kinds:
  - **byte-exact** — an address, a range, a component. Machine-checkable forever, from run
    one. Full automation.
  - **verbal** — "the intro plays", "no garbage on screen". Checkable by a human once;
    afterwards by diff against what that human accepted.

Gherkin because the owner named it, and because the Given/When/Then split happens to be
exactly the mark / branch / criterion split that already exists underneath. It is a
notation over the model, not a new model.

## §3 The exclusion mask belongs to the criterion

794 has the mechanism: a mask of what may legitimately differ. **WHERE it is declared is
this spec's decision, and it is the criterion — not the run.**

Cycle counters move. The raster position moves. TOD moves. If each test carried its own
mask, no two would be comparable and every criterion would drift until nobody trusted a
red. Declared with the goal, a mask is reviewable, shareable and diffable.

This is also the failure mode to design against: **a frozen baseline is only as good as its
mask.** Too tight and every second run is red for reasons nobody cares about; too loose and
it accepts a regression. The mask is part of what a human accepts, not a knob turned
afterwards to make a test pass.

## §4 What is stored

- **The scenario** — a `.feature` file in the project dir, versioned by git (§7). The store
  holds only the INDEX of it: name, targets, and where it lives.
- **The acceptance** — who, when, and the exact state that was accepted. A `.c64re`, so it
  can be diffed and re-accepted later.
- **The verdict history** — per run: which mark, which branch, pass/fail, and the diff when
  it failed. A criterion that goes red must be answerable with "against what, and what
  moved".
- **The winner's provenance** — when a branch is chosen, 797 already turns its patch-set
  into a build-ready delta. 810 records *why* it won: the scenario it satisfied and the
  acceptance behind it.

## §4b It supersedes Spec 030's scenario

`RuntimeScenarioSchema` (Spec 030) is still in `types.ts`, with a store and a
`save_runtime_scenario` tool — and **the spec itself is gone**: no file survives in
`specs/` or `specs/_archive/`. What it describes is define-once-run-many with breakpoints
and a stop condition, and it has no notion of a goal or an acceptance. That is the "inert
data" shape Spec 775 names, and 810 is the concept that replaces it.

**The old type is not deleted by this spec.** Removing it touches the schema, the storage
and an MCP tool, and orphans anything already stored — a decision of its own rather than
something smuggled into a new feature. What 810 fixes is the ambiguity: there is ONE live
scenario concept now, and the other is a leftover awaiting a deliberate removal. A repo
with two things called "scenario", one of them dead, is how the next person builds against
the wrong one.

## §5 What 810 does NOT do

- **It does not emulate.** It never steps a CPU or applies a patch itself. It asks 809 for
  a sandbox — *these bytes, this budget, from this mark* — and reads the end state back.
  Spawning that sandbox is allowed and expected (doctrine, 2026-08-14); it must carry a
  budget, and it ends itself.
- **It does not define marks.** A mark is 809's object, set in the runtime by whoever is
  driving. 810 names one that exists and never creates one.
- **It adds two fields to a CANDIDATE; it does not own a second object.** This bullet used
  to read "it DOES own branches — the name, the patch-set, which scenario it serves and
  whether it won". Three of those four already exist, and have since 2026-07-16: a
  **candidate** (796) is a baseline anchor + an accumulating patch-set + a bound replay,
  held in the daemon, with the no-patch run cached as its reference and a 794 diff after
  every run. What is genuinely 810's is the NAME and WON. Building a "branch" beside it
  would give the repo two things with one job — the exact trap §4b below is about, walked
  into from the other direction. Vocabulary fixed 2026-08-17 in
  `../../TRX64/docs/concepts-snapshots-scenarios-overlays.md` §6.
- **The reference is 810's, and it is NOT 796's.** A candidate's cached baseline is *the
  same replay without my patch* — "did my code change anything". An acceptance's baseline
  is *the state a human approved* — "does the machine still reach what we agreed was
  right". Same diff engine, different reference. Using 796's for an acceptance answers the
  wrong question and stays green while doing it.
- **It is not a test runner for the repo.** This is about scenarios over a C64 title, not
  about C64RE's own gates.

## §6 Gates

- **G1 — a byte-exact scenario runs headless end to end.** Mark → branch → verdict, no
  human, repeatable, same answer twice.
- **G2 — acceptance freezes.** A verbal criterion accepted once becomes a stored baseline,
  and the second run is decided by diff with nobody present.
- **G3 — the mask travels with the criterion.** A scenario carries its mask; running the
  same scenario twice on different days uses the same mask without anyone passing it.
- **G4 — a red is answerable.** A failing run reports what differed, against which accepted
  baseline, in terms of addresses and components rather than "not equal".
- **G5 — provenance survives.** From a winning branch, the scenario, the mark, the patch-set
  and the acceptance are all reachable.
- **G6 — no runtime in C64RE.** The doctrine gate (`check:runtime-invisible`) stays green;
  810 adds no emulation path.
- **G7 — a moved target is reported, not followed.** Accept a criterion that names a
  finding, move the finding, re-run: the verdict names the divergence (frozen address vs
  current) instead of silently checking the new address and passing. See §8.

## §7 Decided in refinement

**The Gherkin lives in FILES, in the project dir, and the knowledge store indexes them.**

```
<project>/scenarios/*.feature
```

This cuts against the usual line here (everything is an entity in the store), and the
reason is what a scenario actually is: **text a human writes and rewrites, several times in
a row.** A file is the better tool for that than an API — and git supplies history, diffs,
blame and conflict resolution for free rather than having them rebuilt inside the store.
Sharing one is a paste, not an export.

The price is paid on linking. "This scenario checks that finding" is a reference you get
for nothing when both sides are entities; with files it has to be written down. So a
scenario names what it targets explicitly in its own header, and the indexer resolves it:

```gherkin
# targets: finding/f-2091, payload/level-loader
Scenario: the lives counter stops decrementing
```

An unresolvable target is a lint error at index time, not a dangling reference discovered
months later — the whole point of choosing files was that a human maintains them, and a
human needs to be told when a name has gone stale.

## §8 Decided in refinement — a criterion may name C64RE's vocabulary, and the
resolution is frozen with the acceptance

A criterion may target a finding, a payload or a routine, not only a raw address:

```gherkin
Then the loader's entry point is unchanged
Then payload "level-loader" is unchanged
```

A scenario should read like what you mean rather than like a memory map — that is the
whole reason for choosing a human notation.

**But the resolution is frozen at acceptance time, and the name is kept beside it.**

```
the loader's entry point   →   $8500     (resolved 2026-08-14, frozen with acceptance)
```

Without this there is a failure mode that is invisible in exactly the wrong direction. A
finding can move: someone annotates further, a segment gets reclassified, an analysis is
re-run. If the criterion re-resolves the name on **every** run, then tomorrow it quietly
checks a different address — and stays **green**. A criterion that silently changes what it
is testing is worse than one that fails, because a red gets looked at.

So: the name is in the file for the human, the frozen address is in the acceptance for the
machine, and both are carried. When they later disagree, that is its own finding —

```
criterion "the loader's entry point" is frozen at $8500;
finding f-2091 now resolves to $8520 — re-accept or fix the scenario
```

— reported, never silently followed. Re-accepting is a deliberate act with a human on it,
which is the same rule as §1: acceptance is what turns a name into something a machine may
trust.

**Gate G7:** move a finding after acceptance and assert the run reports the divergence
rather than following it or passing.
