# Analysis Pipeline Tools

Heuristic + LLM-driven analysis of C64 PRG binaries. Wraps the bundled
TRXDis pipeline.

## Tools

| Tool | Description |
|---|---|
| `analyze_prg` | Heuristic analysis of a PRG → JSON with segments, cross-references, RAM facts, pointer tables. |
| `disasm_prg` | Disassemble a PRG → KickAssembler `.asm` + 64tass `.tass` (both generated automatically). Re-running after annotations re-renders with labels and segment kinds applied. |
| `ram_report` | Generate a RAM-state facts report (markdown) from analysis JSON. |
| `pointer_report` | Generate a pointer-table facts report (markdown) from analysis JSON. |
| `assemble_source` | Assemble a generated `.asm` or `.tass` file with KickAssembler or 64tass, optionally verifying byte-identical rebuilds. |

## Output filenames

- `<name>_analysis.json` — Phase 1 heuristic output
- `<name>_disasm.asm` / `<name>_disasm.tass` — Disassembly (KickAssembler / 64tass)
- `<name>_annotations.json` — Phase 2 LLM annotations
- `<name>_RAM_STATE_FACTS.md` / `<name>_POINTER_TABLE_FACTS.md` — Reports

## Annotations JSON format

`_annotations.json` bridges heuristic analysis and LLM interpretation. The
file only adds comments, labels, and segment kinds — never bytes — so the
verification rebuild stays byte-identical.

```json
{
  "version": 1,
  "binary": "example.prg",
  "segments": [
    {"start": "09A9", "end": "09AA", "kind": "state_variable",
     "label": "sprite_scroller_flag",
     "comment": "When 1, IRQ 3 renders sprite bar as scroller background"}
  ],
  "labels": [
    {"address": "0827", "label": "main_entry",
     "comment": "Phase 1: bitmap slideshow orchestrator"}
  ],
  "routines": [
    {"address": "0827", "name": "Phase 1 — Bitmap Slideshow",
     "comment": "PAL/NTSC detection, VIC setup. Loops through 5 compressed images."}
  ]
}
```

**Segment kinds:** `code`, `basic_stub`, `text`, `petscii_text`,
`screen_code_text`, `sprite`, `charset`, `charset_source`, `screen_ram`,
`screen_source`, `bitmap`, `bitmap_source`, `hires_bitmap`,
`multicolor_bitmap`, `color_source`, `sid_driver`, `music_data`,
`sid_related_code`, `pointer_table`, `lookup_table`, `state_variable`,
`compressed_data`, `dead_code`, `padding`.

## Output formats

Every `disasm_prg` call produces two assembler dialects:

| File | Format | Assembler |
|---|---|---|
| `<name>.asm` | KickAssembler | <http://theweb.dk/KickAssembler/> |
| `<name>.tass` | 64tass | <https://sourceforge.net/projects/tass64/> |

Key syntax differences handled by the converter:

| | KickAssembler | 64tass |
|---|---|---|
| PC | `.pc = $0800 "code"` | `* = $0800` |
| CPU | `.cpu _6502` | `.cpu "6502"` |
| Comments | `//` and `/* */` | `;` |
| Data/labels | `.byte`, `label:` | `.byte`, `label:` (identical) |

Both formats carry the same annotations. Byte-identical rebuilds work with
either KickAssembler on `<name>.asm` or 64tass on `<name>.tass`.
