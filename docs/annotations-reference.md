# Annotations file reference (`<stem>_annotations.json`)

The semantic annotation layer for a listing. `disasm` auto-applies a
`<stem>_annotations.json` sitting next to the PRG / output ASM / analysis JSON.
Annotations are **non-destructive** — labels, comments, segment reclassifications and
data-table hints only; the rebuilt bytes stay byte-identical.

`propose_annotations` writes a DRAFT (`<stem>_annotations.draft.json`) you hand-edit and
rename. It never overwrites a manual file.

`write_annotations` writes the real file from structured input — segments, labels and
routines as arguments, not as JSON you assemble yourself. Every address may be written
`43A8`, `$43a8` or `0x43A8` and comes back as bare uppercase hex, so nothing downstream
has to normalise. It refuses **before the file exists**, naming every offending entry by
its own index: a mistyped or missing required field, two segments on one start, one
address carrying two names, one name at two addresses, a name past the project's length
limit, or an output path that does not end in `_annotations.json`. One offender means
nothing is written at all — the tolerant skip described below is for a file a human wrote
by hand, not for one a tool is writing.

`merge_annotations` folds several readings of one payload into one file. Fragments that
say the same thing collapse into one and you are asked nothing. The identity rule is:
**one address carries one name, and one name lives at one address**, across every record
that names an address — a segment's `label`, `labels[]` and `routines[]`. The same name at
the same address from any mix of those (same or different fragments) is one claim and
collapses silently; names are compared as the assembler identifier they become, so a
routine called "Turn advance" and a label `Turn_advance` agree. A label that only repeats
what a routine or the segment already names there is dropped from the merged file unless it
carries prose of its own. Fragments that contradict each other — one segment start with
two ends or kinds, one address with two names, one name at two addresses, one instruction
with two `immediates` rows — are **refused, naming the key, every claimant and what each
of them claimed**:

```
REFUSED — the fragments contradict each other. Nothing was written and nothing was recorded.

segment:82E6
  D  $82E6-$82F5  data  "score_tbl"
  E  $82E6-$8305  pointer_table  "score_ptrs"
```

Keys: `segment:<addr>`, `label:<addr>` / `routine:<addr>` (the name an address carries —
`label:` when a label or a segment label is involved, `routine:` when only routines
disagree; either spelling answers it), `immediate:<addr>` (an immediate is keyed by its
instruction address; a different label, or `lo-of` against `hi-of`, is a contradiction),
`split:<lo>-<hi>` and `name:<identifier>` (one name at two addresses).

You answer with `resolutions: [{ key, winner | value | delete, why }]` — `winner` is a
fragment name (`A:routine`, `A:label` or `A:segment` when fragment A names the address
twice), `value` is an entry neither side proposed (stating only what it changes; for an
address name it is `{ label: "…" }`, the one name the address then carries), `delete: true`
removes the entry (the address's name in every record, the segment, the split table, the
immediate; for a `name:` key every site of the name), and `why` is required. Exactly one
of the three. **Each resolution is written into the project as a finding** carrying who
claimed what, which one won and why, so who was right at `$82E6` is still answerable
after the session that decided it is gone. A resolution for a key nothing disputes, a
winner that claimed nothing there, and a resolution with no reason are all refused.

What a resolution leaves behind is consistent, not just chosen: a record that lost its
name is dropped and **its comment is kept** on the record that survived at that address
(a comment with nowhere to go is quoted in the answer, not lost); an `immediates` row that
pointed at a label which lost its address is rewritten to the winning name at that
address (and says so), and one that pointed at a deleted name is dropped (and says so).
A contradiction that exists only because of another is listed after that one is answered —
a refusal never lists a key that another answer would make vanish, so a second refusal can
follow the first. `dry_run` reports the merge without writing the file or recording anything.

**Names are at most 20 characters** in a project created since 2026-09-19: `project_init`
stamps `naming.maxLabelLength: 20` into `knowledge/project.json`, and `disasm` refuses
an annotations file with a longer label, routine or segment name before it renders anything.
A project without the stamp is not checked. Twenty is also the width of the
monitor's label column, so in such a project no name ever wraps there.

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
    { "address": "0C00", "name": "Turn advance", "comment": "advances the turn counter" },
    { "address": "0C40", "name": "Turn reset" }
    // address: hex. name: descriptive prose (sanitised to a valid label), REQUIRED.
    // comment: optional block comment — a routine with only a name is a valid entry.
  ],

  // OPTIONAL sections (omit entirely if unused):
  "pointerTables": [ { "start": "1000", "end": "101F", "stride": 2, "endian": "little", "comment": "..." } ],
  "jumpTables":   [ { "start": "1100", "end": "111F", "kind": "jmp", "comment": "..." } ],  // kind: jmp | jsr | word
  "splitTables":  [ { "lo": "1021", "hi": "102A", "count": 9, "adjust": 0, "base": "handlers", "comment": "..." },
                    { "lo": "2000", "hi": "2010", "reject": "string table indexed by a counter, not addresses" } ],
  "immediates":   [ { "address": "0820", "kind": "lo-of", "label": "sprite_ptr", "comment": "..." } ], // kind: lo-of | hi-of
  "memoryMap":    [ { "start": "D000", "end": "DFFF", "as": "ram", "routines": ["C000"] } ]         // what $D000-$DFFF is at run time; see below
}
```

## Label halves in immediates

Without an `immediates` row the renderer writes `lda #<label` / `lda #>label` on its own in two
cases only. (1) A `jsr` into a routine whose ABI declares a register pointer pair (KERNAL, or a
`routines[].abi.pointerPairs` row). (2) Two immediates stored to adjacent zero-page cells whose
combined value is a label **and** that pointer is dereferenced - `(zp),y`, `(zp,x)` or
`jmp ($00xx)` - on a path that starts at those stores and reaches the use before either cell is
overwritten. The path may run through the same routine, through `jsr` callees (two levels; a
deeper call is stepped over only when everything it can reach leaves both cells alone), or, when
the routine only sets the pointer and returns, behind its callers. A routine that borrows the
cells and puts the values back (`lda cell` / `pha` ... `pla` / `sta cell`, or parked in the
operand of a later `lda #imm`) does not end the path. A cell that is a pointer in some other
routine proves nothing about this setup, and the same two bytes passed as plain coordinates stay
literal.

A call that leaves the image is followed into the project's other files: those whose analysis
records code at the target (code segments, and `jumpTables` rows of kind `jmp`). The target's bytes are
decoded on demand from that file and the same rules apply; nothing from it is rendered. When
several files hold code at the address they must agree - if one dereferences and another does
not, nothing tells them apart, the bytes stay literal and the listing's
`// SEMANTICS zp-pair` comment says `callee $XXXX ambiguous: N residents`. A path the scan cannot
follow - an indirect jump, a call to an address no file has code at, bytes the analysis did not
decode - proves nothing either: the bytes stay literal. An `immediates` row states a use the
scan cannot reach and always wins. The label the halves render to must exist in the listing
being rendered; the other file only decides pointer or not.

## Split low/high tables

Two parallel one-byte tables — one holding the low bytes, one the high bytes of `count`
addresses (`LDA lo,X / STA $1D / LDA hi,X / STA $1E / JMP ($1D)`) — are what `splitTables`
declares. Without it the listing prints `.byte $34,$7A,…` twice; with it every entry
reads `.byte <handler_a, <handler_b, …` and `.byte >handler_a, >handler_b, …`, so
moving a routine moves its table entries and a reader sees that byte *n* here and byte
*n* there are one address.

| Field | |
|---|---|
| `lo`, `hi` | hex addresses of the low-byte and the high-byte table |
| `count` | entries; both tables are `count` bytes (required unless `reject`) |
| `adjust` | `stored = target - adjust`, default 0. An RTS dispatch stores *target−1*, so `adjust: 1` |
| `base` | a name from `labels` / `routines` / a segment label; every entry renders as `<(base+off)` / `>(base+off)` |
| `comment` | free text |
| `reject` | "this is not a pointer table, because …" — decides a found table the other way |

Each entry is written, first that applies: against `base`, as `<label` / `>label` when
the target has a name, as `<(segment_label+off)` when it lies inside a named segment, and
otherwise as the bare address `<$xxxx`. A non-zero `adjust` is written into the expression
(`<(handler-1)`), never folded into a number, so the 64tass listing carries it the same
way. Both ranges are rendered as table data even when a `segments` entry already names
them `lookup_table` — that is the normal case, and the segment's label stays the table's
label.

A split-table entry is **refused, not skipped**, naming the entry: a `lo` or `hi` that is
not a hex address, `count` below 1, a table outside the image, the low and the high table
overlapping each other, a table overlapping a `code` segment, a `pointerTables` /
`jumpTables` range or another `splitTables` entry, a `base` that names nothing in the
file, an empty `reject`, and an `adjust` that contradicts the code (an RTS dispatch the
analysis saw stores *target−1*). A declaration is held to the rebuild like every other
annotation: the assembler must reproduce the bytes.

### A found table must be decided

`analyze` finds split tables built three ways — `LDA lo,X / STA zp / LDA hi,X / STA zp+1`
(counted only when the pair is then used as a pointer, see below),
the same stores into the operand of an instruction in the image, and the RTS dispatch
`LDA hi,X / PHA / LDA lo,X / PHA / RTS` — and reports each once per `(lo, hi)` pair with
its `shape`, a `countHint` when a `CPX`/`CPY #n` bounds the index nearby and an
`adjustHint` of 1 for an RTS dispatch. A table found in **confirmed code** is an open
obligation until the artifact's annotations hold a `splitTables` entry with that `lo` and
`hi` — a declaration or a rejection with a reason. Nothing else closes it.

- `analyze` and `disasm` never refuse; their answer ends with the open list, the shape,
  the first targets, the hint, and the two ways to close each.
- `agent_advance_phase` refuses to take the artifact past phase 5 while one is open. This
  holds whatever `phaseGateStrict` says.
- `project_critique` raises `split-table-undecided` (blocking) once per open table, so the
  project is not done and `agent_next_step` recommends declaring them first.
- Tables found in probable code are listed and never an obligation.
- A zero-page pair counts as a table only when the code later uses it as a pointer —
  `(zp),y`, `(zp,x)` or `jmp (zp)` on either cell — on a path that starts after the second
  store: fall-through, both branch arms, `jmp`, and into the callee of a `jsr`. A path stops
  where the code overwrites a cell. A pair that is only read as bytes (a column and a row,
  a width and a height) is listed as *probable* with the reason and is never an obligation;
  declare or reject it anyway if you read it differently. The patched-operand and RTS
  shapes need no such check: they are used as an address by construction.

The detector sees only those three shapes. A table whose index is computed in two steps,
or whose pointer is copied before use, is not listed — **"0 open" is not "no tables"**.
Reading the code finds the rest, and `splitTables` declares them; the list says so every
time it is printed.

A declaration is also knowledge: the graph holds one table node per entry and an edge from
it to each in-image target (`graph_edges` on a handler shows the table that points at it),
and a rejection is recorded on the table's node with its reason, so a later reader sees
it was decided and not missed.

## I/O registers in the listing, and `memoryMap`

An absolute operand in `$D000-$DFFF` is named in the listing, in KickAssembler and in 64tass,
whether or not the image itself covers those addresses (a game that runs with `$01 = $35` and keeps
sprite data under the I/O window does). The names are one scheme, lower-case and chip-prefixed, at
most 20 characters:

| Window | Names |
|---|---|
| VIC-II `$D000-$D02E` | `vic_spr0_x` … `vic_spr7_y`, `vic_spr_x_msb`, `vic_ctrl1`, `vic_raster`, `vic_ctrl2`, `vic_mem`, `vic_irq`, `vic_irq_mask`, `vic_border`, `vic_bg0` … `vic_bg3`, `vic_spr0_col` … `vic_spr7_col`, … |
| SID `$D400-$D41C` | `sid_v1_freq_lo` … `sid_v3_sr`, `sid_filter_lo`, `sid_filter_hi`, `sid_filter_res`, `sid_volume`, `sid_pot_x`, `sid_pot_y`, `sid_osc3`, `sid_env3` |
| Colour RAM `$D800-$DBFF` | `color_ram`, a cell as `color_ram+$28` |
| CIA 1 / CIA 2 | `cia1_pra` … `cia1_icr`, `cia1_cra`, `cia1_crb`; `cia2_pra` … `cia2_crb` |
| Cartridge `$DE00-$DFFF` | by the cartridge type: `ef_bank`, `ef_ctrl` (EasyFlash), `gmod2_ctrl`, `magicdesk_bank`, `ocean_bank`, `megabyter_bank`, `megabyter_mode`; any other type or none: `cart_io_de00` … |

A chip that repeats itself answers at its mirrors: `$D051` is `vic_ctrl1+$40`, `$D420` is
`sid_v1_freq_lo+$20`. An address the chip has no register at (`$D02F`) stays an address. The names
are defined once, in an equate block at the head of the listing that holds exactly the ones used;
`graph_find $D011` returns the same name with the book's heading, and the book's own label
(`SCROY`) still finds it by search.

**Who decides what an address is called**, strongest first:

1. a **human label** at the address (`labels[]`, a routine, a segment label, or a name in the graph) —
   `scroll_ctl` at `$D011` makes every operand to `$D011` read `scroll_ctl` (and `$D051` read
   `scroll_ctl+$40`), and the register name is not emitted;
2. a **`memoryMap`** entry that says the window is not I/O for that instruction — its operand reads like
   any other address (a data label, or the raw address) and carries no register comment;
3. the platform's **register name**.

A name past the project's length limit, one that is a mnemonic, or one the listing already uses for
another address is not used; the listing says so under the equate block and prints the address.

`memoryMap` says what `$D000-$DFFF` is at run time where the default (I/O) is not it. The bytes cannot
say: whether `sta $D011` writes the VIC-II or RAM depends on `$01`, which is program state. A depacker
that writes under the window with `$01 = $34` is declared once:

```jsonc
"memoryMap": [ { "start": "D000", "end": "DFFF", "as": "ram", "routines": ["C000"] } ]
```

- `start`/`end`: a range inside `$D000-$DFFF`; anything else is refused by `write_annotations` and skipped
  (and reported) by the loader.
- `as`: `io` (the default), `ram` or `charrom`. A later entry wins where two ranges overlap.
- `routines`: entry addresses. The declaration then holds only for the code of those routines — the entry
  and everything reachable from it by fall-through, branches and `jmp`. A routine it `jsr`s is a routine of
  its own and is not included. Absent, the declaration holds for the whole listing.
- the same range twice is one claim (its routines joined); the same range as two different things is a
  contradiction — refused by `write_annotations`, and by `merge_annotations` as `memoryMap:D000-DFFF`,
  naming both readings.

## Exact field names (the ones that bite)

| Section     | Required fields                          | NOT `addr`, NOT `name`(for a label) |
|-------------|------------------------------------------|-------------------------------------|
| `labels`    | `address`, `label`                       | use `address` (not `addr`), `label` (not `name`) |
| `routines`  | `address`, `name`                        | use `address` (not `addr`); a routine's descriptive field IS `name`; `comment` is optional |
| `segments`  | `start`, `end`, `kind`                   | use `start`/`end` (not `from`/`to`) |

Hex may be written `0810` or `$0810` — the loader strips a leading `$`.

## Relocated code: which address did you write?

A self-relocating loader is **stored** at one address and **runs** at another, so a byte
in it has two addresses and both are real. When you pass `relocations` to `disasm`,
a `segments` entry may say which one it means:

```jsonc
{ "start": "$CA1B", "end": "$CA47", "kind": "text", "label": "credit_text",
  "space": "runtime" }        // "runtime" (the default) | "file"
```

- **`runtime`** — the `.pseudopc` / `.logical` address, the one the listing shows and a
  breakpoint takes. This is the default when the address falls inside a relocation's
  runtime window, because it is what you read off the disassembly you are annotating.
- **`file`** — the stored position in the PRG, for when that is what you have: a
  hexdump offset, a sector, a byte pattern.

Outside any relocation the two are identical and the field changes nothing.

Both are always resolved: the listing renders the island inside the relocated block at
its runtime PC with its stored bytes, and **the graph is keyed on the runtime
address** — a trace hit, a checkpoint and `whowrote` all speak runtime — while keeping
the stored address and the relocation beside it. The listing header reports which space
each address was read in, and says so when a segment had to be clipped at a block
boundary.

## Tolerant loading

Loading never crashes. A missing section is treated as empty. An individual entry with an
unparseable / missing required field (a mistyped key is the usual cause) is **skipped**,
and the rest still apply. `disasm` reports it:

```
[annotations] applied 42, skipped 3:
  - label: unparseable address=undefined (label=main) — field "addr" should be "address"
  - label: address 0810 has no label — field "name" should be "label"
  - segment: unparseable range start=undefined end=09FF — field "from" should be "start"
```

If you expected more annotations to apply, check that `skipped` line — a wrong field key
is dropped, not applied.

### One thing is refused instead of skipped

Two `segments` entries may not declare the same `start`. A segment start is the id both
the listing and the knowledge graph are keyed on, so two entries on one start are a
contradiction rather than a repeat: the listing would be overlaid with both, and the
graph import is rolled back whole. The file is refused before anything is rendered and
before anything is imported, with the offending pair named:

```
REFUSED — the annotations file contradicts itself. Nothing was rendered and nothing was imported.

core_4300_annotations.json

2 segments declare the same start $43A8:
  - $43A8-$43AF  data  "tbl_lo"
  - $43A8-$43BF  pointer_table  "tbl_all"
```

A `splitTables` entry that cannot be taken (see *Split low/high tables* above) is refused
the same way, every offender named by its index. Give each range its own start, or merge the two into one entry. Ranges that merely
**overlap** at different starts are fine — reshaping a range across an analysis boundary
is what they are for — and are not refused.

## With and without an `analysis_json`

`disasm` renders either way, and the annotations apply either way — but not all
of them:

| | names (`labels`, `routines`, a `segments` entry's `label`) | `segments` kind, `pointerTables`, `jumpTables`, `immediates` |
|---|---|---|
| with `analysis_json` | applied | applied |
| without | applied | **not applied** — retyping a byte range needs the analyser's segments |

(`splitTables` belongs to the right-hand column. An annotations file addresses the file's
own bytes; a split table inside a relocated block is not translated to its runtime
address.)

An annotated address **outside** the rendered file is named only on the analysis path,
where the analyser records the reference; the legacy listing does not reference it and
does not claim it.

The listing's header line says which of these happened, and the `disasm` output
quotes that line back as `Listing: …`:

```
//  Semantic annotations applied: 39 names, 6 segment/table annotations
//  Semantic annotations applied: 39 names — the file's 6 segment/table annotations need an analysis JSON and were NOT applied
//  Semantic annotations found but NOT applied: the file declares no names and no segment/table annotations
//  No semantic annotations found
```

The `Graph:` line beside it is about the knowledge graph, not about the listing — a
graph import that says "unchanged" is not a statement that the names reached the ASM.

## An entry point inside another instruction

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

## A `code` range whose bytes end mid-instruction

Bytes carved out of a bigger file stop where the carve stopped, not where an
instruction does, so the last opcode in a block often wants operand bytes the
block does not hold. Classify the whole body as `code` anyway: the renderer
ends the code at the last instruction that FITS and emits what is left as data,
and says where and why.

```
      rts
// CODE ENDS at $430D, the last instruction that fits: $430E (1 byte) opens an
// instruction whose operand bytes are past the end of these bytes, and renders as data.
      .byte $AD
```

The boundary is read off the bytes — you never have to guess a data-tail length,
and you never have to drop the `code` classification to get a byte-identical
rebuild. The same line appears, naming the segment end instead, when an
instruction would cross the end of a `code` range you declared.

## A cartridge bank on its own

A bank carved off a cartridge is listed like any raw block: `disasm` with `load_address`
(`"8000"`, `"$8000"` and `"0x8000"` are all `$8000`; a JSON number is taken as given, so
`8000` is `$1F40`) — with or without `relocations`.

- **Where the names go.** `space` and `bank` decide the address space the graph files the
  annotation names under. `space: "crt"` with a `bank` (or a `bank` alone) files them under
  that cartridge bank, so a `model_assert` boundary in space `crt` at that bank holds them;
  `ram` and `drv` file them under the owner. A space the graph does not have, `crt` with no
  bank, or a bank beside `ram` is refused. The choice sticks with the import until another is
  stated, and stating another moves the nodes.
- **What `$DE00` is called.** The cartridge I/O window `$DE00-$DFFF` is named for the cartridge
  the bytes belong to, not for EasyFlash: the CRT header's hardware type decides (GMod2: the
  control register with bank bits, EEPROM CS/CLK/DI and DO on bit 7 of a read; EasyFlash:
  `EF_BANK` / `EF_CTRL`; Magic Desk, Ocean and MegaByter have their own). The type is the one
  recorded for the bytes — through the artifact's lineage, the directory `extract_crt` wrote
  them to, or the project's only cartridge — and the answer's `Cartridge:` line says which. The
  operand reads as the type's register (`gmod2_ctrl`, `ef_bank`, `magicdesk_bank`, …; see
  *I/O registers in the listing*) with the register description as the comment. Where no type
  is known the operand is the neutral `cart_io_de00` and the comment `cartridge I/O $DE00`.
