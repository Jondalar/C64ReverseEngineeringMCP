# Spec 019: Disasm Quality — Text Encoding, Sprite Heuristic, Code-Island Demotion

## Problem

Three open BUGREPORT items still cause silent or noisy disasm output:

- **Bug 8** — text classifier emits `screen_code_text` for printable
  PETSCII ranges. KickAssembler `.text` translates PETSCII to screen
  codes, so the rebuilt PRG is byte-different. Murder PRGs `11_riv1`,
  `12_riv2`, `15_love` rebuild non-byte-identical because of this.
- **Bug 11** — sprite analyzer marks 1541 T1/S0 buffer (jump-table
  starting with `JMP $0340`) as `sprite` with confidence `1.00`.
- **Bug 5/6 follow-up** — defensive renderer fixes ship; the
  underlying classifier still mints code islands inside random data
  whose branches land outside any labelled segment.

## Goal

Eliminate the silent rebuild divergence for printable-PETSCII spans,
stop the sprite analyzer from claiming jump-tables as sprites, and
demote code islands whose branches do not resolve cleanly.

## Approach

### Text classifier (Bug 8)

In `pipeline/src/lib/prg-disasm.ts` rendering path:

1. When a segment is classified `screen_code_text` AND every byte is
   in `[\x20-\x7E]` (printable PETSCII range), render as a `.byte`
   list with an inline `// "..."` ASCII comment instead of `.text`.
   `.byte` always rebuilds byte-identical.
2. Honor explicit annotation overrides: a `SegmentAnnotation` of kind
   `petscii_text` keeps PETSCII rendering; `screen_code_text` forces
   screen-code emission for that span only.
3. Default the heuristic toward "safe": when uncertain emit `.byte`.

### Sprite analyzer (Bug 11)

In the sprite analyzer (`pipeline/src/analysis/`):

1. Pre-check first 3 bytes of a candidate range. If they decode as a
   valid 6502 `JMP`/`JSR` whose target lies inside the same range,
   cap confidence at `0.3`.
2. If high-byte distribution looks like aligned 16-bit address pairs
   (alternating `[$00-$7F][$80-$FF]` pattern, or pairs that all point
   into 1541 ROM `$A000-$BFFF` / KERNAL `$E000-$FFFF`), cap confidence
   at `0.3`.
3. Document the heuristic in the analyzer header comment.

### Code-island demotion (Bug 5/6 follow-up)

After cross-reference resolution in the prg-disasm pass:

1. For each code island, walk its instructions; for each relative
   branch, check whether the target lands inside an `unknown` or
   `data` segment.
2. If yes AND the island contains a `JAM` opcode or two adjacent
   undocumented opcodes, mark the island for demotion to `data`.
3. Re-render the demoted island as `.byte` data and re-resolve
   xrefs. Iterate until fixed point or 3 passes (whichever first).

## Acceptance Criteria

- Murder PRGs `11_riv1`, `12_riv2`, `15_love` pass
  `assemble_source --compare_to=<orig>` byte-identical.
- 1541 T1/S0 buffer extracted from the BWC project no longer
  classifies as `sprite` with confidence ≥0.5.
- A synthetic fixture under `fixtures/code-island-demotion/` (added
  with this sprint) reproduces a `BVC` into stochastic data and
  rebuilds byte-identical after the demotion pass.

## Tests

- Extend `scripts/disasm-rebuild-smoke.mjs` (or add it) to run
  `analyze_prg` + `disasm_prg` + `assemble_source --compare_to` on a
  small fixture set and fail the build if any rebuild diverges.
- Unit test in `pipeline/src/lib/__tests__/text-classifier.test.ts`
  covering printable-PETSCII, mixed, and pure screen-code ranges.

## Out Of Scope

- Petscii ↔ screen-code reversible round-trip via `.text`. Keep
  `.byte` as the safe default; reversibility through `.text`
  requires assembler-side encoding overrides not all dialects honor.
- Refactoring the analyzer dispatch layer.

## Risks

- Heuristic tuning regressions on non-Murder corpora. Mitigation:
  run rebuild-verify against the BWC project before merging.
- Sprint 16 touches the same renderer paths as Sprint 17 (platform
  awareness). Land 16 first; Sprint 17 rebases.
