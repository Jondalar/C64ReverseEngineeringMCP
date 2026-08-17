# Scenario Goals and Acceptance (Spec 810)

State what a run has to achieve, in the same `.feature` files as
[Capture Scenarios](Capture-Scenarios). Partly built — see [Status](#status) before
planning around it.

## The idea

Two kinds of goal:

- **byte-exact** — an address, a range, a component. Machine-checkable from run one.
- **verbal** — "the intro plays", "no garbage on screen". A human looks once.

Acceptance turns the second into the first. A human says "yes, that is right" once,
that state is frozen as the baseline, and from then on the criterion is a diff that
needs nobody.

One engine, two entry doors.

## Notation

```gherkin
# targets: finding/f-2091, payload/level-loader
# mask: cycles, raster, sid_noise

Scenario: the lives counter stops decrementing
  Given the mark "before-death"
  When branch "patch-dec" runs for 2 frames
  Then $DC08 is unchanged
  And the screen is accepted
```

- `Given` binds a **mark** — a named, pinned anchor in the runtime. Named here, never
  created here.
- `When` names a candidate and a budget.
- `Then` is a criterion, one per line.

## Criteria

Classified automatically:

```gherkin
  Then $DC08 is unchanged            # byte-exact: an address
  And the drive RAM is unchanged     # byte-exact: a component
  And finding/f-2091 still holds     # byte-exact once the name resolves
  And the intro plays                # verbal
```

Components understood: `ram`, `cpu`, `vic`, `sid`, `cia`, `cia1`, `cia2`, `drive`,
`colorram`, `floppy`.

## The mask belongs to the criterion

Cycle counters move. The raster moves. TOD moves. A mask says what may legitimately
differ, and it is declared with the goal:

```gherkin
# mask: cycles, raster, tod
```

Per-run masks would make no two tests comparable. A mask declared with the goal is
reviewable, shareable and part of what a human accepts.

Too tight and every second run is red for reasons nobody cares about. Too loose and
it accepts a regression. The mask is part of the acceptance, not a knob turned
afterwards to make a test pass.

## Where the files live

`.feature` files under `<project>/scenarios/`, versioned by git. The knowledge store
holds only the index — name, targets, where it lives.

A scenario is text a human writes and rewrites. Git supplies history, diffs, blame
and conflict resolution for free. Sharing one is a paste.

## Status

Built:

- the notation and its parser (`npm run e2e:810`, 18/18)
- the two goal kinds and the criterion classifier
- the mask-on-the-criterion rule
- the frozen-resolution check (a named target that moved is reported, never followed)
- the driven-step half, shipped as [Capture Scenarios](Capture-Scenarios)

Open:

1. joining mark → candidate → `sandbox/run`. Both ends exist; nothing joins them.
2. the acceptance store. `Acceptance` and `FrozenTarget` are types with no storage,
   no write path and no tool. Nothing freezes a baseline; nothing records who and
   when.
3. byte-exact evaluation against the accepted baseline, with the criterion's mask.
4. the `# targets:` indexer and its lint. Targets are parsed and never resolved; an
   unresolvable name has to be a lint error.
5. an MCP tool. There is none for 810 yet.

Not open: the runner engine and the branch object. Spec 796's candidate is the branch
— baseline anchor + accumulating patch-set + bound replay, with the no-patch run
cached and a diff after every run.

## Two baselines, two questions

Worth keeping straight:

- A **candidate's** baseline is the same replay *without my patch*. Question: did my
  code change anything?
- An **acceptance's** baseline is the state a human *approved*. Question: does the
  machine still reach what we agreed was right?

Same diff engine. Using the first for the second answers the wrong question and stays
green while doing it.

## Named targets

A criterion may name C64RE's own vocabulary:

```gherkin
  Then finding/f-2091 is unchanged
```

The name is in the file for the human. The address it resolved to is frozen in the
acceptance for the machine. If they disagree later, that is reported — never
followed. A criterion that silently re-resolves would quietly check a different
address tomorrow and stay green.
