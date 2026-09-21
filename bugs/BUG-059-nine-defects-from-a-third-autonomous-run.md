# Bug: nine defects from a third autonomous run, and two measures pointing the wrong way

- **ID:** BUG-059
- **Date:** 2026-09-21
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

## Environment

- Branch: `fix-neuromancer-round`, off `180dfaa6`
- Surface: mcp default
- Project dir: an RE project on four G64 sides
- Tools: `disasm_prg`, `model_assert`, `project_inventory_sync`, `slot_record`,
  `contract_set`, `extract_g64_sectors`, `read_g64_sector_candidate`,
  `project_slots`

## What happened

A third unattended reverse-engineering run wrote down nine defects as it hit
them. They sit next to what BUG-054 through BUG-058 changed and none of them is
a regression of those fixes; three further defects from the same run are the
owner's and are deliberately untouched here (the analysis-path resolution
between `extract_disk` and `disasm_prg`, `disasm_raw`'s segment annotations, and
the graph's owner model for overlays).

Two of the nine are not bugs in a door but in a **measure**. Those are the ones
worth reading twice: the run did not misbehave, it optimised what it was scored
on, and both times the score was pointing at the wrong thing.

---

### 1. `disasm_prg` crashed on an annotation the loader had accepted

```text
TypeError: Cannot read properties of undefined (reading 'split')
    at segmentHeader (dist/pipeline/lib/prg-disasm.cjs:1823:61)
```

A `routines[]` entry with no `comment`. The loader took it — `[annotations]
applied 81, skipped 0` — and the renderer died on `comment.split("\n")`. The
docs promise tolerant loading: a bad entry is skipped and reported.

**Cause.** The two halves disagreed about which fields a routine entry owes, and
the TYPE was the one that was wrong. `RoutineAnnotation.comment` was declared
`string` and nothing ever checked it; the graph importer had always read it as
optional (`comment: … ? … : null`).

**Fix.** `comment` is optional and the renderer prints the name header alone. A
routine carrying only an address and a name is a real annotation: it names the
routine and renames its label. `name` is the field a routine cannot do without —
the renderer reaches for `.name.toUpperCase()` in the same place — so the loader
refuses that entry by section and address, with a "did you mean" for the keys a
human reaches for, and the rest of the file still applies.

**Gate.** `e2e:832-annotations` — a commentless routine at a segment start (where
the block header renders, which is where the crash came from), one that is not,
and one with no name. Against the old code it fails with the reported TypeError
and nothing is written.

---

### 2. A note about a shifted analysis, ~35 times, naming a flag the caller cannot pass

```text
Note: the entry-points slot held X_analysis.json; it was read as the analysis
JSON. Pass --analysis <path> to say so outright.
```

on calls where `analysis_json` was passed correctly.

**No positional caller exists.** Both MCP doors (`analysis-workflow.ts`) and the
L2 chain (`src/lib/prg-workflow.ts`) push `--analysis` by name; every script that
spawns the CLI puts the JSON in slot 4 behind an explicit entry-point slot; a
direct CLI reproduction with those arguments prints nothing. The note and the
named flag were added in the same commit (`91790b41`), so there is no build in
which one existed without the other.

**Cause.** The note's branch fires only when the entry-point slot holds a
`.json`, and on the MCP surface exactly one thing can put it there:
`entry_points`, which this door never checked.

**Fix.** `disasm_prg` reads every `entry_points` entry by the one address rule
before it spawns anything and refuses a non-address by index; when the value ends
in `.json` the refusal names `analysis_json`. The CLI note stays for the CLI's
own positional recovery and now names both doors, each labelled with where it
belongs. The one place in the repo that still taught the positional form — the
annotation prompt's verification snippet — uses `--analysis`.

**Gate.** `e2e:tooling-defects` — the refusal and its wording, and the CLI note's
text.

---

### 3. `model_assert` with `space: "drv"` contained nothing

```text
contains: nothing yet — no analysed nodes fall in this range
```

over `$0300-$07FF` in a project whose drivecode fills exactly that window.

**Cause.** `pick()` honours `space` correctly; the NODES were in the wrong one.
`disasm_prg(platform: "c1541")` used the drive's ZP/IO/ROM tables for one render
and recorded nothing, so `contextForOwner` — which reads the artifact record's
`platform` and the declared machine, and nothing else — put the imported
annotations under `ram`. `$0300-$07FF` is the host's and the 1541's at once,
which is the one case `space` exists for, so both halves agreed on every byte and
disagreed about whose byte it was.

**Fix.** A named platform is recorded on both rails the graph reads: the machine
is declared for the file's owner before anything renders, and the PRG's own row
is stamped. That closes a loop this door had only half of — it already resolved
the platform FROM the artifact record when the caller named none, and nothing had
ever written it there. An empty boundary also stops being a dead end:
`model_assert` now says how many nodes lie in that range under other spaces and
owners, and how a file comes to be indexed under `drv` at all.

**Gate.** `e2e:tooling-defects` — a drive-side listing, its boundary, and the
same range asserted in `ram`.

---

### 4. `project_inventory_sync` returned 146 728 characters

5 833 lines, blowing the client's tool-result limit. A result that cannot be read
is worse than a short one that names where the detail is.

**Cause.** Every problem line was printed, unbounded and at full length, and the
skipped list grew without limit from the registration and manifest-import errors
while only its last section was capped. The gate reproduces it at **139 946
characters** against the old code.

Second half: inventory-pattern globs that matched nothing produced no feedback
about why, and 207 legitimate outputs stayed unregistered. BUG-056 taught the
declaration file to explain a MALFORMED entry; a well-formed one that matches
nothing was accepted in silence.

**Fix.** The full detail goes to `knowledge/inventory-sync-report.md`, every
time, and the answer names it — counts, at most fifteen skipped files, at most
twenty-four problem lines, every line clipped, and a hard cap on the whole text.
A declared pattern that matched no file is named, with what IS in that directory,
which extensions are there, whether the directory exists (and the deepest part of
the path that does), that `*` stops at a path separator when the files sit one
level deeper, and a pattern that would cover them. And tool-produced files that
nothing registered are reported: they are held out of the human debt list on
purpose, and were then reported nowhere, which is how a run's own outputs stay
unregistered while the sync reads clean.

**Gate.** `e2e:inventory-truth`.

---

### 5. A required parameter lost after a long answer, answered with a schema dump

```text
Invalid arguments ... path: ["evidence"] ... Required
```

twice, with `evidence` written out in the call, and a retry of the identical
content working.

**Measured before it was changed.** Nothing in this server drops an argument:
over the real stdio transport `slot_record` stores a **4 MiB** `answer` together
with its `evidence`, and every size between 1 KiB and that. The argument object
that reached the door genuinely had no `evidence` in it — the tool call was cut
short as the CALLER wrote it, which is exactly why a retry of the same content
succeeds. Not something this process can prevent, and not what a schema dump
says.

(`contract_set` has no `evidence` parameter at all, then or now. The two doors on
the surface with a required `evidence` are `slot_record` and `model_assert`, so
the second occurrence was one of those.)

**Fix.** Both doors check it themselves: the field is optional in the schema and
REQUIRED in words, and the refusal names the cause when the shape fits — which
parameter DID arrive, how long it was, that nothing here imposes a limit, and the
one remedy inside the caller's reach: a truncated object loses what was written
last, so the short parameter goes first. A short answer with no evidence is still
just a missing field; no story is invented for it.

**Gate.** `e2e:tooling-defects` — a 258 KiB answer accepted whole, the diagnosis,
the short-answer case, and `model_assert`'s equivalent.

---

### 6. Two G64 doors, two vocabularies for one block

Side 1 T18/S0 was `gcr_error` from `extract_g64_sectors` and `checksum_error`
from `read_g64_sector_candidate`. The distinction is not cosmetic:
`checksum_error` says the data bytes decoded and their checksum disagrees,
`gcr_error` says at least one 5-bit group did not decode, so the bytes under it
are not the disk's and the checksum was never tested.

**Cause.** `readSectorLikeVice` looked only at `block.valid`, which is false for
either. Its fourth word was `no_block` where the ring walk says `no_data_block`.

**Fix.** It reads `gcrValid`, the way `decodeGCRTrackDetailed` always did, and
the two readers share one enum. Each door states the CONDITION behind the
verdict, from one shared sentence per status.

**Gate.** `e2e:833-sectors` — a second synthetic track carrying one sector per
verdict, with both doors asked about each of them.

---

### 7. No bulk sector extraction

`extract_g64_sectors` took one track per call, so four G64 sides cost **140 MCP
round-trips** and a large share of the run's budget — for work `extract_disk`
already does in one pass internally.

**Fix.** `tracks: [...]` and `all_tracks: true` beside the single `track`, which
is unchanged. Each track keeps its own directory and its own
`track-metadata.json`. A multi-track answer is one line per track plus the totals
and names the metadata files; the per-sector listing of a whole side is hundreds
of lines nobody reads and is already in the artifact. Naming the tracks in none
or two of the three ways is refused rather than letting one silently win.

**Gate.** `e2e:833-sectors`.

---

### 8. The coverage metric rewarded a blanket placeholder

S12 counted bytes inside a NAMED range, so the run started emitting `unknown`
segments called `unnamed_XXXX` over ranges it had already named as routines —
the loader among them — because that moved the number. It reverted all 47 and
left coverage at 89.0 %.

**This is the defect, not the run.** A placeholder with an extent counted and a
named routine's own extent did not, so the metric scored a blanket above a name.

**Fix.** S12 asks how many bytes are ACCOUNTED FOR, so a range counts when
something is claimed about those bytes:

- classified `unknown` — **never**. That is the word for "I have not established
  this"; declaring it is honest and worth nothing as coverage.
- classified as anything else — counts. Something said what these bytes ARE. A
  wrong classification is a checkable claim: the rebuild renders it and the
  critic reads it. A blanket `unknown` is not a claim at all, which is why it is
  the one thing that can be applied without knowing anything.
- not classified — counts only under a HUMAN name. A machine name over an extent
  (`unknown_3E00_41D8`, `W0801`) is a range the analyser walked, not an account
  of what is in it, so naming it is now what moves the number.

The two excluded buckets are counted and printed under the coverage line, so a
reader who sees 41 % can see where the other 59 % is and what would move it.
Nothing is hidden; it is just not called coverage. The annotation prompt said
"every `unknown` segment MUST get a classification — no unknowns should remain",
which is the instruction that makes a blanket look like compliance; it now says
to classify what you can establish.

**Gate.** `e2e:844-slots` — the blanket, the machine name, the named routine, the
classified range, and the reported manoeuvre end to end.

---

### 9. S6 was gated on a digit inside S5's prose

```text
S5 is answered but its wording states no number this can read ("Two permanently
resident images and twelve swappable windows") — re-record S5 with a count in
it, e.g. "five runtimes"
```

Re-recording as `4 resident runtimes and 14 swappable windows` did not clear it
either, so S6 through S9 stayed permanently `not applicable` — the state that
reads like "asked and answered" in every report.

**Cause.** The parser demanded the number IMMEDIATELY before the word "runtime".
One adjective in between made a clear sentence unreadable, and the first sentence
never says "runtime" at all.

**Fix.** `slot_record` takes `count`, and that settles it: the number is a field,
the gate is arithmetic, and no wording has to be parsed. The prose fallback stays
for claims already in a project and reads both reported sentences — the nouns are
the ones S5's own question uses, and up to three words may sit between the number
and the noun. A sentence stating two different counts on the same noun is refused
rather than guessed; a wrong number here silently decides whether four other
slots apply. A claim carrying the count as a field outranks one that only says it
in prose, so re-recording settles it rather than landing behind an older claim.
S5's own report line states the count it read and where it came from.

**Gate.** `e2e:844-slots`.

---

## Notes / follow-up

- `e2e:844-slots` was never in `.github/workflows/gates.yml`. It is now, which is
  how both measures came to point the wrong way unobserved.
- Defect 5's cause is outside this process. What is inside it is the answer, and
  that is what changed. If the same shape shows up again with `evidence` genuinely
  present in the JSON that arrives, this diagnosis is wrong and the refusal says
  enough to tell.

---

## Resolution

- **Root cause:** nine independent causes; two of them are measures that scored
  the wrong thing, and those are the ones a run will keep finding.
- **Fix commits:** `f700077a` (1), `ac624564` (2), `bb171ee6` (3), `6660e8fe`
  (6 + 7), `04e17aec` (5), `27310281` (9), `49312c95` (8), `95599b62` (4).
- **Gates:** `e2e:832-annotations`, `e2e:tooling-defects`, `e2e:833-sectors`,
  `e2e:844-slots`, `e2e:inventory-truth`.
