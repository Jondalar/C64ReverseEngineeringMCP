# Spec 810 — Scenario goals and acceptance: what is checked, and who says yes

**Status:** PROPOSED
**Repos:** C64RE only. Running the branches is **809** in TRX64 — this spec never
emulates anything.
**Number:** 810 (registry: `specs/README.md`).
**Depends on:** 809 (marks + branches + N sandboxes), 794 (whitebox component-diff and its
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
- **When** names a branch and a budget. 809 runs it in a scratch instance and hands back
  the end state.
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

- **The scenario** — Gherkin source, versioned in the project knowledge store.
- **The acceptance** — who, when, and the exact state that was accepted. A `.c64re`, so it
  can be diffed and re-accepted later.
- **The verdict history** — per run: which mark, which branch, pass/fail, and the diff when
  it failed. A criterion that goes red must be answerable with "against what, and what
  moved".
- **The winner's provenance** — when a branch is chosen, 797 already turns its patch-set
  into a build-ready delta. 810 records *why* it won: the scenario it satisfied and the
  acceptance behind it.

## §5 What 810 does NOT do

- **It does not emulate.** No machine, no sandbox, no patches applied. It sends "run these
  branches from this mark" and reads states back (809 §4).
- **It does not define marks or branches.** Those are 809's objects; 810 refers to them by
  name.
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

## §8 Open — the remaining refinement question

**What is a criterion allowed to name?** Addresses and components are obvious. Do findings,
payloads and routines — C64RE's own vocabulary — become nameable targets ("the loader's
entry point is unchanged"), or does v1 stay at raw addresses?
