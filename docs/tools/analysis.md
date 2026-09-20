# Analysis Pipeline Tools

Heuristic + LLM-driven analysis of C64 PRG binaries. Wraps the bundled
TRXDis pipeline.

## Tools

| Tool | Description |
|---|---|
| `analyze_prg` | Heuristic analysis of a PRG → JSON with segments, cross-references, RAM facts, pointer tables. |
| `disasm_prg` | Disassemble a PRG → KickAssembler `.asm` + 64tass `.tas` (both generated automatically). Re-running after annotations re-renders with labels and segment kinds applied. |
| `disasm_raw` | The same renderer, for bytes with no PRG header — a depacked chunk, a relocated overlay, a block out of a track, drive code. Takes a file (or artifact id), an optional byte window and the address the bytes run at; reassembles to prove the listing, and registers it with the byte range it came from. |
| `ram_report` | Generate a RAM-state facts report (markdown) from analysis JSON. |
| `pointer_report` | Generate a pointer-table facts report (markdown) from analysis JSON. |
| `assemble_source` | Assemble a generated `.asm` or `.tas` file with KickAssembler or 64tass, optionally verifying byte-identical rebuilds. |
| `basic_list` | List a tokenized BASIC V2 program from a PRG and extract its SYS / USR / LOAD facts. |
| `basic_tokenize` | Tokenize BASIC V2 source text back into a `.prg` — the inverse of `basic_list`. |

## BASIC V2

A cracked game very often boots through BASIC, and a PRG that loads at `$0801`
is token bytes, not 6502. Run `basic_list` on such a file **before** reaching
for `disasm_prg`.

```
basic_list { prg_path: "loader.prg" }
```

```
BASIC SYS launcher: $0801-$080C, 1 line(s), terminator at $080B;
anything from $080D on is not BASIC.

10 SYS2080

Facts:
  SYS $0820 (2080) — line 10, token at $0805 [certain]
```

Whether the file *is* BASIC is decided by walking the line-record chain — a
2-byte next-line pointer, a 2-byte line number, tokens, a `$00` terminator,
ending at a `$0000` pointer. Only a clean walk yields a listing. A machine-code
PRG that merely happens to load at `$0801` is reported as **not BASIC**, with
the byte offset where the chain broke; it is never half-rendered.

Each fact carries `site` — the absolute address of the keyword's token byte —
next to the resolved `value`, so the jump from a BASIC line into the machine
code it starts can be recorded as an address-to-address link rather than a
sentence. `SYS(2064)`, `SYS 2*4096` and a `SYS` far into the program all
resolve; `SYS PEEK(43)+256*PEEK(44)` is reported as unresolved **with its
expression** and deliberately does not become an entry point.

`basic_tokenize` is the exact inverse: `detokenize → tokenize` is
byte-identical, the same standard as the KickAssembler rebuild. PETSCII control
codes list by name (`{CLR}`, `{RVS ON}`, `{CYAN}`) and tokenize back to their
byte. An unknown token renders as `{$XX}` and round-trips rather than being
guessed at — BASIC extensions (Simons', Turbo, BASIC 7.0) are out of scope.

In `analyze_prg` the walked region becomes one segment of kind `basic`, and
code discovery resumes after its terminator, so the machine code the `SYS`
jumps into is still found. `disasm_prg` renders a `basic` segment as `.byte`
data under a segment header instead of decoding 6502 across it.

## Bytes with no PRG header

Most of what a session actually holds is not a PRG. A depacked chunk, a
relocated overlay, a block lifted out of a raw track, a stretch of drive code:
bytes, and an address they run at. `disasm_raw` renders those through the same
decoder, renderer, annotation handling and rebuild proof as `disasm_prg` —
nothing is prepended to the bytes and nothing on disk is rewritten.

```
disasm_raw { path: "artifacts/overlay.bin", load_address: "$C000" }
disasm_raw { path: "artifacts/track18.bin", offset: "$100", length: "$200",
             load_address: "$0300", cpu: "drive" }
```

Addresses are hex with `$`/`0x` optional, and a JSON number is taken as given.
`offset` and `length` are counted, not addressed, and follow the same rule —
`"100"` is 256 bytes, `100` is 100 — so every answer prints the window both
ways.

Without an entry point the first byte is the only seed and the block is read
linearly from there. An `entry_points` address that falls inside a decoded
instruction breaks it: the bytes up to the seed render as data and the decode
resumes at the seed, which is how a block whose first bytes are data still
yields its code. (The same seeding now applies to `disasm_prg` when no analysis
JSON is passed; before, the list was accepted and ignored.) For real code
discovery, hand in an `analysis_json` from `analyze_prg`.

The listing carries its own provenance — which file, which byte range, which
address, what seeded it, whether it had an analysis — and so does the artifact
row, so a listing found months later can say what bytes it is. Re-running with
the same arguments updates that row rather than making a second one.

## Output filenames

- `<name>_analysis.json` — Phase 1 heuristic output
- `<name>_disasm.asm` / `<name>_disasm.tas` — Disassembly (KickAssembler / 64tass)
- `analysis/raw-disasm/<name>[_<window>]_<address>_disasm.asm` — `disasm_raw` output
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

**Segment kinds:** `code`, `basic` (a tokenized BASIC V2 program — not 6502),
`basic_stub` (machine code entered from a BASIC `SYS`), `text`, `petscii_text`,
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
| `<name>.tas` | 64tass | <https://sourceforge.net/projects/tass64/> |

Key syntax differences handled by the converter:

| | KickAssembler | 64tass |
|---|---|---|
| PC | `.pc = $0800 "code"` | `* = $0800` |
| CPU | `.cpu _6502` | `.cpu "6502"` |
| Comments | `//` and `/* */` | `;` |
| Data/labels | `.byte`, `label:` | `.byte`, `label:` (identical) |

Both formats carry the same annotations. Byte-identical rebuilds work with
either KickAssembler on `<name>.asm` or 64tass on `<name>.tas`.
