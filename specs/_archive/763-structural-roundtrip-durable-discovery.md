# Spec 763 — Structural round-trip + durable discovery inputs

**Status:** PROPOSED (2026-06-07)
**Owner:** the disassembly/annotation pipeline
(`pipeline/src/analysis/pipeline.ts` `deriveEntryPoints`,
`pipeline/src/lib/annotations.ts` schema, `pipeline/src/lib/prg-disasm.ts`
reclassify + packer-detect), the extract surface introduced by Spec 756
(`extract_asm_annotations`).
**Reference (grounded):** the Wasteland_EF `$7E00` code-overlays session, measured
2026-06-07 (see §1). Sibling to Spec 756 on a different axis.
**Cross-links:** Spec 756 (ASM-first **narrative** round-trip — this is the
**structural** round-trip; same `extract_asm_annotations` machine, the other half),
Spec 758 (static code-discovery completeness — entry-point seeding lives here),
Spec 759 (cross-artifact ABI/xref — why overlay call-sites resolve but bodies do
not), Spec 751 (effective-segments overlay — the structural layer this persists),
Spec 047 (code-island demotion — the mechanism that buried the overlay code),
Spec 720 (disasm output quality). [[project_spec758_code_discovery]],
[[project_spec759_xref_abi]].

## 0. Principle
Spec 756 makes the **prose** you write in the `.asm` recoverable. This spec makes
the **structure** you fix by hand in the `.asm` — *which bytes are code, where
execution enters* — recoverable too, and **persistent across re-disassembly**.

The single highest-value quality fix on a real overlay is not narrative. It is
*getting the disassembler to cover the real code at all*. Today that fix
(`userEntryPoints`) lives only in a CLI invocation — flushed on the next run. The
`.byte`-soup returns. This spec closes that durability hole and lets the corrected
`.asm` feed the structural layer back, the inverse of today.

## 1. The evidence (Wasteland_EF `$7E00` overlays, measured 2026-06-07)
Pipeline-output overlays vs the hand-corrected working copy of the **same** PRG
(`ovl_T8b20_7E00.prg`, rebuilds byte-identical both ways):

| File | Entry points | `$7F07–$823A` region |
|---|---|---|
| `overlays/T8b20-utils.asm` (pipeline) | **2** (`$7E00`, `$7E06`) | `unknown` conf=0.28, `analyzers=code-island-demote` → dumped as `.byte` soup |
| `src/ef_overlay_utils.asm` (hand) | **12** (`$7F16`, `$80FE`, `$818A`, …) | decoded as `code` segments |

The bytes are unambiguous code (`$20,$2F,$02` = `jsr $022F`; `$C9,$CE` = `cmp #$CE`;
`$F0,$0D` = `beq`). They are buried because:

- the overlay body is entered **only** through the engine's API jump table
  (`jsr $02xx` into block2, a *different* module) and menu-return paths — the
  recursive traversal from `$7E00`/`$7E06` never reaches it (Spec 759: call-sites
  resolve cross-artifact, bodies do not);
- `code-island-demote` (Spec 047) then knocked the un-anchored probable-code down
  to `.byte`;
- a **false** `exomizer_sfx (conf=0.85), unpacked ≈ 258 bytes` packer warning sits
  in the header of a file that rebuilds byte-identical and is plainly code+text.

The hand-fix, quoted from the hand file's own header:
> "Base = MCP analyze_prg/disasm_prg **re-run with the dispatch entry points**
> (defeats the exomizer false-positive that demoted the disk code to .byte), then
> a manual annotation pass."

The author found the fix. The tooling cannot **keep** it: there is no schema field
for it, and a re-disasm without the hand-typed entry list reverts to soup.

## 2. Diagnosis — three structural gaps, none in Spec 756
1. **Entry points are not durable.** `deriveEntryPoints(mapping, buffer,
   options.userEntryPoints)` (`pipeline.ts:455`) takes entries as a **runtime CLI
   arg** only. `AnnotationsFile` (`annotations.ts:76`: `segments, labels, routines,
   pointerTables, jumpTables, immediates`) has **no `entryPoints` field**. The most
   important discovery input cannot be saved.
2. **The structural extract is one-way out, never back in.** Spec 756
   `extract_asm_annotations` recovers prose → findings. It does not recover the
   hand-made `kind=code` reclassification or the entry points *back into the
   structural annotation layer*, so regenerating the raw lineage still produces
   soup — the corrected structure lives only in the frozen copy.
3. **The packer detector false-positives** and the warning has no de-quirk: a
   byte-identical-rebuilding file that the code/text analyzers claim is still
   labelled "compressed payload", which both misleads the reader and (per the hand
   note) participates in demoting real code to `.byte`.

## 3. Design — persist discovery, extract structure back, de-quirk the warning

### 3.1 `entryPoints[]` in the annotation schema (durability)
Add to `AnnotationsFile`:
```ts
entryPoints?: EntryPointAnnotation[];   // user/derived seed addresses for recursive traversal
forceCodeRanges?: ForceCodeAnnotation[]; // ranges the human decoded as code (anchor against island-demote)
```
```ts
interface EntryPointAnnotation { address: string; origin?: "user" | "extracted" | "xref"; comment?: string; }
interface ForceCodeAnnotation  { start: string; end: string; comment?: string; }
```
Thread `entryPoints` into `deriveEntryPoints` (union with `userEntryPoints`, dedup)
and `forceCodeRanges` into the reclassify/island-demote stage as a trusted anchor
(an explicit anchor must beat `code-island-demote`, Spec 047). Now the fix is
saved, versioned, and **survives re-disassembly** — re-running `disasm_prg` on the
raw lineage reproduces the covered code, not the soup.

### 3.2 `extract_asm_annotations` recovers structure (the inverse, completed)
Extend the Spec 756 extractor (same parse pass, PC-tracked, validated by the
byte-identical rebuild — §3.4 below) to recover, **back into `_annotations.json`**:
- **entry points** — from `// @entry $XXXX` markers and/or the header
  `Entry points:` line the disasm already emits;
- **`kind=code` reclassifications** — any range the analysis called data/unknown
  that the curated `.asm` decodes as instructions → `forceCodeRanges[]` (the
  rebuild proves the decode is correct);
- (prose/labels stay as Spec 756 defines them).

The corrected `.asm` is the source of truth; the structural JSON is *derived from
it*. Edit the readable artifact → regeneration improves with it.

### 3.3 The `.asm` structural contract (light, machine-liftable)
Minimal vocabulary — only for what KickAssembler does not already say natively
(labels, `#<label`/`#>label` immediates, `.byte`-vs-ops are read natively):
```asm
// @entry $7F16                  → entryPoints[]
// @code $7F07-$823A             → forceCodeRanges[]   (or edit the `// SEGMENT … code` header verbatim)
```
Rules that keep the lift unambiguous: one label per address on an instruction
boundary; the `// SEGMENT $start-$end <kind>` header line the disasm already emits
is read verbatim as segment kind; `// @entry`/`// @code` are the only new tokens.

### 3.4 The byte-identical rebuild is the validation anchor
PC-tracking the curated `.asm` back to addresses is exact **only while the rebuild
is byte-identical**. The Spec 756 `check_curated_asm` gate (`cmp -l`) is therefore
this spec's safety net too: a hand edit that breaks byte-equality fails the gate,
and the structural extractor refuses rather than emit drifted addresses. Fail-loud,
never silent.

### 3.5 De-quirk the packer false-positive
Suppress the `compressed payload` header warning when the file rebuilds
byte-identical **and** code/text analyzers claim the majority of bytes; demote it
to an informational note that does not feed `code-island-demote`. (Keep the warning
for genuinely-packed, unclaimed payloads.)

## 4. Phases
- **P1 — durable discovery.** `entryPoints[]` + `forceCodeRanges[]` in the schema;
  wire into `deriveEntryPoints` + reclassify/island-demote. A saved annotation now
  reproduces the covered disasm with no CLI entry-list. (Delivers the overlay fix
  permanently on its own.)
- **P2 — structural extract-back.** Extend Spec 756 `extract_asm_annotations` to
  emit `entryPoints[]` + `forceCodeRanges[]` from the curated `.asm`. Round-trip
  closed: corrected `.asm` → structural JSON → re-disasm matches.
- **P3 — de-quirk.** Packer-warning suppression on byte-identical + claimed files;
  unhook it from island-demote.

## 5. Open questions
- **OQ1 — anchor precedence.** Should `forceCodeRanges[]` hard-override
  `code-island-demote` (Spec 047) unconditionally, or only when the range
  disassembles cleanly to the segment end? (Lean: unconditional — the human +
  `cmp -l` gate already proved it.)
- **OQ2 — entry-point provenance.** Keep `origin` (`user`/`extracted`/`xref`) so a
  later Spec 759 xref pass can *propose* entries (call-table targets into the
  overlay) and the human only confirms? (Lean: yes — auto-seed from the API jump
  table, since that is exactly what was hand-listed.)
- **OQ3 — share the extractor with 756.** One `extract_asm_annotations` pass emits
  both prose-findings (756) and structural JSON (763), or two passes over one
  parse? (Lean: one parse, two sinks.)

## 6. Non-goals
- NOT byte-editing via the `.asm` (comments/labels/structure-markers only; the
  `cmp -l` gate enforces it — same contract as 756).
- NOT replacing recursive traversal with linear disasm — `forceCodeRanges`/entries
  *seed* the existing recursive discovery (Spec 758), they do not bypass it.
- NOT auto-trusting xref-proposed entries without confirmation (OQ2 stays
  human-gated by default).
- NOT a new packer detector — only de-quirking the existing one's false-positive.

## 7. Acceptance
- P1: an `_annotations.json` carrying `entryPoints[$7F16,$80FE,$818A,…]` +
  `forceCodeRanges[$7F07-$823A]` makes `disasm_prg` on `ovl_T8b20_7E00.prg`
  produce the `$7F07+` region as **code**, with **no** CLI entry-list, and the
  result rebuilds byte-identical.
- P2: `extract_asm_annotations` on the hand-corrected `src/ef_overlay_utils.asm`
  recovers its 12 entry points + the `$7F07+` code reclassification into
  `_annotations.json`; re-running `disasm_prg` with that JSON reproduces the
  covered disasm (round-trip idempotent).
- P3: `T8b20-utils.asm`'s false `exomizer_sfx` warning is gone on the
  byte-identical, code/text-claimed file; a genuinely-packed payload still warns.
- Gate `e2e:763`.
