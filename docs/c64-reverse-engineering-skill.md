# C64 Reverse Engineering Workflow Skill

This document is the canonical reverse-engineering workflow for this MCP. It mirrors the strict 3-phase playbook used by local skills and prompt-driven clients.

Use this when reverse-engineering any `.prg`, `.crt`, `.d64`, or `.g64` with the `c64re` MCP tools.

## Core Rule

Run the workflow in three mandatory phases, in order:

1. Phase 1: heuristic analysis
2. Phase 2: semantic annotation
3. Phase 3: final render and byte-identical verification

Do not skip phases. Do not parallelize across phases.

## Available MCP Tools

```text
analyze_prg
disasm_prg
ram_report
pointer_report
read_artifact
list_artifacts
build_tools
assemble_source
extract_crt
inspect_disk
extract_disk
```

## Phase 1: Heuristic Analysis

For a PRG file at `<path>.prg`:

### Step 1.1: Analyze the PRG

```text
analyze_prg(prg_path="<path>.prg", output_json="<path>_analysis.json", entry_points=["0827"])
```

Typical entry is `0827` (`SYS 2087`). Wait for completion.

### Step 1.2: Disassemble

```text
disasm_prg(prg_path="<path>.prg", output_asm="<path>_disasm.asm", entry_points=["0827"], analysis_json="<path>_analysis.json")
```

This produces:

- `<path>_disasm.asm`
- `<path>_disasm.tass`

### Step 1.3: Generate reports

```text
ram_report(analysis_json="<path>_analysis.json", output_md="<path>_ram_facts.md")
pointer_report(analysis_json="<path>_analysis.json", output_md="<path>_pointer_facts.md")
```

### Phase 1 checkpoint

You should now have:

- `<path>_analysis.json`
- `<path>_disasm.asm`
- `<path>_disasm.tass`
- `<path>_ram_facts.md`
- `<path>_pointer_facts.md`

## Phase 2: Semantic Analysis

This phase is mandatory. Without it, the disassembly keeps generic labels and often leaves `unknown` segments.

### Mandatory phase transition

When Phase 1 is complete, explicitly say:

> Phase 1 is complete. I am now doing Phase 2 semantic annotation.
> I will read the ASM plus RAM and pointer facts, reclassify all remaining unknown segments, assign semantic labels, document routines, and write `<path>_annotations.json`.

### Step 2.1: Read the required artifacts

Read all three:

```text
read_artifact(path="<path>_disasm.asm")
read_artifact(path="<path>_ram_facts.md")
read_artifact(path="<path>_pointer_facts.md")
```

Read the complete ASM. C64 disassemblies fit in context.

### Step 2.2: Produce annotations JSON

Write `<path>_annotations.json` with this shape:

```json
{
  "version": 1,
  "binary": "<filename>.prg",
  "segments": [
    {
      "start": "09A9",
      "end": "09AA",
      "kind": "state_variable",
      "label": "sprite_scroller_flag",
      "comment": "When 1, IRQ 3 renders sprite bar at screen bottom"
    }
  ],
  "labels": [
    {
      "address": "0827",
      "label": "main_entry",
      "comment": "Main entry point"
    }
  ],
  "routines": [
    {
      "address": "0827",
      "name": "Main Entry - Init and Game Loop",
      "comment": "Initializes VIC, sets up IRQ chain, enters main loop"
    }
  ]
}
```

### Segment rules

Every `unknown` segment must be reviewed and reclassified.

Use evidence from:

1. code references into the segment
2. byte patterns
3. copy destinations
4. VIC/SID/Color RAM usage context
5. RAM and pointer reports

If a region is still uncertain, reclassify conservatively, for example:

- `lookup_table`
- `state_variable`
- `padding`
- `compressed_data`

Do not leave it as `unknown`.

Available kinds:

```text
code, basic_stub, text, petscii_text, screen_code_text, sprite, charset, charset_source,
screen_ram, screen_source, bitmap, bitmap_source, hires_bitmap, multicolor_bitmap,
color_source, sid_driver, music_data, sid_related_code, pointer_table, lookup_table,
state_variable, compressed_data, dead_code, padding
```

### Phase 2 working order

1. Understand the routine map from the ASM
2. Use RAM facts for flags, counters, pointers, and state blocks
3. Use pointer facts for split tables, dispatch tables, and text/screen tables
4. Revisit every `unknown` segment and classify it
5. Assign semantic labels
6. Document routines

### Phase 2 checkpoint

You should now have:

- `<path>_annotations.json`

## Phase 3: Final Render and Verification

### Step 3.1: Re-render with annotations

```text
disasm_prg(prg_path="<path>.prg", output_asm="<path>_final.asm", entry_points=["0827"], analysis_json="<path>_analysis.json")
```

This should produce:

- `<path>_final.asm`
- `<path>_final.tass`

### Step 3.2: Verify byte-identical rebuild

```text
assemble_source(source_path="<path>_final.asm", assembler="kickassembler", output_path="<path>_rebuilt.prg", compare_to="<path>.prg")
```

Annotations must never alter bytes.

### Phase 3 checkpoint

Final deliverables:

- `<path>_final.asm`
- `<path>_final.tass`
- `<path>_rebuilt.prg`

## Important Rules

1. Execute sequentially: Phase 1 -> Phase 2 -> Phase 3
2. Complete one PRG before starting the next
3. After Phase 2, no segment should remain unreviewed as `unknown`
4. Write annotations in `_annotations.json`, not by editing bytes in ASM
5. Rebuild must be byte-identical
6. Use derived filenames consistently
7. Narrate the transition into Phase 2 and Phase 3 explicitly

## Runtime Trace Integration

Runtime trace evidence is an enhancement for Phase 2, not a replacement for the 3-phase workflow.

If runtime data exists, use it to:

- confirm which code paths actually executed
- separate mixed code/data regions more precisely
- identify gameplay, loader, IRQ, collision, and state-transition paths
- improve semantic labels and routine comments

Even with runtime evidence, Phase 2 still requires reading:

- the full ASM
- RAM facts
- pointer facts

## CRT Files

First extract the CRT:

```text
extract_crt(crt_path="<file>.crt", output_dir="analysis/extracted")
```

Then run the 3-phase workflow on each extracted PRG.

## D64/G64 Files

Start with:

```text
inspect_disk(image_path="<file>.d64")
extract_disk(image_path="<file>.d64")
```

Then run the 3-phase workflow on the extracted PRG files.
