# Reverse-Engineering Workflow

Three phases. Tool descriptions guide the LLM through them automatically;
the canonical text lives in
[c64-reverse-engineering-skill.md](c64-reverse-engineering-skill.md).

## Phase 1 — Heuristic analysis (deterministic, fast)

```
analyze_prg     → _analysis.json
disasm_prg      → _disasm.asm + _disasm.tass
ram_report      → _RAM_STATE_FACTS.md
pointer_report  → _POINTER_TABLE_FACTS.md
```

Takes 1–6 seconds depending on PRG size. Produces:

- segment classifications (`code`, `sprite`, `bitmap`, `text`,
  `pointer_table`, `unknown`, …)
- cross-references (`entry`, `call`, `jump`, `branch`, `pointer`, …)
- RAM-state evidence + pointer-table layouts
- hardware-register touches (VIC / SID / CIA)

Anything the heuristic cannot classify is left as `unknown` for Phase 2.

## Phase 2 — Semantic analysis (LLM)

The LLM reads the disassembly together with the analysis JSON and
produces a `_annotations.json` that:

- **Reclassifies** every `unknown` segment (`state_variable`,
  `compressed_data`, `color_source`, …)
- **Fixes misclassifications** (e.g. screen data wrongly detected as
  sprite due to 64-byte alignment)
- **Adds semantic labels** (`main_entry` instead of `W0827`,
  `irq_raster_split` instead of `W3E07`)
- **Documents routines** with names + descriptions

The annotations file only adds metadata — never bytes. See
[Analysis tools](tools/analysis.md) for the JSON schema and segment-kind
list.

A medium-size C64 binary (~16–32 KB) typically fits in a single LLM
context together with its annotations. Larger images are usually split
into PRG/CRT-bank windows; the
[knowledge layer](semantic-ui-layer.md) tracks which windows have been
processed and merges the per-window annotations.

## Phase 3 — Final render + verification

```
disasm_prg (again) → _final.asm + _final.tass  (annotations applied)
assemble_source     → _rebuilt.prg
cmp                 → BYTE-IDENTICAL ✓
```

Annotations affect only comments, labels, and segment headers. Both
KickAssembler (`.asm`) and 64tass (`.tass`) outputs rebuild
byte-identically against the original PRG.

## MCP prompts

The repo ships canned prompt scaffolds for each phase:

| Prompt | Description |
|---|---|
| `c64re_get_skill` | Return the canonical workflow / skill text. |
| `full_re_workflow` | Complete 3-phase workflow with strict sequential steps and file naming. |
| `classify_unknown` | Targeted classification of a single unknown segment. |
| `generate_annotations` | Produce `_annotations.json` from a disassembly. |
| `trace_execution` | CPU trace from entry point following actual control flow. |
| `annotate_asm` | Write semantic comments directly into an ASM file. |
| `disk_re_workflow` | Triage and analyse D64 / G64 disk images. |
| `debug_workflow` | Combine VICE runtime trace and breakpoint-driven monitor tools. |

## Design philosophy

### Facts before labels

The pipeline deliberately separates:

1. **Deterministic facts** (TRXDis pipeline) — code segments, xrefs, RAM
   accesses, pointer tables. Reproducible, no interpretation.
2. **Semantic interpretation** (LLM) — "this is a colour table because
   the code copies it to `$D800`". Requires understanding, not just
   pattern matching.
3. **Verification** (assembler) — KickAssembler / 64tass rebuild plus
   `cmp -l` ensures annotations never alter the bytes.

### Why an LLM beats a traditional disassembler

- **Cross-domain knowledge**: VIC registers, SID conventions, common
  packer routines, KERNAL calls — all available simultaneously.
- **Data-flow reasoning**: "this value is written to `$DD00` → VIC bank
  switch → the bitmap must be in bank 3".
- **Iteratively refinable**: hypotheses can be confirmed or corrected
  through further analysis; the [knowledge layer](semantic-ui-layer.md)
  persists those hypotheses across sessions.
- **Per-window context windows**: the knowledge layer + workspace UI
  scope the LLM to the right slice (a single CRT bank, a single disk
  file, a single phase) instead of forcing whole-image context.

## Benchmark

Tested on 4 C64 PRG modules (183.5 KB total) with Claude Opus 4.6:

| Metric | Value |
|---|---|
| Heuristic pipeline (Phase 1) | 8.7 s |
| LLM semantic analysis (Phase 2) | ~27 min sequential, ~9 min parallel |
| LLM tokens consumed | 831 K |
| Segments reclassified | 168 |
| Semantic labels generated | 394 |
| Routine descriptions | 213 |
| Byte-identical rebuilds | 8/8 (pre + post annotation) |

≈ 4 500 tokens per KB of PRG for the semantic-analysis pass.
