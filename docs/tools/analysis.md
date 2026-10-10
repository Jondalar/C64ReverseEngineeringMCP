# Analysis Pipeline Tools

Heuristic + LLM-driven analysis of C64 PRG binaries. Wraps the bundled
TRXDis pipeline.

## Tools

| Tool | Description |
|---|---|
| `analyze` | Heuristic analysis of bytes → JSON with segments, cross-references, RAM facts, pointer tables. Headed or headerless: the load address decides (below). |
| `disasm` | Disassemble bytes → KickAssembler `.asm` + 64tass `.tas` (both generated automatically), with a rebuild proof. Re-running after annotations re-renders with labels and segment kinds applied, and imports those names into the knowledge graph under the file's stem. `import_graph: false` renders a **preview** instead: the listing and its rebuild proof, and the graph left exactly as it was — for scratch and draft renders. A stem imported by mistake is dropped with `graph_remove_owner`. `platform` picks the symbol tables (`c64` default, `c1541` for drive code); `platform: "none"` is for code of any other machine — the listing then carries no ROM / zero-page / I/O names or comments and no hardware inference, only the names and comments of the project's annotations and graph, and nothing is recorded as the file's machine. The choice sticks to the file: later renders that name no platform keep it, an explicit `c64` / `c1541` clears it. |
| `disasm_prg` · `disasm_raw` · `analyze_prg` | The old names. Aliases of the two above for one release — the same body, and each says so once in its answer, naming its successor. |
| `ram_report` | Generate a RAM-state facts report (markdown) from analysis JSON. |
| `pointer_report` | Generate a pointer-table facts report (markdown) from analysis JSON. |
| `assemble_source` | Assemble a generated `.asm` or `.tas` file with KickAssembler or 64tass, optionally verifying byte-identical rebuilds. |
| `basic_list` | List a tokenized BASIC V2 program from a PRG and extract its SYS / USR / LOAD facts. |
| `basic_tokenize` | Tokenize BASIC V2 source text back into a `.prg` — the inverse of `basic_list`. Starts at the machine's BASIC start (`$0801`; `$1001` for `vic20` / `plus4`) unless `load_address` is given. |

## BASIC V2

A cracked game very often boots through BASIC, and a PRG that loads at `$0801`
is token bytes, not 6502. Run `basic_list` on such a file **before** reaching
for `disasm`.

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

The analysis (`analyze`, `disasm`) takes the same walk to the machine's own BASIC
start: `$0801` on the C64, `$1001` / `$0401` / `$1201` on the VIC-20 (bare, +3K,
+8K and up) and `$1001` on the C16 / C116 / Plus/4. A `10 SYS` stub there gets the
BASIC segment and the SYS entry exactly as a C64 `$0801` PRG does; the same bytes
analysed as another machine are not a stub. `basic_list` walks any load address
but knows only the V2 token table: a TED BASIC 3.5 token (`$CC` and up) is shown
as `{$CC}`, never given a name.

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

In `analyze` the walked region becomes one segment of kind `basic`, and
code discovery resumes after its terminator, so the machine code the `SYS`
jumps into is still found. `disasm` renders a `basic` segment as `.byte`
data under a segment header instead of decoding 6502 across it.

## The load address decides, never the file name

Most of what a session actually holds is not a PRG. A depacked chunk, a
relocated overlay, a block lifted out of a raw track, a stretch of drive code:
bytes, and an address they run at. There is one door for both, and one rule
decides which reading it takes:

- **`load_address` given** → the bytes are raw and start there. Nothing at the
  front is treated as a header, nothing is prepended, nothing on disk is
  rewritten.
- **`load_address` omitted** → the file must carry a 2-byte load header, and
  its first two bytes are read as the address.
- **a header and a `load_address` that disagree** → refused, naming both. A
  guess is never silently preferred to what the caller said.

The extension is a hint in a message and never the decider: in a real corpus a
payload carved out of a disk has no extension at all, a `.bin` is often a PRG
and a `.prg` is often a raw block. So every answer opens with the reading it
took and where the address came from:

```
Reading: no load_address given and s.bin read as headed — the first two bytes
are $0A5F, so the body runs $0A5F-$1FFF; if that is wrong, pass load_address.
```

```
disasm { path: "artifacts/loader.prg" }
disasm { path: "artifacts/overlay.bin", load_address: "$C000" }
disasm { path: "artifacts/track18.bin", offset: "$100", length: "$200",
         load_address: "$0300", platform: "c1541" }
disasm { path: "artifacts/vic20-original.prg", platform: "vic20" }
disasm { path: "artifacts/foreign-original.bin", load_address: "$A000", platform: "none" }
analyze { path: "artifacts/drivecode.bin", load_address: "$0300" }
```

### Which machine

The names in a listing (zero page, I/O registers, KERNAL entries) and the I/O
window the analysis treats as hardware depend on the machine the bytes run on.
Four are known: `c64`, `c1541` (drive code), `vic20` and `plus4` (the TED machines:
C16, C116, Plus/4). `disasm`, `analyze`, `inspect_address_range` and `c64ref_lookup`
all resolve it the same way, first hit wins:

1. the `platform` argument;
2. the `platform` marker on the file's artifact record;
3. the project's default (`project_init` with `platform`, stored in `knowledge/project.json`);
4. `c64`.

An explicitly named machine is recorded on the file, so every later call that names
none finds it. The platform store names only what it has rows for: on a VIC-20 or a
TED address with no row, the listing stays unnamed and `c64ref_lookup` says there is
no row — a C64 name is never borrowed. `platform: "none"` is a rendering switch, not a
machine: no platform names at all, for code of any other machine.

Graph nodes follow the machine: a store to `$9005` in VIC-20 code is a `USES_HARDWARE`
edge to `vic20:io:9005`, a store to `$FF19` in TED code one to `plus4:io:ff19`.
Where a tool must pick a load address for a block with no header, the machine
decides — `basic_tokenize` starts at `$0801` on the C64 and `$1001` on the VIC-20 and
the TED machines (the VIC-20 with 3K or 8K expansion starts at `$0401` / `$1201`: pass
`load_address`). A PRG header always wins.

Addresses are hex with `$`/`0x` optional, and a JSON number is taken as given.
`offset` and `length` are counted, not addressed, and follow the same rule —
`"100"` is 256 bytes, `100` is 100 — so every answer prints the window both
ways.

Without an entry point the first byte is the only seed and the block is read
linearly from there. An `entry_points` address that falls inside a decoded
instruction breaks it: the bytes up to the seed render as data and the decode
resumes at the seed, which is how a block whose first bytes are data still
yields its code. For real code discovery, hand in an `analysis_json` from
`analyze` — which runs on headerless bytes too, so 1541 drive code gets
segments without a fake load header being carved in front of it.

The listing carries its own provenance — which file, which byte range, which
address, what seeded it, whether it had an analysis — and so does the artifact
row, so a listing found months later can say what bytes it is. Re-running with
the same arguments updates that row rather than making a second one.

## Which analysis a render uses

Three rules, and the answer always names the file it used and why:

1. `analysis_json` names a path and it **exists** → that is the analysis
   rendered, unchanged, never swapped for anything else.
2. It does not exist, or none is named → the **project store** is asked which
   analysis is registered for *these bytes*. That is a link, not a path guess,
   so an analysis written into a hashed payload directory by `extract_disk` is
   found from the bytes it is about.
3. Only with nothing in the store does the render fall back to the file sitting
   beside the bytes.

`no_analysis` refuses all three outright. On a raw reading an analysis that
describes a different span is refused with both spans named: an analysis of a
63 KB image rendered over a 640-byte window of it produces the image's segments
at the window's addresses and a rebuild that cannot match.

## Output filenames

- `<name>_analysis.json` — Phase 1 heuristic output
- `<name>_disasm.asm` / `<name>_disasm.tas` — Disassembly (KickAssembler / 64tass)
- `analysis/raw-disasm/<name>[_<window>]_<address>_disasm.asm` — a raw reading's listing
- `analysis/raw-analysis/<name>[_<window>]_<address>_analysis.json` — a raw reading's analysis
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

A label on a zero-page address (`"address": "FB", "label": "ptrLo"`) names the
operand in every zero-page form — `lda ptrLo`, `lda ptrLo,x`, `lda (ptrLo),y`,
`lda (ptrLo,x)` — and in an absolute-encoded access to that address
(`lda.abs ptrLo`, kept absolute so the rebuild stays byte-identical). The
listing defines it once, before first use (`.label ptrLo = $FB` in the `.asm`,
`ptrLo = $FB` in the `.tas`). The platform's own name for the address stays in
the line comment as a hint behind yours.

**Segment kinds:** `code`, `basic` (a tokenized BASIC V2 program — not 6502),
`basic_stub` (machine code entered from a BASIC `SYS`), `text`, `petscii_text`,
`screen_code_text`, `sprite`, `charset`, `charset_source`, `screen_ram`,
`screen_source`, `bitmap`, `bitmap_source`, `hires_bitmap`,
`multicolor_bitmap`, `color_source`, `sid_driver`, `music_data`,
`sid_related_code`, `pointer_table`, `lookup_table`, `state_variable`,
`compressed_data`, `dead_code`, `padding`.

## Output formats

Every `disasm` call produces two assembler dialects:

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
