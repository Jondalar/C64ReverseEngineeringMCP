# Spec 833 — A tool may not claim what it did not do

**Status:** PROPOSED 2026-09-09
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
(`ok` / `checksum_error` / `gcr_error`) is the truth, and the tool's own output
says how many sectors carry a non-`ok` status so nobody has to go looking. This
widens what matches `t<tt>s<ss>.bin` rather than narrowing it, so a reader that
already globs that pattern gains the custom-CRC sectors it was silently missing
and loses nothing.

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
all along. (b) `scripts/e2e-mcp-path-portability.mjs` did not catch this because
the paths are NESTED (`loads[].prg_path`) rather than top-level. The gate walks
nested schemas from now on; a rule that only sees the top level is a rule with a
hole in it, and this is the second finding on this one tool — the other being
that it is in the default surface at all (`e2e-mcp-project-inventory` 4c, red
before this spec and out of scope here).

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
