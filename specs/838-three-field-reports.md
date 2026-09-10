# Spec 838 — Three field reports: a Windows path, a harvest that invents bytes, and code nobody reaches

**Status:** PROPOSED 2026-09-10
**Origin:** Issues #15, #17 and #16, all from the same reporter, all reproducible.
**Anchor:** Spec 832 D4 (tolerant is not the same as inventing) · Spec 827
(a path policy is a library with a gate) · the `entry_points` finding —
they make discovery STRICTER, not additive
**Touches:** `src/lib/prg-workflow.ts` · the sandbox harvest ·
`pipeline/src/analysis/*` · three gates

## 1. D1 — an entity id is not a path (#15)

`src/lib/prg-workflow.ts:331` composes
`artifacts/generated/payloads/${payload.id}`, and a payload id looks like
`crazy-news-c64:ram/loader:payload:0801`. On Windows `:` is reserved (drive
letters, NTFS alternate data streams), so `mkdir` fails, the first payload's L2
step throws `ENOENT`, and the remaining seven are skipped. The extraction
succeeds and the doctrine guarantee — **there is no raw extract without a
disassembly** — silently does not hold on that platform.

**Decision.** An id is an identifier; a path is a filesystem write. Every
segment derived from an id is sanitised for the strictest platform we target,
not the one the developer is on: `:` `*` `?` `"` `<` `>` `|` are replaced, the
reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
`LPT1`–`LPT9`) cannot be a whole segment, no segment ends in a space or a dot,
and the mapping stays **stable and reversible enough to find the artifact
again** — a hash suffix when the sanitised form would collide, never a silent
merge of two payloads into one directory.

This is Spec 827's rule one level down: a path policy is a library with a gate,
not an expression inlined at a call site. The gate runs the same assertions on
every platform, because the platform it targets is not the one it runs on.

## 2. D2 — a harvest may not invent bytes (#17)

`sandbox_depack` / `--harvest` return a CONTIGUOUS RAM window with no signal
for which bytes the routine actually wrote. Un-written bytes come back as
whatever the sandbox held — on a ROM-seeded machine, BASIC or KERNAL ROM —
indistinguishable from real payload. A multi-block depacker writes disjoint
runs, so the gaps between them are exactly where this bites.

This is Spec 832 D4 with different bytes: the GCR decoder used to emit 256
fabricated zeroes for a block it could not read, and the fix was that an
unreadable thing yields NO bytes rather than plausible ones.

**Decision.** The write set already exists — `sandbox-types.ts` returns the real
core's distinct-address write set. The harvest becomes **authoritative about
it**: it reports `writtenRuns: [{lo,hi}]` and the bytes of those runs. A caller
that asks for a window anyway gets the window AND the runs, so the gaps are
identifiable rather than implied. Nothing fills a gap with sandbox residue,
ever. The reporter's option 2 (a doctrine note instead) is declined as the
primary fix: a note does not stop the next person, and we have the data.

## 3. D3 — code entered only from another overlay (#16)

**D3 status: BUILT 2026-09-10** — gate `npm run e2e:838-islands`
(`scripts/e2e-838-islands.mjs`, hermetic, 51 checks). The spec's own
`**Status:**` line stays PROPOSED until D1 and D2 land; they are separate work.
What was decided where the spec left a choice open is recorded at the end of
this section.

`disasm_prg` classifies a region as `unknown` and emits a `.byte` wall when its
recursive traversal never REACHES it from a trusted entry inside the same PRG.
That misses resident code entered only from a different overlay sharing the
address space, or through an indirect vector, a jump table or a self-modified
operand. It is real 6502 code and it renders as data.

Passing those addresses as `entry_points` does not fix it, and this repo already
knows why: **`entry_points` constrains the scan rather than adding to it** —
feeding a list moved 417 bytes from `code` to `unknown` on a measured project,
because the speculative scan had found things the explicit list did not. So the
reporter's workaround makes the listing worse, and the tool never says so.

**Decision, and the build must respect the order.** (a) An `entry_points`
address that lands INSIDE an already-claimed extent must not be silently
dropped — that is the reported symptom and the smallest honest fix. (b) The
seed set gains the addresses the graph already knows are code: a human `routine`
node, a `CALLS`/`JUMPS_TO` edge from another owner, a resolved jump-table
target. The graph has crossed the overlay boundary since Spec 826's
`RESOLVES_TO`; the disassembler has not been told. (c) Whatever changes, a
region promoted from `unknown` to `code` must be **byte-identical on rebuild**
and must say which seed reached it, so a wrong promotion is visible rather than
merely plausible.

Do not turn this into a byte-shape heuristic. Spec 750 settled that: scanning
for structure finds tables that are not there. The seeds come from the graph or
from a human, or the region stays `unknown`.

### 3.1 What was built, and what was decided

**(a) TELL, not split.** An `entry_points` address inside an already-claimed
extent is now recorded in `AnalysisReport.rejectedEntryPoints` with the reason
and printed in the listing header. It is NOT seeded, for one reason: honouring
it means decoding the same bytes twice at two alignments, and only one of the
two can be emitted — the byte-identical rebuild (c) is the guarantee that would
pay for the split, and the analyzer cannot tell which of the two decodes is
right. So the conflict is stated instead: the covering instruction AND the seed
it was decoded from are both named, and the human decides. The other refusals
(`out_of_range`, `inside_basic`, `undecodable`, `owned_by_other`) are reported
the same way; `already_code` is counted, not listed, because it cost nothing.
The same conflict one level down — a byte no decode ends up owning because two
seeds disagree — is reported as `strandedByDecodeConflict`. On Wasteland
block2, 3 of the reporter's 190 entry points were being dropped in silence.

**(b) Three seed sources, one subtraction.** `pipeline/src/analysis/graph-reader.ts`
gains `loadCodeSeeds`, read-only over `knowledge/graph.sqlite`: a human-layer
`routine` node of this owner (S1); a `CALLS` / `JUMPS_TO` edge from a DIFFERENT
owner onto an ownerless `addr` node inside this image (S2); a Spec 826
`RESOLVES_TO` alias pointing at a routine/label of this owner (S3). They enter
as `EntryPoint`s with `source: "graph"`, appended AFTER the `prg_header`
fallback decision so a seed can never displace what the image itself provides.
The subtraction is the graph's own answer, not a guess: an S2 address whose
`addr` node RESOLVES_TO a routine owned by somebody else is that overlay's
code, and is refused with the reason. The space (`ram` / `drv`) is read from
the owner's own rows, so drive code at $0700 is never seeded from C64 RAM.

**Seeds ADD.** Two changes were needed to make that true rather than hoped for,
both found by measurement, neither a byte-shape heuristic:

  1. `probeIsland` treats "falls through onto a CONFIRMED instruction start" as
     a structured ending. A probable-code island is searched inside an
     UNCLAIMED region, so every byte a new seed confirms shortens the window the
     island has to find its terminator in — the island then fails for lack of a
     terminator and its bytes go to `.byte`. Measured on Wasteland block2: 70
     bytes lost while 1574 were gained.
  2. Spec 047's island demotion protected only a confirmed PREFIX. A segment
     shaped confirmed / gap / confirmed lost its second confirmed run.
     Measured on The Pawn's `engine_1000`: 195 bytes of recursively reached
     code at $1054-$1116 demoted because 33 unconfirmed bytes sat in front of
     it. Every confirmed run is now kept, wherever it sits.

**(c) Named, and byte-identical.** A run a graph seed reached carries the seed
address, its origin and its caller in the segment's reasons and in
`attributes.seededBy`, and the renderer prints both that line and a seed ledger
in the listing header. Measured on Neuromancer `chunk_4300`: `code` 1111 →
8930 bytes, `unknown` 11242 → 3473, 0 bytes lost, rebuild byte-identical
(12543 bytes). Across all 12 Neuromancer payloads: 0 bytes of `code` lost.

**Not done, because it needs a guess.** A supplied entry point that lands inside
an instruction is not honoured, and the handful of bytes stranded when two seeds
disagree about alignment are not recovered. Both need somebody to decide which
decode is right; the tool now says which two are in conflict and stops there.

## 4. Gates

`e2e:838-paths`, `e2e:838-harvest`, `e2e:838-islands` — one per decision,
hermetic, each asserting the RULE rather than the reported instance.

## 5. Acceptance

Three gates green and in `gates.yml`; every existing gate green; the reporter's
three cases fixed and, for D3, the rebuild still byte-identical.
