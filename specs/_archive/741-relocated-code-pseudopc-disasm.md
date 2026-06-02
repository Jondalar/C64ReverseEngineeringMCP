# Spec 741 — Relocated-Code Disassembly (`.pseudopc`/`.logical`) + Optional Whole-Disk Source Assembly

**Status:** DONE — 2026-05-31 (Slices A–D shipped; §4 whole-disk `.include`
export is explicitly an optional non-goal, not part of this spec's DONE bar).
Driven by the Wasteland EF reverse-engineering project.

**Implementation (Slices A–D, gates `smoke-741` 50/50 + MCP E2E `e2e-741` 13/13):**
- **A** — `disasm_prg.relocations[]` → KickAssembler `.pseudopc` / 64tass
  `.logical`/`.here` at the runtime PC; stored bytes byte-exact; one source file
  per payload; default output unchanged. (`d5c5d13d`)
- **B** — mixed code/data `subSegments` (code spans → instructions, data spans →
  `.byte`), self-mod `$FFFF` operand kept + annotated, labels resolve across the
  block, and relocations combine with analysis-driven gap rendering. (`fdfd4aa7`)
- **C** — `analyze_prg` detects copy loops (`detectRelocationProposals`) and
  surfaces `{fileStart,fileEnd,runtimeAddr}` proposals via `propose_annotations`,
  ready to feed back into `disasm_prg.relocations` (full detect→propose→render→
  verify loop is byte-exact).
- **D** — mixed-island splitter in `demoteBrokenCodeIslands` closes **BUG-021**:
  a trusted-entry code island is split at the confirmed/unconfirmed boundary
  instead of demoting the whole range; fully-confirmed islands are never demoted.

**Not done (optional, §4):** whole-disk `.include`/`.import` rebuild trees and a
`build_disk_from_sources` disk-builder. Documented here as an optional aggregate
export, not part of the default per-payload disassembly model.
**Parent specs:** `specs/720-disasm-output-quality.md` (static labels / segment classification), `specs/042-*` (`propose_annotations`), `specs/413-1541-phase-g-image-formats.md` (c1541 platform / disk geometry). Relates to `disasm_prg`, `analyze_prg`, `assemble_source`.
**Scope:** Make the disassembler able to render **relocated / self-relocating code** (and runtime-overlaid code) as REAL CODE at its **runtime address** while keeping the source **byte-exact reassemblable at its stored (file/disk) position**, using the assembler relocation directives that already exist in KickAssembler and 64tass.

**Product source-shape rule:** keep a **1:1 relationship between extracted blob/payload/file and disassembly source file** whenever technically possible. A payload such as `02_2.0.prg` should produce one canonical source file whose internal regions may use `.pseudopc` / `.logical`. Do **not** split one payload into multiple source files merely because it contains relocated blocks. Multi-file `.include` trees are an optional disk-rebuild/export feature, not the default disassembly model.

---

## 1. Problem

Real C64 loaders/cracks routinely **store code at one address and run it at another**:

- An installer copies a blob from its load image to a runtime region, then `JMP`s in
  (`LDA $C300,X / STA $FC00,X` page-walk; block movers; KERNAL-shadow overlays).
- 1541 drive code is delivered by `B-E`/`M-W` and runs in drive RAM ($0300/$0700) — a
  different address space entirely.

Today `disasm_prg` renders bytes at their **file offset**. Relocated blobs therefore:
- get **demoted to `.byte`** (their branch/JMP targets point at the *runtime* address,
  not the file offset, so the recursive traversal sees "branches into data" + JAMs), and
- even when force-disassembled at the file offset, all internal labels are **wrong**
  (off by `runtime-file`), so the listing is unreadable and **not reassemblable**.

The result: large parts of a loader (the most interesting parts) are an opaque `.byte`
wall, and we cannot produce a byte-exact, semantically-annotated, rebuildable source.

---

## 2. The technique (already supported by both assemblers — PROVEN byte-exact)

Both target assemblers can place code at a **logical (runtime) PC** while emitting bytes
at the **real (file) PC**:

- **KickAssembler:** `.pseudopc <runtimeAddr> { ... }` inside a `.pc = <fileAddr>` segment.
- **64tass:** `.logical <runtimeAddr>` … `.here` inside a `* = <fileAddr>` section.

So the rebuild-capable rendering of a relocated blob is simply: **disassemble the bytes at
the runtime address** (correct labels), then **wrap that body** in a `.pseudopc/.logical`
block opened at the file address. The body is identical to a normal runtime-address disasm.

### Worked example (byte-exact, verified via `assemble_source`)

Wasteland side-1 loader `2.0` ($C000) copies `$C300-$C6FF` → `$FC00` and runs the resident
fastloader there (`$FC00 = JMP $FF00`; serial send `$FD2C`; receive+GCR-LUT `$FD9E`/`$FE00`;
block-read loop `$FF00`).

```asm
// stored at $C300, runs at $FC00
.cpu _6502
.pc = $C300 "fastloader (stored)"
.pseudopc $FC00 {
        jmp  $FF00            // $FC00 entry
        // ... $FC03 timing/pad, $FD2C send_byte, $FD9E recv_byte,
        //     $FE00 GCR decode LUT (.byte), $FF00 block_read_loop ...
}
```

`assemble_source(kickassembler, compare_to=$C300-image)` → **Match: yes, 1026 bytes.**
Artifacts in the Wasteland project:
`analysis/disk/wasteland_s1[...]/02_2.0_fastloader_pseudopc.asm` (+ `.prg`, `reloc_C300.prg`).
The body was produced by disassembling `reloc_FC00.prg` (the same bytes given load addr
$FC00) and changing only the two header lines + wrapping braces.

---

## 2a. Meta-model — demotion ≠ data (the distinction a relocation pass must make)

A disassembler demotes relocated / self-modifying code to `.byte` for THREE causes that
*look identical* (all become an opaque `.byte` wall) but are NOT the same:

1. **Wrong-PC labels (relocation).** Branch/JMP/abs targets resolve against the *runtime*
   address, not the file offset → recursive traversal sees "branches into data" → demote.
   This is **code**; fixed by disassembling the span at its runtime PC (§2).
2. **Self-modified operand placeholders.** Relocated loaders carry instructions whose
   operand is patched at runtime, e.g. `B9 FF FF` = `lda $FFFF,y`. The `$FFFF` sentinel
   (and the patch sites that write it) make spans look like JAM / illegal opcodes → demote.
   This is **code**: emit the instruction (`lda $FFFF,y`) and, where the patcher PC is
   known, annotate "operand self-modified by <PC>". Both assemblers reassemble it
   byte-exact, and the patch itself is expressible (`sta LABEL+1`).
3. **Genuinely embedded data tables.** GCR decode LUTs, sector-interleave tables,
   timing/pad. This is the **only** real `.byte`.

**Consequence — a relocated region is MIXED.** A single copied blob (e.g. `$C300→$FC00`)
interleaves routines with LUTs. The relocation map is therefore NOT "one span = one kind":
each `.pseudopc`/`.logical` block needs the SAME code/data sub-segmentation as a normal
disassembly, evaluated at the runtime PC. Causes (1)+(2) → promote to code; cause (3) →
keep `.byte`.

**The reliable promotion path.** Entry-points alone do NOT override `code-island-demote`
(the analysis JSON wins — observed repeatedly). Promotion requires a **span-level kind
hint**: an annotations file reclassifying spans to `code`, then re-disasm. So the
relocation feature should accept (or detect→propose→accept) **per-span kinds**, not just
`{fileStart,fileEnd,runtimeAddr}`.

**Verification is the contract.** Every relocated/promoted rendering MUST pass
`assemble_source compare=original` byte-exact. That invariant makes aggressive
code-promotion safe — any false promotion that changes a byte is caught immediately.

---

## 3. Requested MCP changes

### 3.1 `disasm_prg` — relocation map input
Add an optional `relocations` input: a list of
`{ fileStart, fileEnd, runtimeAddr, label?, subSegments?: [{ start, end, kind, label?, comment? }] }`.
For each entry, the disassembler:
- disassembles `fileStart..fileEnd` **as if PC = runtimeAddr** (labels/branches/abs refs
  resolve at runtime address),
- applies `subSegments` (runtime-addressed) as code/data kind hints WITHIN the block, so a
  mixed blob renders routines as code and LUTs as `.byte` (per §2a) — same kind model as a
  normal disasm, just at the runtime PC; absent `subSegments`, run normal traversal at the
  runtime PC,
- emits it wrapped in `.pseudopc runtimeAddr { … }` (KickAss) / `.logical runtimeAddr … .here`
  (64tass) inside the surrounding `.pc = fileStart` segment,
- emits self-mod operands as instructions (sentinel operand kept; optional
  `// operand self-modified by <PC>` note),
- keeps everything else (non-relocated regions) rendered at file offset as today.
Rebuild stays byte-exact (the bytes are unchanged; only the *interpretation* PC differs).

### 3.2 `analyze_prg` — relocation DETECTION + proposal
Detect relocated regions and propose `relocations[]` entries (with confidence), from:
- **Static**: copy-loop recognition — `LDA src,(X|Y) / STA dst,(X|Y)` with optional
  self-mod page-walk (`INC loop+1/+2`), block movers (`LDA (zpSrc),Y / STA (zpDst),Y`),
  and the immediately-following `JMP`/`JSR` into `dst`. Infer `src→dst` and the length
  from the loop bound.
- **Runtime-confirmed (optional)**: if a trace store is supplied, confirm `src→dst` from
  memory-write events (writer PC in the copy loop, dest range) — same evidence model as
  Spec 721. Mark whether the reloc is static-only or trace-confirmed.
Surface proposals through `propose_annotations` so a human/LLM can accept them, then feed
the accepted set back into `disasm_prg.relocations`.

### 3.3 `assemble_source` — already sufficient
No change: it already assembles `.pseudopc`/`.logical` and byte-compares. It is the
verification gate for §3.1 (round-trip must be `Match: yes`).

---

## 4. Optional extension — whole-disk rebuild trees via `.include`

The same 6502 opcode set serves both CPUs; KickAss and 64tass both assemble the 1541
(drive) code fine. The differences are only the **symbol/IO map** (drive VIA `$1800`/`$1C00`,
buffers `$0300-$07FF`, DOS ROM `$C000-$FFFF`) and the fact that drive code is a **separate
binary placed on disk sectors**, not part of the C64 PRG.

`disasm_prg` already has `platform: c1541` (correct ZP/IO/ROM symbols). The optional
extension is to make a whole title **rebuild-capable as one source tree**:

```asm
// wasteland_s1_disk.asm  — master build (disk image)
.cpu _6502
.import source "c64/prodos.asm"        // .pc = $02BE
.import source "c64/loader_2_0.asm"    // .pc = $C000, with .pseudopc blocks ($FC00, $DD80, $5B00)
// drive-side units assembled to raw binaries, then placed at their disk T/S by a disk builder:
.import source "drive/drive_s11.asm"   // .pc = $0700  (1541)  -> T18/S11
.import source "drive/drive_s12_15.asm"// .pc = $0300  (1541)  -> T18/S12..S15
```

- KickAss: `.import source "<file>"` (a.k.a. include); separate emit via `.segment`/
  `.file [name=…, segments=…]`, or assemble each unit standalone and let a disk-builder
  step place the raw bytes at the right track/sector.
- 64tass: `.include "<file>"`; sections / multiple `--output` for the separate binaries.

So the optional deliverable structure for a fully reconstructable disk is: existing
per-artifact source units (each extracted PRG/blob/drive payload keeps its canonical
source file; relocated parts stay inside that file in `.pseudopc/.logical`; drive parts
are tagged `platform c1541`), a thin `.include`/`.import` master, and a
**disk-layout manifest** mapping each assembled binary → track/sector(s) (this is the
`extract_disk` manifest in reverse).

This extension must not weaken the product source-shape rule above. The default
workspace remains one source per extracted artifact:

- disk PRG/file payload -> one source file;
- extracted raw blob / relocated block -> one source file if it is itself a
  first-class extracted artifact;
- drive-sector payload -> one source file for that drive blob;
- optional whole-disk master -> thin build wrapper only, referencing existing
  per-artifact sources.

In other words: `.include` is for an aggregate rebuild target, not for fragmenting
a single payload's normal disassembly.

### 4.1 Suggested helper
A `build_disk_from_sources` (or extend `assemble_source`) that takes the master + a
T/S placement manifest and emits a `.d64`/`.g64`, then byte-compares against the original
image (closes the loop: source tree ⇒ original disk, byte-exact).
This helper consumes existing per-artifact sources; it must not create split region
source files as a side effect.

---

## 5. Acceptance criteria

1. `disasm_prg(relocations=[…])` emits `.pseudopc`/`.logical` blocks; `assemble_source`
   round-trips **byte-exact** (the §2 Wasteland fastloader is the first fixture).
   The default output remains **one canonical source file per input payload/blob**;
   relocated subregions are represented inside that file, not as extra source files,
   unless the user explicitly requests an aggregate disk rebuild export.
2. `analyze_prg` detects the §3.2 copy-loop pattern and proposes the correct
   `{src,dst,len}` for the Wasteland `$C300→$FC00`, `$C27A→$DD80`, `$C17B→$5B00` copies.
3. Optional multi-unit `.include` build (C64 + 1541 drive) assembles without duplicating
   or replacing the canonical per-artifact source files; each unit round-trips byte-exact;
   optional disk-builder reproduces the source disk image byte-exact.

---

## 6. Notes / fixtures

- Driving project: `/Users/alex/Development/C64/Cracking/Wasteland_EF` (side 1).
- Tracking bug / acceptance fixture: `bugs/BUG-021-disasm-demotes-mixed-code-data-installer-to-unknown.md`.
- Proven fixtures already on disk:
  - **`analysis/disk/wasteland_s1[...]/02_2.0_full.asm`** — the CANONICAL one-file result:
    ALL of `02_2.0.prg` ($C000, 2030 B) in one source; in-place installer code +
    `.pseudopc $DD80 { … }` (self-mod block-mover) + `.pseudopc $FC00 { … }` (fastloader,
    mixed code+LUTs) + `.byte` data tables. `assemble_source` → **Match: yes, 2032 bytes.**
    Demonstrates the §2a mixed-region model end to end (one payload = one file).
  - `02_2.0_fastloader_pseudopc.asm` (first single-blob proof) (+ verified `.prg`)
  - `reloc_FC00.prg` / `reloc_C300.prg` (same bytes, two PCs); `reloc_DD80.prg` /
    `reloc_DD80_code.asm` (self-mod block-mover, hand-promoted to code, byte-exact 130 B);
    `reloc_FC00_disasm_annotations.json` (the §2a span-kind hints that promote `$FF00`
    code while keeping `$FE00` GCR-LUT / `$FDD4` interleave as `.byte`).
  - drive units (already byte-exact, `platform c1541`, both KickAss AND 64tass verified):
    `drivecode/t18s11_0700_disasm.asm` (+ `.tass`), `drivecode/t18s12-15_0300_disasm.asm`.
- Relocation pairs in Wasteland `2.0` to use as detection fixtures: `$C300→$FC00` (4 pages),
  `$C27A→$DD80` (128 B), `$C17B→$5B00` (256 B, data).
- Keep the existing false-positive guards in mind: the demoted "music_data"/"charset"/
  "exomizer_sfx packed" banners on these regions are wrong — they are relocated code/tables.
