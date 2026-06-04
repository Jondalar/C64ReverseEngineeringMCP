# Spec 756 — ASM-first narrative annotation (split structure from prose)

**Status:** PROPOSED (2026-06-04)
**Owner:** annotation pipeline (`pipeline/src/lib/annotations.ts`,
`pipeline/src/lib/prg-disasm.ts`), the artifact/knowledge layer
(`save_finding` / Spec 055 `emitAnnotationFindings`), + a small new
curate/extract surface.
**Reference (grounded):** the Wasteland_EF `block2_engine_0200` semantic-annotation
session — measured 2026-06-04 (see §1). The current designed flow is the
three-phase model (CLAUDE.md): analysis → **annotation (`_annotations.json`)** →
verification (`disasm_prg` applies annotations → KickAssembler rebuild → `cmp -l`
byte-identical). This spec refines **phase 2**.
**Cross-links:** Spec 752 (extract-first grounding — what a block *is* comes from
the extracted bytes; this is how you *narrate* it), Spec 751 (effective-segments
overlay — the structural layer this keeps), Spec 055 (annotation→findings
auto-emit — the machine-readability this must preserve), Spec 047 (code-island
demotion — part of de-quirk), Spec 730 (artifact version store — the curated
`.asm` becomes a tracked artifact), Spec 754 §3.3f (the monitor `note`/`label`/
`xref` knowledge front-end — same findings sink), [[feedback_ui_browser_annotation]]
(layout/UX = browser-annotate; **plain narrative TEXT in code = in-file is fine**).

## 0. Principle (user, from Wasteland testing)
> "Es ist viel pragmatischer die .asm zu kopieren und direkt im File zu
> annotieren" — than to chase Accolade-Comics-quality semantics through a big,
> address-keyed JSON.

The JSON annotation layer is the right tool for **structure** (which bytes are
code vs data, the bulk `Wxxxx`→semantic label rename). It is the **wrong
authoring surface for narrative prose** (the routine-by-routine story). Authoring
prose where you do NOT read the code — inside escaped JSON strings keyed by
address, split across range-fragment files, with a disasm re-run to *see* the
result — does not scale to a real engine block. Annotate prose **in the `.asm`,
where you read it.**

## 1. The evidence (Wasteland_EF `block2_engine_0200`, measured)
One engine block, semantically annotated to the target quality. What it cost:

| Artifact | Size |
|---|---|
| `block2_engine_0200_disasm.asm` (the result) | 6,456 lines / 362 KB — **423** `// annotation` / prose blocks rendered in |
| `block2_engine_0200_annotations.json` | 4,421 lines / 108 KB → **81 segments, 720 labels, 104 routine descriptions** |
| `block2_engine_0200_disasm_annotations.json` | **exact byte-duplicate** of the above (108 KB) |
| `…annotations.draft.json` | 27 KB |
| range-fragment files (`0A00_0FFF`, `2600`, `0500_09FF`) | 30 + 29 KB + a 3-line stub |
| `block2_engine_0200_analysis.json` (heuristics) | 3.5 MB / 138k lines |
| `analysis/runs/…block2-engine…` | **40** disasm/analyze re-runs, 1.1 MB |

Annotation JSON alone (excluding heuristics) ≈ **300 KB across 5+ fragmented /
duplicated files**; total JSON to the one file ≈ **10× the `.asm`**. The block
rebuilds byte-identical (`block2_engine_0200_disasm_rebuild_check.prg` exists) —
**the pipeline worked; the output is correct.** The cost was the *authoring loop*,
not the result. Smells: a pure byte-duplicate canonical/`disasm_` file (which does
`disasm_prg` read?), a `.draft`, per-range fragmentation (the 6,456-line block was
too big for one JSON pass → chopped), and 40 re-runs (round-trip-to-see-prose).

## 2. Diagnosis — phase 2 conflates three jobs in one JSON
1. **Segment de-quirk** (81 here) — data/code reclassification. *Must* be
   structured and run *first*: it changes how bytes are rendered. In-file is
   impossible (un-de-quirked bytes are already mis-disassembled). → keep JSON
   (Spec 751 effective-segments).
2. **Bulk label rename** (720) — `W1DD2`→`api_print_string` across all reference
   sites. JSON is good for the *initial* bulk pass (one entry repoints every
   caller). **After** that, the assembler resolves symbolic labels — a label
   defined once is referenced by name everywhere, so an in-file rename of the
   definition propagates at assemble time. JSON is not needed for label *tweaks*.
3. **Routine narrative** (104) — the Accolade-quality story. **JSON is the wrong
   surface.** This is where all the pain is: multi-paragraph prose as escaped
   JSON strings, address-keyed, detached from the code, fragmented, re-run to
   view.

## 3. Design — the two-layer workflow
**Structure → freeze → narrate in-file → guard + extract.**

### 3.1 Structural layer (unchanged — the JSON pipeline's real win)
Run analysis + the JSON annotation pass for **segments + the initial bulk label
rename only** (Spec 751 / 055). This produces a correct, semantically-labelled,
**byte-identical-rebuilding** `.asm`. This layer is small, stable once de-quirked,
genuinely needs to be addressable/re-appliable, and is verified by `cmp -l`.

### 3.2 Curate: the `.asm` becomes a first-class, frozen artifact
A `curate_asm` step promotes `<name>_disasm.asm` to a **curated** artifact
(`<name>_curated.asm` or a tracked version, Spec 730) that is:
- the **human/LLM work surface** for narrative,
- **decoupled from re-disasm** — `disasm_prg` no longer overwrites it (this is the
  "copy" the user wants; it solves "re-disasm wipes my annotations" by simply not
  regenerating the curated copy),
- version-tracked (Spec 730 artifact version store; the raw `_disasm.asm` stays as
  the regenerable lineage root).

### 3.3 Narrate: annotate prose directly in the curated `.asm`
Free-form: block headers, routine narratives, inline line comments, label renames
— written where you read. No JSON, no round-trip, no fragmentation. This is the
phase the user is right about.

### 3.4 Guard: the re-assemble gate keeps it honest (the safety net)
A `check_curated_asm` gate assembles the curated `.asm` (KickAssembler) and
`cmp -l` against the original PRG. **Comments/labels never change bytes; a prose
edit that accidentally touches a byte/directive fails the gate.** This is what
makes in-file editing *safe* — the same byte-identical contract the JSON flow had,
applied to the curated file.

### 3.5 Extract: recover machine-readability (the bridge)
In-file prose is invisible to the knowledge layer (search/xref/findings). An
`extract_asm_annotations` step parses the curated `.asm` — labels + block/line
comments + routine headers — and emits **findings/entities** (Spec 055
`emitAnnotationFindings` parity) so `project_search` / `xref` / the Spec 754
monitor `note`/`xref` still see the narrative. The `.asm` is the source of truth;
the structured knowledge is *derived* from it (the inverse of today). Idempotent +
re-runnable on edit.

### 3.6 What this removes (anti-patterns, from §1)
- No per-range annotation **fragmentation** (`_0A00_0FFF_`, `_2600_`) — one curated
  `.asm` holds the whole block.
- No **duplicate** canonical/`disasm_` annotation files — one source of truth.
- No `.draft` parallel artifact — the curated `.asm` *is* the draft and the final.
- No **re-run-to-see-prose** loop — you see it as you type it.

## 4. Phases
- **P1 — curate + guard.** `curate_asm` (promote/freeze the `.asm`, decouple from
  `disasm_prg`, version-track) + `check_curated_asm` (KickAss + `cmp -l` gate).
  This alone delivers the user's workflow safely.
- **P2 — extract back to knowledge.** `extract_asm_annotations`: curated `.asm` →
  findings/entities (Spec 055 parity), idempotent. Restores search/xref.
- **P3 — split the JSON pass.** Make the phase-2 JSON do *structure only* (segments
  + bulk label) by default; deprecate authoring routine-prose into
  `_annotations.json` (keep read-compat for existing projects like Wasteland). Doc
  the workflow in `docs/re-phases.md`.

## 5. Open questions
- **OQ1 — curated-`.asm` identity.** A new file (`_curated.asm`) or a Spec 730
  *version* of the existing `.asm` artifact (regenerable raw = V0, curated = V1)?
  (Lean: a tracked version — keeps lineage + the "show all versions" UI.)
- **OQ2 — extractor fidelity.** How structured must the in-file convention be for a
  clean extract — free-form comments + a light marker (e.g. the existing
  `// annotation` / `═══` block style already in the Wasteland `.asm`), or a small
  agreed header grammar? (Lean: parse the block-comment-before-label convention the
  pipeline already emits, so existing curated files extract with no rework.)
- **OQ3 — migrate Wasteland block_02?** It is already at target quality + rebuilds.
  Adopt it as the first curated artifact (collapse the duplicate/draft/fragment
  files) to validate P1+P2 on a real, finished block.

## 6. Non-goals
- NOT removing the JSON structural layer (segments + bulk label stay — §3.1).
- NOT byte-editing via the curated `.asm` (still comments/labels only; the gate
  enforces it).
- NOT a UI annotation surface (that is the browser-annotate flow,
  [[feedback_ui_browser_annotation]]); this is plain in-file *text* for code.
- NOT a new assembler dialect (KickAss/64tass via the existing pipeline).

## 7. Acceptance
- P1: a curated `.asm` can be hand-annotated, survives a `disasm_prg` re-run of the
  raw lineage (not overwritten), and `check_curated_asm` is GREEN (byte-identical)
  — and FAILS on a deliberate byte edit.
- P2: `extract_asm_annotations` on the curated Wasteland `block2_engine_0200`
  surfaces its 720 labels + 104 routine narratives as findings/entities that
  `project_search` / `xref` return — with zero hand JSON authored.
- P3: a fresh block's phase-2 JSON contains only segments + labels (no prose); the
  narrative lives in the curated `.asm`; gate `e2e:756`.
