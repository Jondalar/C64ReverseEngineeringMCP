# Annotations file reference (`<stem>_annotations.json`)

The semantic annotation layer for a PRG. `disasm_prg` auto-applies a
`<stem>_annotations.json` sitting next to the PRG / output ASM / analysis JSON.
Annotations are **non-destructive** — labels, comments, segment reclassifications and
data-table hints only; the rebuilt bytes stay byte-identical.

`propose_annotations` writes a DRAFT (`<stem>_annotations.draft.json`) you hand-edit and
rename. It never overwrites a manual file.

## Field shape

```jsonc
{
  "version": 1,
  "binary": "loader.prg",          // which PRG this annotates (informational)

  // Segment reclassifications — retype a byte range.
  "segments": [
    { "start": "0900", "end": "09FF", "kind": "code", "label": "decrunch", "comment": "..." }
    // start,end: hex (with or WITHOUT a leading $). kind: a SegmentKind
    // (code | text | sprite | charset | bitmap | pointer_table | data | unknown | ...).
    // label, comment: optional.
  ],

  // Named addresses.
  "labels": [
    { "address": "0810", "label": "main_entry", "comment": "cold start" }
    // address: hex. label: a name. comment: optional.
  ],

  // Documented routines (also promoted to a label, name→identifier).
  "routines": [
    { "address": "0C00", "name": "Turn advance", "comment": "advances the turn counter" }
    // address: hex. name: descriptive prose (sanitised to a valid label). comment: block comment.
  ],

  // OPTIONAL sections (omit entirely if unused):
  "pointerTables": [ { "start": "1000", "end": "101F", "stride": 2, "endian": "little", "comment": "..." } ],
  "jumpTables":   [ { "start": "1100", "end": "111F", "kind": "jmp", "comment": "..." } ],  // kind: jmp | jsr | word
  "immediates":   [ { "address": "0820", "kind": "lo-of", "label": "sprite_ptr", "comment": "..." } ] // kind: lo-of | hi-of
}
```

## Exact field names (the ones that bite)

| Section     | Required fields                          | NOT `addr`, NOT `name`(for a label) |
|-------------|------------------------------------------|-------------------------------------|
| `labels`    | `address`, `label`                       | use `address` (not `addr`), `label` (not `name`) |
| `routines`  | `address`, `name`, `comment`             | use `address` (not `addr`); a routine's descriptive field IS `name` |
| `segments`  | `start`, `end`, `kind`                   | use `start`/`end` (not `from`/`to`) |

Hex may be written `0810` or `$0810` — the loader strips a leading `$`.

## Tolerant loading

Loading never crashes. A missing section is treated as empty. An individual entry with an
unparseable / missing required field (a mistyped key is the usual cause) is **skipped**,
and the rest still apply. `disasm_prg` reports it:

```
[annotations] applied 42, skipped 3:
  - label: unparseable address=undefined (label=main) — field "addr" should be "address"
  - label: address 0810 has no label — field "name" should be "label"
  - segment: unparseable range start=undefined end=09FF — field "from" should be "start"
```

If you expected more annotations to apply, check that `skipped` line — a wrong field key
is dropped, not applied.

## An entry point inside another instruction (Spec 830)

The 6502 multi-entry idiom uses `BIT` as a skip, so several entries set a
different register and fall into one body:

```
$4ACA  a9 00     lda #$00        <- entry
$4ACC  2c        BIT abs, swallowing the next two bytes
$4ACD  a9 04     lda #$04        <- ALSO an entry, inside that operand
$4ACF  2c
$4AD0  a9 01     lda #$01        <- and another
$4AD8  48        pha             <- the common body
```

Annotate those addresses as ordinary `routines` (or `labels`). **The file needs
no way to express a skip byte** — the renderer reads the bytes. When a declared
entry falls strictly inside a decoded instruction, that instruction is emitted
as `.byte` up to the entry, which is the same byte and therefore still rebuilds
byte-identical, and the entry gets its label at its own address:

```
overlay_call_fn0:  lda #$00
                   .byte $2C
overlay_call_fn4:  lda #$04
```

Only a DECLARED entry does this — an annotated routine, an annotated label, or
an explicit entry point. A `sta` that writes into an operand is a
self-modifying patch, not an entry, and keeps rendering as `<owner>+<offset>`.

An address you name that lives in **another payload** is emitted as an equate
(`.label window_clear = $C0A9`) rather than a label, because it is not in this
file. Nothing else is needed for a cross-payload name to assemble.
