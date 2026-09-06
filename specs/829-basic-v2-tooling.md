# Spec 829 — BASIC V2 tooling: detokenize, list, tokenize

**Status:** PROPOSED 2026-09-06
**Origin:** Issue #11 (mrr19121970): `disasm_prg` renders a stock BASIC PRG's token bytes
as 6502 garbage, because it treats every PRG as machine code. Also closes the second half
of issue #10 (PETSCII control codes and colour names), which is not an address lookup and
therefore did not belong in Spec 828.
**Anchor:** Spec 828 (the reference is local, never fetched at use time) · `DOCTRINE.md`
rule 5 (read the reference before hypothesising) · the byte-identical rebuild standard
that governs every listing this repo produces
**Touches:** `pipeline/src/lib/basic-v2.ts` (new) · `pipeline/src/analysis/prg.ts`
(`detectBasicSysEntry`) · `pipeline/src/analysis/code-discovery.ts` + `types.ts` (the
segment kind) · `src/server-tools/` (two tools) · `scripts/e2e-829-basic-v2.mjs` (new)

## 1. What exists today, measured

Not nothing, but much less than it looks:

- `SegmentKind` already has **`basic_stub`**, and `code-discovery.ts` marks a segment with
  it when the entry came from a BASIC stub. Four consumers treat `basic_stub` exactly like
  `code` (`utils.ts`, `pipeline.ts`, `evidence-graph.ts`, `display-analysis.ts`).
- `detectBasicSysEntry` (`prg.ts:81`) is 45 lines: it looks for token `$9E` in the **first
  24 bytes**, then reads decimal digits and spaces, and returns that address as an entry
  point.

That is the whole of it. There is no detokenizer anywhere in the repo. So:

- a two-line stub whose `SYS` target is a bare decimal works;
- `SYS(2064)`, `SYS 2*4096`, `SYS PEEK(43)+256*PEEK(44)`, or a `SYS` after the 24th byte
  return **nothing**, silently;
- a real BASIC program — a menu, a loader with logic, an intro — is disassembled as 6502
  from `$0801` and produces confident nonsense, which is worse than an empty answer.

## 2. The gap

A cracked game very often boots through BASIC, and the interesting part is exactly the
part that is unreadable: which address does it `SYS` into, what does it `POKE` before
that, which file does it `LOAD`. Today that is read by hand, outside the MCP, which
breaks the server's own static-first workflow.

## 3. Decisions

**D1 — The token table is derived from the machine, not typed from a book.** BASIC V2's
keyword table lives in the BASIC ROM at `$A09E`: the keywords in order, each with the high
bit set on its last character, which *is* the token numbering (`$80` = `END` … `$CB` =
`GO`), followed by the operators and the functions. c64ref already carries that ROM
disassembly and Spec 828 already parses it. The table is generated from there and frozen
into `basic-v2.ts` as a checked-in constant, so the tool needs no snapshot at runtime.

Cross-checked against two independent sources, and the disagreements are the point:
*C64/C128 Spielend BASIC lernen* (archive.org) lists 49 keywords in its Appendix A, is
OCR-damaged (`ASCO` for `ASC(`, `cos o` for `COS(`) and omits `POKE`, `LEFT$`, `MID$`,
`FRE`, `DEF`, `TAB`, `SPC`. It is a **cross-check on names**, never a source, and nothing
from it is copied into the repo — the same rule Spec 817 applies to the c64ref prose:
a keyword is a fact, a book's paragraph is not ours to ship.

**D2 — Whether it IS BASIC is decided by walking the line records, not by guessing.** From
the load address: a 2-byte next-line pointer, a 2-byte line number, tokens, a `$00`
terminator; the chain must ascend, stay inside the image, and end at a `$0000` pointer.
Only a clean walk yields a BASIC segment. A file that merely starts at `$0801` and fails
the walk is reported as **not BASIC**, with the byte offset where the chain broke —
half-rendering is how the current behaviour became a bug.

**D3 — The round trip is the gate, at the repo's usual standard.** `detokenize` →
`tokenize` → byte-identical to the input, the same rule as the KickAssembler rebuild.
A lister nobody can invert is a lister nobody can trust: the inverse is what proves the
token table and the string handling are right, not a screenshot of a listing.

**D4 — The `SYS` target is the deliverable, not a side effect.** With the program
detokenized, every `SYS`, `USR` and `LOAD` argument is extracted:

| form | result |
|---|---|
| `SYS 2064` | entry point, `certain` |
| `SYS(2064)`, `SYS 2064:` , leading spaces | entry point, `certain` — all missed today |
| `SYS 2*4096` | constant-folded, `inferred` |
| `SYS PEEK(43)+256*PEEK(44)` | reported as **unresolved**, with the expression, never silently dropped |
| `LOAD "NAME",8,1` | the file name, as a lead into the disk side |

`detectBasicSysEntry` becomes a thin caller of this, so the 24-byte window and the
digits-only parse both disappear.

**D5 — Control codes and colours get names, from a bundled table.** `{CLR}`, `{RVS ON}`,
`{CYAN}`, `{DOWN}` in strings and `REM`s. This is issue #10's second half: the table is
bundled, not fetched (828 D3), and it is small enough to be checked in. Rendering is
reversible — `{RVS ON}` tokenizes back to `$12` — because of D3.

**D6 — A new segment kind `basic`, and `basic_stub` keeps its meaning.** A stub is a
two-line launcher; a program is not. The four `basic_stub` consumers gain `basic`
alongside, and the disassembler skips a `basic` segment instead of rendering 6502 over it.

**D7 — Two tools.** `basic_list` (a PRG or a region → the listing, plus the extracted
`SYS`/`LOAD` facts) and `basic_tokenize` (text → bytes). They land in the default surface,
which moves the tool cap by two; that is stated here rather than discovered by the probe.

## 4. Gate

`scripts/e2e-829-basic-v2.mjs` (`npm run e2e:829`), hermetic — no ROM, no network:

- **round trip on real shapes**: a one-line SYS stub, a multi-line program with strings,
  `REM`s, `DATA`, control codes, quotes inside strings, and a line number above 63999 —
  each `detokenize → tokenize` byte-identical;
- the token table has 76 entries, no gaps, no duplicates, and `$80`/`$CB` are `END`/`GO`;
- every keyword the book's Appendix A lists is in the table (the cross-check of D1, run as
  an assertion so a future edit cannot quietly lose one);
- the chain walk rejects: a truncated record, a pointer that goes backwards, a pointer
  outside the image, a missing terminator — each reported with the offset;
- `SYS` extraction covers all five D4 forms, and the unresolved one is reported as
  unresolved;
- a machine-code PRG at `$0801` is **not** claimed as BASIC;
- control codes round-trip by name.

## 5. Acceptance

- `basic_list` on a stock BASIC loader prints the listing and names its `SYS` target.
- `analyze_prg` marks the BASIC region `basic`, and `disasm_prg` no longer renders 6502
  across it.
- `e2e:829` green; `gates.yml` green.

## 6. Non-goals

- BASIC extensions (Simons' BASIC, Turbo, the C128's BASIC 7.0). The table is V2; an
  unknown token renders as `{$XX}` and round-trips, rather than being guessed at.
- Executing BASIC. That is the runtime's job.
- Re-typing the book. It is a cross-check on names (D1) and nothing from it is committed.
