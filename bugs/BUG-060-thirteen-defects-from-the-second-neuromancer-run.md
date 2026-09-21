# Bug: thirteen defects from the second autonomous Neuromancer run

- **ID:** BUG-060
- **Date:** 2026-09-21
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

A second unattended run over the same four G64 sides, after 865/866/867 and the
BUG-054…059 rounds: 230 listings, all 230 rebuilt byte-identical, cartography
100 % against the first run's 89.4 %. It reported fourteen places the tooling got
in its way. Eleven were ours and are below, together with two more a peer session
reported against the graph the same day. Of the three that were not ours, one was
a hook outside this repo, one was the same hook truncating results, and one was a
correct refusal.

Fixed in five parallel branches off `8e74bc6b`, merged the same day. Every defect
was proved red against the unfixed source before its fix was accepted; where an
agent could not reproduce the reported shape it said so and reported what it found
instead — twice, and both corrections are below.

## Environment

- Branches: `fix-060-registration`, `fix-060-diskspans`, `fix-060-disasm`,
  `fix-060-doors`, `fix-060-graph`, all off `8e74bc6b`
- Surface: mcp default
- Project dir: an RE project on a multi-side Neuromancer disk set
- Tools: `project_inventory_sync`, `extract_disk`, `disasm`, `analyze`,
  `register_payloads_from_manifest`, `declare_lut_descriptor`, `resolve_lut_rows`,
  `slot_record`, `model_assert`, the annotation importer, the graph's cut-over

## 1. `project_inventory_sync` talked a caller into wrecking the coverage metric

The answer said:

```
2747 tool-produced file(s) are on disk and registered by nothing — 2732 in analysis/g64/, …
```

…and, in the same answer, handed over an `inventory-patterns.json` skeleton. The
caller did the obvious thing: it wrote a `patterns` entry for the bulk. All 2732
per-sector `.bin` dumps registered. **S12 coverage fell from 22.2 % to 7.6 %** and
not one byte had become less understood — the dumps' bytes joined the coverage
denominator and nothing joined the numerator.

Moving the glob to `intentional` afterwards stopped NEW registrations and nothing
else. The rows stayed, the next sync reported `Files registered: 0` — correctly,
and uselessly — and there was no door that takes a row back out.

Two things were wrong, and both of them are the same thing said twice: a number a
caller can act on wrongly has to carry what the action costs, and an action a
caller can take wrongly has to have an inverse.

## 2. The payload-node owner and the listing owner disagreed for stock-DOS files

`extract_disk` files a stock-DOS row under the CBM directory name (`p`) and writes
its bytes into `03_p.prg`. Every analysis producer keys that file's graph rows on
the FILE stem (`ownerFromAnalysisPath` → `03_p`), and so does the S12 coverage
measure (`stemOf(relativePath)`). The payload's owner stem came from its NAME, so
the payload node stood under `ram/p` and its disassembly under `ram/03_p`.

Result: the payload node for `p` read **0 % classified** although the file was
fully annotated and rebuilt byte-identically. All seven side-1 DOS files were
affected, and it is a large part of why the S12 number looked bad.

## 3. The chain guard counted the extractor's own PRG header as a missing sector

```
extracted blob is 12543 bytes but its 49 declared sector span(s) cover only 12541
— the block chain looks incomplete (start-only?)
```

The chain was complete. The two bytes are the load-address header a `.prg` carries
and the medium does not. The run silenced the warning by declaring the first
sector's span from offset 0 with length+2 — a span claiming the payload starts
inside the sector's T/S link bytes, which is false for every loader that is not
this one. A guard that can only be satisfied by a lie is worse than no guard.

## Resolution

**1.** The tool-output line now says what the files ARE (machine output, standing
behind the run's manifest), what registering them COSTS (the bytes, and what those
bytes do to coverage), and which key settles it — `intentional`, which silences,
never `patterns`, which registers. No `patterns` skeleton is offered for such a
bulk. `howToSilenceToolOutput` is the one place that answers for it, so
`project_inventory_sync` and `scan_registration_delta` say the same thing. The
byte totals are measured in the shared scan (`toolOutputBytes` /
`toolOutputBytesByDir`) rather than guessed at by the reporter.

And there is a way back: `unregister_files(glob=…)` takes artifact rows out of the
store. It never deletes a file — the bulk it exists for is a tool's output and the
tool will read those bytes again — and it refuses any row somebody has written
about: cited by a finding / entity / relation / flow / open question, sitting in a
lineage, carrying a version history, or whose subject holds more than one version.
Each refusal is named with its reason.

**2.** A payload's owner stem is the stem of the artifact holding its extracted
bytes, falling back to its name when there is no blob. The file wins because it is
what the rest of the system already counts. The link has to exist BEFORE the row
is keyed — a node id is derived on first save and re-saving an existing entity
keeps it — so the manifest import registers the blob and points the row at it
itself; Spec 752's `linkExtractedPayloadFiles` stays as the catch-up path for rows
imported before this. The CBM directory name survives as the entity's name.

**3.** The guard accounts for the header: for a payload the manifest declares
`prg`, a shortfall of EXACTLY two bytes is the load header. Three bytes still
warns, a start-only chain still warns, and the warning now says the header is
already allowed for so nobody pads a span to cover it again.

## Gates

| Defect | Gate |
|---|---|
| 1 | `npm run e2e:inventory-truth` — section 10. Registers the bulk, measures the coverage denominator before/after/after-undo, and checks the refusal. |
| 2 | `npm run e2e:subject-identity` — section 5. A real D64, `extract_disk`, the import, and the payload node's owner against `ownerFromAnalysisPath`. |
| 3 | `npm run e2e:chain-coverage` — section 5. Newly wired: the gate existed but was not in `package.json` and had bit-rotted on a missing `initProject`, so it had not run. |

---

## 4. A block chain that stopped early stopped silently

The report said `extract_disk`'s Spec 784 manifest writes one span per payload.
Taken literally that does not reproduce — `buildDiskSpec784Manifest` maps the full
chain, and side 1 comes out correct today. **The same outcome arrived by another
route:** `traceFileSectorChain` `break`s out of its loop on a revisited sector or
one the image cannot deliver and returns a bare link list, with nothing to tell a
complete chain from a prefix. On side 2 both directory entries link on to `149/72`
and `210/3`, which the image does not hold; each was published as a clean 254-byte
one-sector payload. That is the Pawn 168/1329 shape, and `chainCoverageWarning` —
the guard that exists for exactly this — is blind to it, because `extractFileFromChain`
stops at the *same* broken link, so blob and spans are short by the same amount and
the coverage matches perfectly.

`walkFileSectorChain` returns the links **with a verdict** — `complete`, `empty`,
`cyclic`, `unreadable`, `malformed-terminator` — naming the track/sector where the
walk stopped and how many sectors it reached against the directory's block count.
Only `complete` licenses a caller to call the links an extent. A `00/00` link is
not a terminator: a real last sector's second byte is the offset of its last used
byte, so it is at least 2.

## 5. A `code` segment over bytes that end mid-instruction lost a byte

Ten payloads rebuilt short. The message pointed at the segment; the cause was one
branch further in. `decodeInstruction` already refuses to invent operand bytes it
does not have and degrades such an opcode to a 1-byte `.byte` fact — but
`renderCodeSegment` took that fact down the **instruction** path, where the mode is
`impl` and `operandTextFromFact` has nothing to say, so the renderer emitted the
mnemonic alone: `.byte` with no value, which assembles to nothing. The byte
vanished. Spec 830.1's overrun guard never fired because the degraded fact's size
is 1. The code now ends at the last instruction that fits and the tail renders as
data, with the listing saying where and why; the segment stays `code`, so the
classification and the coverage it buys survive.

## 6. Two annotation segments on one start address failed almost silently

`Annotations import: FAILED — migration_log: …/segment:43a8 logged twice`, one line,
while the same answer reported `rebuild verified byte-identical`. The listing was
believable and the graph had nothing. A segment start is the id the listing and the
graph are both keyed on, so two entries on one start are a contradiction with no
correct resolution — the old code silently kept the last one *and* overlaid both.
It is refused at parse time now, naming both segments with their ends, nothing
rendered and nothing written. Ranges that OVERLAP at different starts stay legal;
Spec 055's reshape depends on them. **Measured before choosing the refusal:** 832
annotation files across every project in the corpus, none with a duplicate start —
the strictness costs nothing that exists.

## 7. Four doors' ergonomics

- **No bulk door.** 217 payloads meant 400-plus round trips, worked around with
  eight subagents. `disasm` and `analyze` take `paths[]` now — one background job,
  each path through the *same* body a single-path call uses, so nothing can be true
  in a batch and false alone. A bad path is named on its own FAILED line and does
  not sink the rest. `output_asm`/`output_json` with `paths` is refused: one name
  cannot hold N results.
- **`declare_lut_descriptor` assumed the table is on the medium.** Its `at` is a
  byte offset into the image, and a G64 has no usable byte offsets; this game's
  index tables live inside a loaded payload. A `frame` of `medium` (the default, so
  every descriptor written before this means what it did) or `payload`, whose
  addresses are runtime addresses; the header byte count is inferred by the disasm
  doors' own rule and the answer says which reading it took. `side` is a column role
  of its own and deliberately does **not** resolve onto `bank` — a disk side must
  not become the bank a deref reads through.
- **`slot_record`'s title cap** surfaced as `String must contain at most 120
  character(s)` after the whole call was composed. It refuses by name now, says how
  long the title actually is, says the ANSWER is not capped, and hands back a
  ready-made headline cut from the caller's own words.

## 8. The graph: no structure after a cut-over, and three smaller ones

Reported by the Wasteland_2 session, and the worst of the four. `graph_edges`
answered nothing for a resolver whose caller is written plainly in the listing
(`jmp $09B8`). In that project `producer='819'` covered exactly **one** owner — the
only artifact re-analysed since the cut — while about 24 others held cut-over rows
and not a single control-flow edge. `seedControlFlowForArtifact()` had one caller,
`importAnalysisArtifact()`, so a project migrated by `agent_onboard` got the human
and segment layers and no structure at all. The seed pass moved out of the CLI verb
into `producers/seed-project.ts` and `ensureCutover` runs it, on a budget (40
analyses / 60 s, three env knobs), skipping owners that already carry 819 rows so it
is resumable, and naming what it did not reach together with `c64re graph seed`.

- **`orphaned` was computed per id.** A human `label:09b8` whose generated twin at
  the same address is a `segment:09b8` is a different id, so the row read orphaned
  though the address was covered — which is what sent the peer down a wrong
  diagnosis. False now as soon as the generated layer stands at the *exact* address
  under the same owner and bank. Not containment: a human row inside a generated
  routine's extent is 826.0 T3's split, a real distinction. Not `addr` nodes:
  "somebody referenced this" is the question, not the answer.
- **A boundary containing containers reported empty**, because its nodes belong to
  the containers nested inside it, and `project_critique` then called it a guess
  wearing a name. Membership counts containment; the innermost-wins tally moved to
  `direct`, so the critic and the edge roll-up are unchanged.
- **`database is locked` on `graph.sqlite`.** Measured, not guessed: `PRAGMA
  journal_mode = WAL` needs an EXCLUSIVE lock and **SQLite does not run the busy
  handler for it**, so the connection's `timeout` bought nothing — and every writer
  ran the pragma on every open whether the file was WAL already or not. The mode is
  queried first; when the switch really is needed, five tries with backoff, and
  failing that the store opens anyway, because another connection holds the file and
  is about to set WAL, and rollback-journal mode is slower rather than wrong. A
  20-trial probe went from 3 dead writers to 0. The reader half is `busy_timeout` on
  the pipeline's own graph reader, the one connection `GraphStore` does not make —
  measured side by side at 4 lost reads in 1920 against 0.

## 9. Three gates that ran nowhere, and what one of them caught

`e2e-chain-coverage` and `e2e-manifest-register` were in no npm script and had
bit-rotted on a missing `initProject`. `e2e-823-graph-mcp` was in no workflow and
had gone red on the onboarding gate that arrived after it. All three are wired now
— and 823, once it ran, immediately found a real drift it exists to catch: Spec 867
gave `graph_find` its window claimants and `c64re graph find --json` never got them,
so two surfaces the spec calls one document had diverged, 25 lines against 38. This
is the third instance of this class in a month; the first was commit `7a74a0f3`.

## Not ours

- The token-optimizer's `refetch_guard` denied `mcp__c64-re__*` calls. The local
  matcher patch is correct on disk; the session predated it, and hooks are read at
  session start. The **PostToolUse** matcher is still `mcp__.*` and does truncate
  c64-re results — real, but in a plugin cache this repo does not own.
- `analyze` refusing a `.bin` the store had registered as a PRG was correct, named
  the fix, and was resolved on the first retry.

## Left open

- **Sides 3 and 4 of the Neuromancer set yield no directory entries at all** — their
  track 18 is raw GCR the G64 sector decode does not resolve. Found while fixing
  defect 4, out of its scope, and a large part of why that run walked the chains by
  hand. Not filed as a defect here because nobody has yet established whether the
  medium or the decoder is wrong.
- `e2e:820-2` is red on a missing corpus input (`npm run measure:816` first), not on
  code. `e2e:024-payload-rich` is red at the base commit too, and unwired.
- `e2e:822` failed once at 121/1 and has been 122/0 on every run since, including
  the merged tree. The failing assertion was not captured.
