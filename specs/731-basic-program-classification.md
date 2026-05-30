# Spec 731 — BASIC Program Classification & Detokenization

**Status:** BACKLOG (2026-05-30)
**Owner:** analysis pipeline
**Depends on:** `pipeline/src/analysis/pipeline.ts` (code-discovery + segment classification), `pipeline/src/lib/prg-disasm.ts`
**Source bug:** `bugs/BUG-007-basic-prg-treated-as-6502-code.md` (closed → tracked here)
**Priority:** low / enhancement (does not block any 724/729 product flow)

## 1. Why this spec exists

C64 BASIC programs load at `$0801` and are **tokenized BASIC**, not 6502
machine code. The analysis pipeline currently parses such PRGs as 6502 from
the load address, then *demotes* them when it hits JAM / illegal opcodes
(the tokenized bytes look like garbage code). The result is misleading: a
`DDD.LOAD` / `BOOT` bootstrap shows up as broken disassembly instead of a
readable BASIC listing.

This matters most for **bootstrap / loader stubs** — the common
`10 SYS 2061` style launcher that hands off to the real machine code. Being
able to read that one line tells the analyst exactly where the program
actually starts.

## 2. Detection heuristic

A PRG is *likely BASIC* when ALL hold:

1. **Load address `$0801`** (PAL/NTSC default BASIC start). Also accept the
   relocated starts `$1C01` (C128 mode) and `$0401` as lower-confidence
   variants behind a flag.
2. **Valid line-link chain:** starting at the load address, each BASIC line
   is `[next_line_ptr: u16 LE][line_number: u16 LE][tokens...][0x00]`, and
   `next_line_ptr` points forward within the image (monotonic, in range),
   terminating with a `0x0000` link. Require ≥1 well-formed line and a clean
   terminator for high confidence.
3. **Line numbers are non-decreasing** across the chain (BASIC requires
   ascending line numbers).

Confidence scales with the number of cleanly-walked lines. A single
`10 SYS <addr>` line is enough to classify as `basic_bootstrap` and to
surface the `SYS` target as an entry point.

## 3. Detokenizer

Implement a CBM BASIC V2 detokenizer:

- Map the 76 BASIC V2 tokens (`0x80`–`0xCB`: `END`, `FOR`, … `GO`) to
  keywords; bytes `< 0x80` are literal PETSCII.
- Render each line as `<line_number> <detokenized text>`.
- Extract numeric arguments of `SYS`, `LOAD`, `POKE`, and the target of
  the first `SYS` → emit as an **entry point** / cross-reference so the
  downstream machine-code analysis starts at the right address.
- Out of scope (this spec): BASIC extensions / other dialects (Simons'
  BASIC, etc.). V2 only; unknown tokens render as `{$XX}`.

## 4. Pipeline integration

- New analyzer (or a pre-pass in code-discovery) that runs the §2 heuristic
  BEFORE 6502 code discovery claims `$0801`. On a hit:
  - classify the BASIC region as a new `SegmentKind` (`basic` /
    `basic_bootstrap`) instead of `code`.
  - emit the detokenized listing into the disasm output (as commented BASIC,
    non-destructive — the bytes are never rewritten).
  - register the `SYS` target as an entry point so the rest of the PRG
    (machine code after the BASIC area) is analyzed from the correct PC.
- Must NOT regress the existing code-island demotion (Spec 047): a PRG that
  is genuinely code at `$0801` (no valid link chain) stays code.

## 5. Acceptance

- A `$0801` PRG with a valid line-link chain classifies as `basic` /
  `basic_bootstrap`, not `code`, and is no longer demoted via JAM opcodes.
- The detokenized listing is readable (at least the `10 SYS …` bootstrap),
  and the `SYS` target appears as an entry point feeding machine-code
  analysis.
- A non-BASIC `$0801` PRG (no valid chain) is unaffected (still code).
- Byte-identical rebuild (`cmp -l`) still holds — classification + comments
  only, never byte edits.
- Fixture corpus: DDD `DDD.LOAD` / `BOOT`, plus a hand-built
  `10 SYS 2061` launcher.

## 6. Notes

- Enhancement-level; pulled out of the blocking 724/729 product work.
- A minimal first slice = detection (§2) + bootstrap detokenize (`SYS`
  line only) + entry-point emission; full V2 detokenization (§3) can
  follow.
