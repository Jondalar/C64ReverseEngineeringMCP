# Spec 833 — A tool may not claim what it did not do

**Status:** BUILT 2026-09-09 — `e2e:833-render` 49/0, `e2e:833-sectors` 35/0,
`e2e:833-sandbox` 25/0, all three hermetic and in `gates.yml`; every existing
gate green. Three agents, one class each. Measured on the render fixture:
without `analysis_json` 0 of 8 in-image names before and **8 of 8** after; with
it, 8 of 9 before (the segment label missing) and **9 of 9** after. Byte-identical
rebuild verified in both modes.
**Origin:** Follow-ups from the Ultima VI session after 832 landed, plus two
things found while checking them. 832 fixed six instances of one shape; these
are five more of the same shape, three of them on paths 832 did not reach.
**Anchor:** Spec 832 (the same thread, one layer out) · Spec 830 · the
path-portability rule in the tool matrix header · the two-disk-impl rule
**Touches:** `pipeline/src/lib/prg-disasm.ts` · `pipeline/src/lib/annotations.ts`
· `src/server-tools/analysis-workflow.ts` · `src/server-tools/disk-g64.ts` ·
`src/server-tools/sandbox.ts` · `scripts/e2e-mcp-path-portability.mjs` · three
new gates.

## 1. D1 — the legacy render path applies nothing and says it applied everything

`prg-disasm.ts:2934` builds the annotations index under
`if (annotationsFile && analysisContext)`, and `activeAnnotations` at 2953 is
`analysisContext?.annotations`. Without an `analysis_json` there is no context,
so the file is *found*, never *indexed*, and every name is absent. Line 2975
nevertheless prints `// Semantic annotations applied` on the strength of
`annotationsFile` alone.

Measured by the reporter against this exact build: without `analysis_json`,
1 250 `W`-labels and not one of eight checked names; with it, all eight. 832's
D1 fix sits entirely inside that same `if`, so it improved the path that already
worked and left the other one claiming success.

**Decision, two halves, and the first is not optional.**
(a) The header states what happened. `Semantic annotations applied` is printed
when they were applied; when a file was found and not applied it says so and
says why, in the same line a human is already reading.
(b) The legacy path gets the names. Without an analysis context there is no
`labelSet` — but 832 D1 established that an annotated address IS a declaration
that the address matters, and that is enough to build one from the annotations
alone. Running `disasm_prg` without `analysis_json` is exactly the "just let me
look at it" case, which is when a human least wants to be told the labels are
somewhere else.

**Corrected during the build — "the names" is not "the annotations".** Only the
NAMES can cross without an analysis context. A `segments` entry's `kind`, a
`pointerTables`/`jumpTables`/`immediates` entry — the structural half — retypes
byte ranges the ANALYSER produced, and there are no segments to retype on the
legacy path. So the fix is: names apply in both modes, the structural half
applies only with an analysis JSON, and the header names that split rather than
rounding it to "applied". Two consequences fall out of the same honesty. An
annotated address strictly inside an instruction gets an equate, not a label —
definitions are only emitted at instruction starts, so putting it in the label
set would mint a reference to a name nothing defines. And an annotated address
OUTSIDE the image is skipped: that is the range check
`applyDeclaredLabelDefinitions` already makes, and the legacy path never
references such an address, so it names nothing and claims nothing.

Also corrected: the relocation renderer WITHOUT an analysis context does not get
the index. It overlays its own runtime-addressed sub-segment labels on whatever
is active, and the annotations are in FILE addresses; feeding them in would be a
second claim of a different kind, with a real duplicate-definition hazard where
a runtime address and a file address coincide. The header says so instead —
which is the whole rule, applied to the path where the answer is "no".

Measured on the gate's fixture, before → after: without `analysis_json`, 0 of 8
in-image names to 8 of 8; with it, 8 of 9 to 9 of 9 (the ninth is D2's).

## 2. D2 — a segment annotation's label is a third path that goes nowhere

`buildAnnotationsIndex`'s segment loop fills `segmentsByStart` and
`segmentAnnotations` and nothing else: a segment's `label` never reaches
`labelsByAddress`, so `makeLabel` cannot answer with it. The only
`labelsByAddress.set` for a segment start is in `overlayRelocLabels`, which is
the relocation path. The reporter's `filename_records` therefore cannot appear
even on the analysis-driven path — 832 D1 fixed routines and labels and did not
touch this.

**Decision:** a segment annotation's label joins `labelsByAddress` at the
segment start, under the precedence that already exists — an explicit label
wins, then a routine, then a segment — and under the same `usedLabels`
collision rule, so a duplicate identifier keeps the auto-label rather than
breaking the rebuild.

## 3. D3 — a graph-import line that reads as a rendering result

`src/server-tools/analysis-workflow.ts:454` says *"Annotations unchanged since
the last import (24 routines, 15 labels, 5 segments in the graph)"*. That is
true and it is about the GRAPH. A caller reading it after a `disasm_prg` takes
it as "the annotations are in", and when the listing then shows `W26D2` the
natural conclusion is that the import is broken. That is precisely how this
defect was first reported, and it cost the reporter a wrong diagnosis.

**Decision:** the two outcomes are stated separately and neither borrows the
other's credibility. The graph line says what the graph holds; the render line
says how many annotations the listing applied, or that it applied none.

**Built as:** `Listing: <the listing's own header line>` and `Graph: … — graph
contents, not the listing.` The wrapper does not render, so it does not compute
the render line: it reads D1(a)'s header back out of the ASM and quotes it. That
also closed a smaller instance of the same shape found while building — the
wrapper's `hasAnnotations` looks only next to the ASM while the renderer also
looks next to the PRG and next to the analysis JSON, so a file found in either
of the other two places used to produce a "no annotations, write some" hint over
a listing that had applied them. The quoted line is the renderer's answer and is
printed in both branches, so the two can no longer disagree silently.

## 4. D4 — `.invalid` in a filename now marks files that are fine

`disk-g64.ts:457` names a sector file
`t<tt>s<ss>${sector.dataValid ? "" : ".invalid"}.bin`. Two problems, and 832
made the second one worse:

- `dataValid` is the DATA CHECKSUM. On a custom-CRC disk it fails for every
  real sector: The Pawn's 683 and Impossible Mission II's 631 are all written
  as `.invalid`. A caller who skips `.invalid` skips everything real — the
  exact opposite of what the name suggests.
- Since 832 a sector with no data block yields no bytes and **no file at all**.
  Every file that gets written now contains real bytes off the disk. The suffix
  has stopped marking anything a caller should avoid.

**Decision:** the filename stops carrying a verdict it cannot express. Every
extracted sector is `t<tt>s<ss>.bin`; `dataStatus` in `track-metadata.json`
(`ok` / `checksum_error` / `gcr_error` / `no_data_block`) is the truth, and the
tool's own output says how many sectors carry a non-`ok` status so nobody has to
go looking. This widens what matches `t<tt>s<ss>.bin` rather than narrowing it,
so a reader that already globs that pattern gains the custom-CRC sectors it was
silently missing.

Three corrections from the build:

- The status list above originally omitted `no_data_block`, which 832 added and
  which is the one status that legitimately produces no file at all. It is what
  explains a `path: null` entry, so a reader of the spec alone would misread the
  artifact.
- "and loses nothing" was too strong. **Two pairs on one track claiming the same
  (track, sector) used to land on two filenames and now compete for one** — the
  spec did not consider the case. Resolved before anything is written, never
  last-write-wins: a pair with no bytes never competes; otherwise the best
  `dataStatus` owns the name (`ok` > `checksum_error` > `gcr_error`, the rule
  `view-builders.ts` already applies to a twice-listed sector); ties go to the
  pair the ring walk met first. The loser keeps its `files[]` entry with
  `path: null` and a `duplicateOf` naming the winner, so `path: null` is never
  ambiguous between "no bytes" and "another copy owns the name". Its bytes are
  still reachable through `read_g64_sector_candidate` and `inspect_g64_track`,
  but it does lose its file, and that qualifier belongs here.
- Measured read-only on five real images: IM2 683 sectors / 631 non-ok, Pawn s1
  683/683, LN3 s1 683/666, Ultima VI dungeon 683/0, Brubaker side1 683/0 — every
  file matches `t<tt>s<ss>.bin`, and **zero duplicate-id collisions on any of
  them**. The collision rule is a safety net, not a hot path.

## 5. D5 — a default tool that cannot find its project, and the gate that let it

`src/server-tools/sandbox.ts:79` calls `context.projectDir(undefined, true)` —
no hint. The resolver then has nothing to walk up from and depends on
`C64RE_PROJECT_DIR` or on the process cwd being inside a project. Every other
path-taking tool passes a hint: `project_dir`, or a file path like `image_path`.
`sandbox_6502_run` is in `DEFAULT_TOOLS` (`tier-tools.ts:171`), and the matrix
header's rule is explicit — no default tool may be `broken-cwd-coupled`, and
path-taking tools resolve through the project resolver, never the process cwd.

**Decision, two parts.** (a) The tool takes an optional `project_dir` like every
other, and in its absence takes the hint from the first path in `loads[]` —
which it already resolves against the project root, so the information was there
all along. A `loads[]` made only of `hex_bytes` carries no path, and the spec had
no answer for it; the build's answer is better than the one it would have got.
Such a run needs no project AT ALL — every byte is inline, and a root is only
ever used to resolve a RELATIVE path — so the root is now resolved on first use
and memoised, not up front. A fully inline run never asks for one and no longer
fails outside a project for a filesystem it never touches. Resolving eagerly
would have left that one shape permanently cwd-coupled with no way to fix it by
passing a hint. (b) `scripts/e2e-mcp-path-portability.mjs` did not catch this because
the paths are NESTED (`loads[].prg_path`) rather than top-level. The gate walks
nested schemas from now on; a rule that only sees the top level is a rule with a
hole in it, and this is the second finding on this one tool — the other being
that it is in the default surface at all (`e2e-mcp-project-inventory` 4c, red
before this spec and out of scope here).

### 5a. What the widened gate found — the hole is 15 tools wide

§5 presented D5 as one tool and one gate hole. Measured once the gate could see
nested schemas: of 70 default tools that take a path, **15 hand the resolver no
hint at all.**

| file | tools | shape |
|---|---|---|
| `server-tools/headless.ts` | `runtime_session_start`, `runtime_loader_lens`, `runtime_load_prg`, `runtime_run_prg`, `runtime_render_screen`, `runtime_recorder_dump` | `resolveHeadlessProjectDir(context)` — hintless at every call site, each try/caught, so the miss is silent. `prg_path` / `media_path` sit unused. |
| `server-tools/trace-store.ts` | the seven `trace_store_*` / `trace_memory_map` readers | a relative store path resolved against `proj ?? process.cwd()` — an explicit, commented cwd fallback |
| `server-tools/scene-reel.ts` | `runtime_scene_reel` | `context.projectDir()`, hintless and NOT caught — the closest twin to D5 |
| `server-tools/sandbox-depack.ts` | `sandbox_depack` | **declares `project_dir` and resolves with `ctx.projectDir(undefined, true)`** — the parameter a caller passes is read by nobody |

None were fixed here, on purpose: the brief was to find them, not to widen a
defect batch into a sweep. The gate freezes them in a `KNOWN_HINTLESS`
allowlist, so the hole can shrink and cannot grow.

`sandbox_depack` deserves naming twice. It advertises a parameter and ignores
it, which is this spec's own title in one line, in the file next door to the
one D5 fixes. §8 excludes it only on the *tier* question — its ignored
parameter is covered by nothing, and that is an omission in this spec rather
than a decision.

Two more things the build turned up, neither fixed:

- **`pathMode` in the tool matrix is a hand-kept name list**, not derived:
  `PATH_TOOLS` in `gen-mcp-tool-usecase-matrix.mjs` holds 24 names against 70
  real path-taking default tools, so `sandbox_6502_run` still reads `no-path`
  there. The live schema walk in the gate now supersedes that list as the source
  of truth; correcting the generated matrix would churn ~46 rows and belongs
  with whoever decides about the 15.
- `docs/tools/sandbox.md` opened by pointing at `src/sandbox/cpu6502.ts`, which
  no longer exists — the TypeScript shadow went when the real core landed.

### 5b. A working fact about the agents, learned twice

An agent given `isolation: "worktree"` is based on **master**, not on the
branch the parent is working in. Both 832 and 833 were written on a branch and
committed before the agents were launched, and both times every agent reported
the spec absent from its worktree. A spec an agent must read has to be on master
first, or its decisions have to travel in the prompt — which is what actually
carried them here, in both rounds.

### 1a. Corrections from the build

- **"the legacy path gets the names" conflates names with annotations.** Only
  NAMES can cross without an analysis context. `segments[].kind`,
  `pointerTables`, `jumpTables` and `immediates` retype ranges the ANALYSER
  produced, and on the legacy path there are no analysed segments to retype. The
  header now says exactly that rather than implying the file was applied whole.
- **The spec did not say what happens to an annotated address outside the image,
  or to one that falls mid-instruction.** Both needed a decision: out of image is
  skipped (the same range check the analysis path makes); mid-instruction gets an
  equate plus the name, which is the legacy twin of `renderAddressAliasLabels` —
  a linear decode cannot be split the way 830 splits an analysed one.
- **There is a third mode the spec did not mention:** relocation without
  analysis. It deliberately does NOT get the index — its sub-segment labels are
  runtime-addressed while the annotations are file-addressed, so applying both
  is a duplicate-definition hazard — and the header states that instead.

## 5c. Two more of the same shape — found during the build, fixed after it

Both are this spec's own title. They were recorded rather than folded in while
the three agents were running, and closed once they were:

**D6 — one identifier, one definition; one address, one name.** Two *explicit*
`labels[]` entries carrying the same name at different addresses both got a
definition, KickAssembler stopped at "already defined", and the byte-identical
rebuild this renderer exists to protect went red with nothing anywhere saying
why. `usedLabels` guarded routines (BUG-033) and, since D2, segments — it never
guarded the explicit labels it was seeded from. This predates 832 and is the
only item in this family that fails in the assembler rather than quietly in the
listing.

First wins, in file order, and the loser is reported in the tolerant-skip
summary — which is where a human already looks for "why did my annotation not
apply" — while the address keeps its auto-label so the rebuild stays green. The
same treatment covers one address named twice, which used to let the last entry
win silently: the same defect with the operands swapped.

**D7 — the wrapper looks where the renderer looks.** `hasAnnotations` in
`analysis-workflow.ts` checked beside the ASM only, while `loadAnnotations`
checks beside the PRG, beside the output ASM and beside the analysis JSON. A
file in either of the other two produced "NEXT STEP: create an annotations
file" printed over a listing that had just applied them. The wrapper now walks
the renderer's own candidate order, so the two agree.

Both are asserted in `e2e:833-render` rather than in a new gate — they live in
the files it already drives. Proven as a real gate by removing the D6 guard and
re-running: **6 failures**, including the KickAssembler rebuild.

## 6. Gates

- `e2e:833-render` — D1/D2/D3. A `disasm_prg` WITHOUT `analysis_json` applies
  the annotations and names them; the header line matches what happened in both
  modes; a segment annotation's label is defined; the rebuild stays
  byte-identical; and the graph-import line cannot be mistaken for a render
  result.
- `e2e:833-sectors` — D4. Every extracted sector file matches
  `t<tt>s<ss>.bin`; a checksum-failed sector is written under that name and
  carries `dataStatus: "checksum_error"`; the tool output reports the non-`ok`
  count.
- `e2e:833-sandbox` — D5. `sandbox_6502_run` resolves its project from
  `project_dir`, and from the first load path when that is absent, with no
  `C64RE_PROJECT_DIR` in the environment; and the portability gate sees a nested
  path parameter.

## 7. Acceptance

All three gates green and in `gates.yml`; every existing gate still green;
`e2e:830`, `e2e:832-*`, `smoke:741` and `e2e:741` unaffected.

## 8. Not in scope

`sandbox_6502_run` and `sandbox_depack` being in the default tool surface at all
(`e2e-mcp-project-inventory` 4c). It is red before this spec, it is a
tier-membership decision rather than a defect, and folding it in here would mix
a judgement call into a batch of corrections.
