# Bug: Spec 741 fixture — relocated loader is demoted to unknown instead of rendered as runtime code

- **ID:** BUG-021
- **Date:** 2026-05-31
- **Reporter:** codex
- **Area:** analysis
- **Severity:** high
- **Status:** fixed (Spec 741 Slices A–D)

## Environment

- Branch / commit: master around `0cc6e570`
- Surface: MCP default / analysis pipeline / workspace UI source overlay
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: `analyze_prg`, `disasm_prg`, Disk tab `.asm/.tass` action
- Owner spec: `specs/741-relocated-code-pseudopc-disasm.md`

## What happened

The Phase-1 disassembly for Wasteland side 1 payload `02_2.0.prg` demotes the
whole `$C000-$C0F5` installer/loader entry block to `unknown`. The analyzer's own
score says recursive traversal reached 232 bytes from a trusted entry point and
keeps `code` as a high-confidence alternative, but `code-island-demote` wins
because the larger segment also contains command/text/table bytes near the end.

The manually/semantically corrected version proves the correct shape: the region
is mixed code + data, not unknown. It should be split into several code segments
from `$C000-$C0E7` plus a small command/table tail at `$C0E8-$C0F5`.

This is also the first small visible symptom of the larger Spec 741 problem:
Wasteland's loader copies code/data from stored addresses to runtime addresses
(`$C300→$FC00`, `$C27A→$DD80`, `$C17B→$5B00`). Without relocation-aware analysis
and `.pseudopc` / `.logical` rendering, the most important loader regions are
either rendered as `.byte` walls or interpreted at the wrong PC.

The current Wasteland blueprint for the desired output is
`02_2.0_full.asm`: one canonical source file for the whole `02_2.0.prg`
payload, with in-place installer code plus internal `.pseudopc` blocks for
the relocated regions. The fix should not split this payload into multiple
default source files.

## Expected

The analysis pipeline should not demote a whole trusted-entry code island just
because the island also contains pointer-referenced data or command strings.
For relocated regions, it should additionally render the bytes as code at their
runtime address while keeping the source byte-exact at the stored address, per
Spec 741.

Expected behaviour for this class of loader/installer:

- preserve reachable valid code as `code`;
- split mixed code/data islands at invalid/unreached/data-tail boundaries;
- identify address-taken command/string/table data separately;
- detect/propose relocated regions such as `$C300→$FC00`, `$C27A→$DD80`,
  `$C17B→$5B00`;
- render accepted relocated code with assembler-native relocation directives:
  KickAssembler `.pseudopc`, 64tass `.logical`;
- render the initial disassembly as useful code without requiring a hand-written
  semantic pass to recover obvious control flow.

## Repro steps

1. Use Wasteland EF side 1 payload:
   `/Users/alex/Development/C64/Cracking/Wasteland_EF/analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0.prg`
2. Inspect:
   `/Users/alex/Development/C64/Cracking/Wasteland_EF/analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0_analysis.json`
3. Inspect generated disassembly:
   `/Users/alex/Development/C64/Cracking/Wasteland_EF/analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0_disasm.asm`
4. Compare against the corrected semantic source:
   `/Users/alex/Development/C64/Cracking/Wasteland_EF/analysis/disk/wasteland_s1[ea_interplay_1988](!)/02_2.0_semantic.tass`

Minimal command / call:

```text
analyze_prg / disasm_prg on 02_2.0.prg, then inspect the $C000-$C0F5 segment.
```

## Evidence

- Wrong Phase-1 output:

```text
// SEGMENT $C000-$C0F5  unknown  confidence=0.15  analyzers=code,code-island-demote,resolver
// Demoted from code (Spec 047): contains 6 JAM opcode(s); 2 branch(es) target data/unknown.
```

- Analyzer score still contains the useful signal:

```json
{
  "kind": "unknown",
  "start": 49152,
  "end": 49397,
  "score": {
    "reasons": [
      "Demoted from code (Spec 047): contains 6 JAM opcode(s); 2 branch(es) target data/unknown.",
      "Recursive traversal reached 232 bytes from a trusted entry point.",
      "Control-flow edges remained valid within $C000-$C0E7.",
      "No analyzer claimed this range strongly enough."
    ],
    "alternatives": [
      {
        "kind": "code",
        "confidence": 0.94,
        "reasons": [
          "Recursive traversal reached 232 bytes from a trusted entry point.",
          "Control-flow edges remained valid within $C000-$C0E7.",
          "Region starts at an explicit execution entry/trampoline."
        ]
      }
    ]
  }
}
```

- Correct semantic shape from the real project:

```text
$C000-$C00F  code
$C010-$C025  code
$C026-$C035  code
$C036-$C049  code
$C04A-$C058  code
$C059-$C0AF  code
$C0B0-$C0BB  code
$C0BC-$C0C6  code
$C0C7-$C0D3  code
$C0D4-$C0E7  code
$C0E8-$C0F5  lookup_table
```

- Artifacts:
  - `02_2.0_disasm.asm`
  - `02_2.0_semantic.tass`
  - `02_2.0_full.asm` — target shape for Spec 741: one payload, one canonical source file, internal `.pseudopc` regions
  - `02_2.0_semantic_annotations.json`

## Scope guess (optional)

This bug is not a separate implementation track. It is the concrete Wasteland
fixture / acceptance case for `specs/741-relocated-code-pseudopc-disasm.md`.

Likely areas:

- PRG analyzer code-island demotion / segment resolver / static control-flow
  segmentation;
- relocation proposal detection in `analyze_prg`;
- relocation-aware rendering in `disasm_prg`;
- byte-exact verification through `assemble_source`.

Concrete solution approaches:

1. **Mixed island splitter.** When a trusted-entry traversal is mostly valid but
   demotion is triggered by invalid bytes or data-target branches, split the
   island instead of demoting the entire range. Keep the recursively reached
   valid instruction ranges as `code`; isolate the invalid/unreached tail as
   data/unknown.
2. **Address-taken data detection.** Detect simple KERNAL command/string patterns
   such as `LDX #<addr`, `LDY #>addr`, `JSR $FFBD` / `JSR $FFBA` / `JMP $FFC0`;
   mark the pointed region as text/lookup data so it does not poison nearby code.
3. **Demotion policy change.** A high-confidence `code` alternative from a
   trusted entry should not be overridden by `code-island-demote` unless the
   invalid opcodes are themselves reached as instructions. Data bytes inside the
   same coarse segment should force a split, not a full demotion.
4. **Relocation-aware render path (Spec 741).** When the analyzer or user supplies
   a relocation map, `disasm_prg` should disassemble the stored bytes with the
   runtime PC and emit `.pseudopc` / `.logical` so labels and branches are
   readable but the assembled bytes still match the stored payload.
5. **Use semantic output as blueprint, not as fixture dependency.** The real
   Wasteland file is the observed blueprint. The repo gate should use a small
   synthetic PRG that reproduces the same structure: trusted entry code, pointer
   to command/string data, invalid/text bytes after code, and a valid assembler
   rebuild.

Suggested acceptance gate:

```text
scripts/smoke-741-relocated-code-pseudopc.mjs
```

Gate assertions:

- analyzer no longer emits one `unknown` segment covering the whole mixed island;
- trusted entry code remains `code`;
- command/string/table tail is split to data/text/lookup;
- analyzer proposes the Wasteland-style relocation pairs
  `$C300→$FC00`, `$C27A→$DD80`, `$C17B→$5B00`;
- `disasm_prg(relocations=[...])` emits `.pseudopc` / `.logical` for relocated
  code;
- generated `.asm` / `.tass` still rebuilds byte-identical;
- Wasteland-style `$C000-$C0E7` valid control flow is preserved.

## Notes / follow-up

- This is the first concrete disassembly-quality issue found during real-project
  E2E use after Spec 730.
- It is not the same as BUG-019. BUG-019 was about choosing the best existing
  artifact version in the UI. BUG-021 is about the analyzer producing a weak
  Phase-1 disassembly that requires manual semantic rescue.
- This bug should be closed by Spec 741, not by a parallel one-off fix. If Spec
  741 changes, keep this bug as the small Wasteland acceptance case.
- This is also related to Spec 720 / disassembly output quality, but Spec 741 is
  the current owner because the root class is relocated/self-relocating loader
  code.

---

## Resolution

- **Root cause:** two separate failures, both addressed by Spec 741.
  1. *Whole-island demotion.* `demoteBrokenCodeIslands` (Spec 047) demoted an
     entire trusted-entry code island to `unknown` when the byte-scan found
     JAM/branch-into-data triggers — even though those triggers were in an
     unreached data tail, not in the recursively-confirmed control flow.
  2. *Relocated code rendered at the wrong PC.* The disassembler had no way to
     render code that is stored at one address and executed at another, so
     relocated loader regions came out as `.byte` walls or wrong-PC listings.
- **Fix:**
  - **Mixed-island splitter (Slice D).** `demoteBrokenCodeIslands` now takes a
    map of recursively-confirmed instruction coverage. A fully-confirmed island
    is never demoted; a partially-confirmed one is **split** at the
    confirmed/unconfirmed boundary — the trusted-entry control flow is kept as
    `code` (tagged `mixed-island-split`) and only the data tail is isolated as
    `unknown`. (`pipeline/src/analysis/pipeline.ts`.)
  - **Relocation rendering (Slices A–B).** `disasm_prg` accepts `relocations[]`
    and renders each region as KickAssembler `.pseudopc` / 64tass
    `.logical`/`.here` at the runtime PC, with mixed code/data sub-segments,
    self-mod `$FFFF` operand annotation, and analysis-driven gap rendering —
    all byte-exact. One canonical source file per payload.
  - **Relocation detection + proposal (Slice C).** `analyze_prg` detects copy
    loops (`detectRelocationProposals`) and surfaces `{fileStart,fileEnd,
    runtimeAddr}` proposals through `propose_annotations`, ready to feed back
    into `disasm_prg.relocations`.
- **Fix commits:** Spec 741 Slice A `d5c5d13d`, Slice B `fdfd4aa7`, Slice C+D
  `1ebbdc39`, + 741 sanity (surface docs + MCP E2E).
- **Gate proving the fix:** `scripts/smoke-741-relocated-code-pseudopc.mjs`
  (50/50) + `scripts/e2e-741-mcp-relocation-flow.mjs` (13/13, full MCP-stdio
  analyze_prg → propose_annotations → disasm_prg(relocations) → assemble_source
  byte-match). Scenario 7 is the deterministic BUG-021 split proof (whole-island
  demote without coverage → split with coverage; trusted-entry code preserved,
  tail isolated, `mixed-island-split` tag); scenario 8 is the end-to-end
  analyze_prg check that the trusted entry is not buried in one `unknown` wall.
  The repo gate uses a small synthetic fixture; the real Wasteland
  `02_2.0.prg` is the observed blueprint, not a hard-wired oracle.
- **Regression risk:** low. The splitter only changes behaviour when confirmed
  coverage is supplied (legacy 4-arg call unchanged — `sprint40-smoke` green);
  the relocation paths are inert without `relocations[]` (default disasm
  byte-for-byte unchanged — `smoke-disasm-sync` green).
