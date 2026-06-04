# Spec 759 — Cross-artifact symbol/ABI awareness in static disassembly (shift-left)

**Status:** PROPOSED (2026-06-04) — mini-spec, user sidequest.
**Scope:** the phase-1 static disassembler (`pipeline/src/analysis/code-discovery.ts`
recursive descent + xref derivation, `pipeline/src/lib/prg-disasm.ts` rendering)
+ a NEW project-level address-knowledge index. Today phase-1 is **per-file**; this
makes it **project-aware**.
**Cross-links:** Spec 758 (single-file code-discovery completeness — the companion;
this adds the *cross-file* dimension), Spec 754 §3.3f + Block H (the same
address→artifact gap the monitor `inspect`/`xref` hit — one shared need), Spec 751
(effective-segments overlay — the per-artifact label/kind source), Spec 741
(relocated disasm — relocated ranges are part of the layout), Spec 752 (extract-first
grounding), Spec 023 (loadContexts), Spec 034 (seven-phase). Grounded in the
Wasteland_EF engine work ([[project_motm_ef_port]] is the EF mechanics;
[[project_spec754_monitor]] the monitor side).

## 0. Principle (user)
> "Aus Wasteland: es gibt eine Engine die im Grunde alles macht, + dynamische
> Anteile die die Engine dazu lädt. ABIs wie Jumptables werden von mehreren Files
> benutzt. Cool wäre, wenn phase-1b static-disassemble sowas schon einbezieht —
> bessere Qualität, weniger unknown-segments, bessere Pipelines (shift-left)."

A file does not exist in isolation. When the static disassembler **knows what the
other artifacts already are** — especially shared ABIs (jumptables, entry points)
— a cross-file reference resolves to a *named, typed* target instead of an unknown.
Resolve it once, early (shift-left); every downstream phase benefits.

## 1. The problem
Phase-1 (`analyze_prg`) disassembles **one PRG at a time**. A reference that leaves
the file — `JSR $022A` into the resident engine's API table, a pointer to a shared
table, an overlay calling down into the engine — has **no local target**, so:
- the target is an **unknown segment** (no kind, no label),
- the call renders as `jsr $022a` (a bare address), not `jsr api_turn_advance`,
- downstream phases (annotation, semantic, rebuild) inherit the unknowns + must
  re-derive (or never derive) the cross-file meaning.

The knowledge EXISTS — it's in the *other* artifact's `_analysis.json` +
`_annotations.json` (the engine's 720 labels, its API table) — but phase-1 never
reads it.

## 2. The Wasteland case (concrete)
- `block2_engine_0200` ($0200-…): the resident engine. Its `$0200-$04FF`
  **API jumptable** (197 `JMP abs` entries) is the single contract surface; each
  entry has a semantic label (`$022A api_turn_advance → turn_advance $2514`,
  `$0274 api_print_string → print_string $1DD2`, …). 81 segments, 720 labels,
  104 routines (the annotation work).
- `block3_game_7E00` ($7E00) + per-area scene overlays call **down** into the
  engine: every external caller does `jsr $02xx/$03xx/$04xx` onto the jumptable.
- When phase-1 disassembles block3, those `$02xx` targets are **outside block3** →
  unknown. block3's listing shows `jsr $022a`, not `jsr api_turn_advance`, and the
  engine-call sites don't seed block3's code discovery / xrefs.

If phase-1 KNEW the engine's API table (project-wide), block3 would render the named
calls, classify the jumptable region correctly, and produce far fewer unknowns.

## 3. Design
Three pieces; the index is the keystone.

### 3.1 Project address-knowledge index (new)
A project-level, cached aggregate (one home; reused by phase-1 AND the Spec 754
monitor `inspect`/`xref`, which need the same address→artifact map):
- For each analyzed artifact: its **load range** + its **effective segments**
  (`loadEffectiveSegments`, Spec 751 — kind/label, annotation-overlaid) + its
  **entry labels** (routine/label addresses) + declared **ABI surfaces** (§3.3).
- Indexed by address → `{ owner, label?, kind, isAbiEntry?, abiTarget? }`, scoped
  by **load-context** (§3.2). Built/updated when an artifact is (re)analyzed;
  cached under `knowledge/.cache/` (Spec 740 pattern), invalidated on artifact
  change. NO embeddings — a deterministic address map.

### 3.2 Load-layout (which artifact lives where)
The index must know the runtime layout: engine resident at $0200, game at $7E00,
overlays swapped in at their load addresses. Sources, in order: each artifact's
**load address** (PRG header / `loadContexts`, Spec 023) + size; relocated ranges
(Spec 741 `.pseudopc`); the disk/EF structure (which files are resident vs
dynamically loaded). Overlapping artifacts (overlays sharing an address, EF
banking) are **load-context-scoped** — a reference resolves within the *active*
layout, with ambiguity surfaced (not silently picked). (This is the same map Spec
754 Block H needed for the monitor — build it once, share it.)

### 3.3 Phase-1 consults the index (the shift-left)
In `code-discovery` (recursive descent + xref derivation) and `prg-disasm`
rendering, a reference (`JSR`/`JMP`/branch/`read`/`write`/pointer) whose target is
**outside the current file** but **inside another artifact's known range**:
- resolves to that artifact's **label + kind** → the call renders named
  (`jsr api_turn_advance`), the xref records the cross-artifact target,
- does NOT create a local unknown segment for the foreign target (it's known
  elsewhere) — fewer unknowns,
- **ABI/jumptable transitivity:** a reference INTO an ABI surface (the engine's
  `$0200-$04FF` table) resolves to the entry's label AND its `JMP` target (so a
  caller sees both `api_turn_advance` and `→ turn_advance $2514`). An artifact
  declares its ABI surfaces (an address range of entry-table) in its analysis /
  annotations; the index exposes them project-wide.

Non-destructive + grounded (Spec 752): this adds *resolution*, not new bytes; a
cross-file label is sourced from the owning artifact's analysis, not guessed.

## 4. Phases
- **P1 — the index + load-layout reader.** Build the project address-knowledge
  index from analyzed artifacts (`loadEffectiveSegments` + load ranges), cached.
  Expose a `resolveCrossArtifact(addr, loadContext?)` query. (Also unblocks Spec
  754 Block H's daemon `inspect`/`xref` address→artifact resolution — share it.)
- **P2 — phase-1 consults it.** `code-discovery` + `prg-disasm` resolve out-of-file
  references through the index → named cross-calls, fewer unknowns, cross-artifact
  xrefs. Re-run on Wasteland block3 → the `$02xx` engine calls render as
  `api_*`; unknown-segment count drops.
- **P3 — ABI surfaces.** Declared entry-table/jumptable ranges + transitive
  resolution (entry → its JMP target). The engine's `$0200-$04FF` table becomes a
  project-wide ABI.

## 5. Open questions
- **OQ1 — load-layout source of truth.** Derive from load addresses + loadContexts
  alone, or a declared per-project layout file (resident vs dynamic, EF banks)?
  Wasteland EF has a resident engine + dynamic overlays — needs more than the PRG
  header. (Lean: derive what we can + an optional declared override.)
- **OQ2 — overlap/banking.** Overlays + EF banks put different code at one address.
  Scope by load-context; how does phase-1 (static, no runtime) pick the context?
  (Lean: index per-context; a reference resolves within the artifact's own context,
  ambiguity flagged.)
- **OQ3 — staleness.** The index aggregates other artifacts' analysis; if the
  engine is re-analyzed, dependents are stale. Rebuild-on-read vs invalidate?

## 6. Non-goals
- NOT runtime tracing (this is STATIC, phase-1; the trace memory-map / taint is the
  runtime view — Spec 753).
- NOT a guesser — cross-file labels come from the owning artifact's analysis/
  annotations, never invented (Spec 752 grounding).
- NOT single-file discovery (that's Spec 758 — this is the orthogonal cross-file
  layer; they compose).

## 7. Acceptance
- Re-analyzing Wasteland `block3_game_7E00` with the index: the engine API calls
  (`jsr $02xx/$03xx/$04xx`) render with the engine's labels (`api_*`), and the
  unknown-segment count drops measurably vs the per-file baseline.
- `resolveCrossArtifact($022A)` returns the engine artifact + `api_turn_advance`
  (+ its `JMP` target) — and the same query backs the Spec 754 monitor `xref`/
  `inspect` address→artifact resolution (one shared index).
- Gate `e2e:759`: a 2-artifact fixture (engine + caller) where the caller's
  cross-file `JSR` resolves to the engine's label and produces no unknown segment
  for that target.
