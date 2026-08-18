# Spec 813 — Observers and regions: waiting on a state, and checking one

**Status:** BUILT 2026-08-18 — the region object, the four predicates, the
local-shadows-store rule, the fired-cycle report and the runtime's bulk read are in.
Gates green: `npm run smoke:813` 39/39, `npm run e2e:810` 18/18 and `npm run
smoke:812` 41/41 unchanged, TRX64 daemon 348. Open: nothing in this spec. The
recorder that WRITES this vocabulary is 814.
**Repos:** C64RE owns the region object, the predicates, the resolution rule and the
report. The runtime gains exactly one thing, and it is a fact about a machine:
a bulk memory read (`session/read_memory`). The rectangle→address translation
already exists there (`vic/inspect/region`) and is used, not rebuilt.
**Number:** 813 (registry: `specs/README.md`).
**Vocabulary:** `../../TRX64/docs/concepts-snapshots-scenarios-overlays.md` §6. 813
contributes `region` and `predicate`.
**Depends on:** 812 (the notation, the parser and the executor — extended here, not
duplicated), 810 (the criterion classifier, the mask rule, the frozen-resolution
rule), 721 (`vic/inspect/*`, which already resolves a screen rectangle to the
addresses behind it).
**Origin:** the owner, 2026-08-18, while looking at 810's open list: *"wenn ich im
Pause bin kann ich ein Element oder einen Bereich auf dem Screen markieren und da
einen Vergleich oder einen Observer drauf legen"*.

---

## §1 Why a cycle is the wrong anchor, and why a region is the missing one

812 anchors everything on an absolute machine cycle. That is exact and it rebuilds a
reel byte for byte — but it fails **silently**. Change the runtime (a fastloader
fix, a 1541 timing fix) and the same number lands somewhere else. The reel is then
wrong and reports nothing.

A state anchor fails the other way. `wait until the drive is idle` heals itself: the
loader needs 40 000 cycles more, the step waits. It can fire on the wrong thing —
a text that was already on screen — but it cannot quietly drift.

Both belong in the same file, **at the same step**: the state is the anchor, the
cycle budget is the ripcord.

```gherkin
  And I wait until the screen shows "PRESS FIRE" within 1200 frames
  And I capture "title"
```

And 810 has the mirror-image gap. Its masks are per COMPONENT (`# mask: cycles,
raster`), so *"the intro plays"* stays verbal — the whole screen is noise. Mark the
one box that matters and the same criterion is byte-exact. **A region is the
spatial mask 810 was missing**, which is why 810's open item 3 waits on this spec.

## §2 The object is a named address set, not a rectangle

A marked rectangle on a C64 is not a picture crop. In text mode it is
`$0400 + row*40 + col` plus `$D800+…` for colour; in bitmap mode it is the bytes of
the covered cells. The comparison runs over BYTES, so it is exact, cheap, and blind
to sprites, raster splits and colour cycling happening around it.

So the object is:

```ts
interface Region {
  name: string;
  ranges: { addr: number; len: number; lens: "cpu" | "ram" | "colorram" }[];
  origin?: { kind: "screen-rect"; col: number; row: number; cols: number; rows: number };
}
```

A screen marquee is **one producer** of that object; marking addresses directly in a
memory view is another. Same object, same predicates, one implementation — which is
what makes "later, in RAM/IO too" free rather than a second feature.

`vic/inspect/region` already returns, per covered cell, the screen-RAM address, the
colour-RAM address and the character-data address, with the VIC mode. 813 calls it
and folds the result into `ranges`. It does not re-derive the VIC's addressing.

## §3 The screen is already text

`$0400-$07E7` is one byte per character. Screencode→ASCII is a 256-entry table. No
OCR, no image hashing:

```gherkin
  And I wait until the screen shows "PRESS FIRE" within 1200 frames
  And I wait until the screen shows "READY." within 300 frames
```

A bare `the screen shows` is the degenerate region: the whole text matrix at the
VIC's current screen base. The match is a substring over the rows, with runs of
spaces collapsed, so a menu that pads with spaces still matches what a human reads.

**Bitmap mode has no character matrix.** In bitmap or in a non-text VIC mode the
`shows` predicate is not merely false — it is UNANSWERABLE, and the run says so
rather than failing the wait 1200 frames later:

```
"the screen shows \"PRESS FIRE\"": the VIC is in multicolor bitmap mode at this
cycle, so there is no character matrix to read. Use `the screen is still`, a
region compare, or anchor on a memory value.
```

## §4 The predicates, and they are the same in both halves

One vocabulary, used by `wait until` (812's executor) and by `Then` (810's
criterion classifier). That is the point of putting them in one spec.

| Predicate | Reads | Wait | Criterion |
|---|---|---|---|
| `the screen shows "…"` | text matrix | yes | yes |
| `"name" shows "…"` | region, as text | yes | yes |
| `"name" changes` | region bytes vs. the previous sample | yes | — |
| `"name" is unchanged` | region bytes vs. the step's first sample | — | yes |
| `"name" equals the accepted baseline` | region bytes vs. 810's acceptance | — | yes |
| `$C05F is 3` | one byte | yes | yes |
| `the drive is idle` (812) | drive LED edge | yes | — |
| `the screen is still for N frames` (812) | frame indices | yes | — |
| `the CPU reaches $C001` (812) | PC | yes | — |

Sampling is **once per frame, on the frame boundary**, the same instant a capture
lands. A predicate never observes a half-drawn frame.

## §5 Where a region is defined, and which one wins

Both, and the run says which:

```gherkin
  Given the region "score" covers 30,1 to 37,1    # local — this scenario only
  Given the region "lives"                        # no rectangle → the project store
```

- A local definition **shadows** a store entity of the same name.
- The report NAMES the shadowing. Without that, someone edits the entity, nothing
  changes, and an hour goes into finding out why.

```
regions:
  score   30,1–37,1   local (shadows entity region/score)
  lives   14,0–15,0   entity region/lives
```

- 810's frozen-resolution rule applies unchanged: a store region that has MOVED
  since the acceptance froze it is **reported, never followed**. A criterion that
  silently re-resolves would check a different address tomorrow and stay green.

The store form is where the value is, and it is not test value: the region hangs on
a finding, so a scenario that runs over `"score"` becomes **evidence at that
finding** — *this is the score, and this run shows it counting up*.

## §6 The fired cycle goes in the report

A state-anchored step must still print the cycle it fired on, or the drift that the
state anchor absorbed becomes invisible:

```
captures (the cycle each one landed on):
  title       cycle 26181793   ← "PRESS FIRE" after 812 frames (budget 1200)
```

Run it again after a runtime change and 812 becomes 1104. The reel is still right,
AND the change is visible. That is the regression signal a bare cycle cannot give.

## §7 What 813 does NOT do

- **No recorder.** Marking a rectangle in the UI and writing these lines out is 814.
  813 must ship first: a recorder that writes lines the parser cannot read is a text
  generator.
- **No acceptance store.** `equals the accepted baseline` is PARSED and classified
  here, and evaluated by 810's item 3 once the store exists. 813 supplies the
  spatial mask that makes it worth building; it does not build it.
- **No image comparison.** `the screen looks like "title"` (a frame hash against a
  captured picture) is the bitmap-mode fallback and is deliberately left out until a
  region compare has proven insufficient. Byte compares are exact; frame hashes are
  a maintenance burden.
- **No new VIC addressing.** `vic/inspect/region` owns it.

## §8 Deliverables

**C64RE**

1. `src/project-knowledge/region.ts` — the `Region` object, screencode↔ASCII, the
   local/store resolution with its shadowing report, the frozen-resolution check.
2. `src/project-knowledge/scenario-gherkin.ts` — `Given the region "x" covers c,r to
   c,r`, the six new predicates in §4, and their classification as byte-exact in
   810's criterion classifier.
3. `src/reel/run-scenario.ts` — predicate evaluation once per frame on the boundary;
   the fired cycle recorded per step.
4. `src/server-tools/scene-reel.ts` — the `regions:` block and the fired-cycle column
   in the report; the unanswerable-predicate message of §3.
5. Region as an entity kind in the knowledge store, linkable to a finding.

**TRX64**

6. `session/read_memory { ranges: [{addr, len, lens}] } → { chunks: [base64] }` —
   one bulk read of several ranges at the current cycle. The only new machine fact.
   Today a byte read means parsing `monitor/exec` text, which is neither fast enough
   for a per-frame predicate nor exact for RAM-under-I/O.

## §9 Gates

- `npm run e2e:810` — the parser: every predicate in §4 parses, and each classifies
  as byte-exact or verbal on the right side.
- `npm run smoke:812` — a scenario that waits on `the screen shows "READY."` from a
  cold boot reaches it, captures, and reports the fired cycle. Verified RED with the
  predicate text altered by one character.
- A bitmap-mode scenario asking for `the screen shows` gets the §3 message, not a
  1200-frame timeout.
- Shadowing: a `.feature` with a local `"score"` over an entity `"score"` runs the
  LOCAL one and says so in the report.
- A moved store region is reported and not followed (810's rule, gated here because
  813 is where a region first resolves).
- TRX64: `session/read_memory` returns the same bytes the monitor prints, for RAM,
  colour RAM and RAM-under-I/O.

## §10 Decided in refinement

- **Both definition sites, not one** (owner, 2026-08-18): *"Wenn es eine Entity im
  Store ist kann ich es benutzen — wenn ich es definiere nur für mein Szenario dann
  egal."* Hence §5, and hence the shadowing must be visible.
- **The object is the address set, not the rectangle**, so marking in a memory view
  later costs nothing.
- **Cycle AND state, at the same step** — they fail differently (§1), so neither
  replaces the other.
