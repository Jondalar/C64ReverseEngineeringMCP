# Bug: BASIC PRGs at `$0801` are treated as 6502 code instead of BASIC programs

- **ID:** BUG-007
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** analysis
- **Severity:** low
- **Status:** closed → backlog (Spec 731)

## Environment

- Branch / commit: 951cb2b
- Surface: analysis / disassembly heuristics
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `analyze_prg`, `disasm_prg`, extraction pipeline

## What happened

DDD `$0801` PRGs such as `DDD.LOAD` / `BOOT` are initially parsed as 6502 code. The analyzer later demotes them because it encounters JAM-like opcodes. This is misleading because `$0801` with a valid BASIC link-pointer chain is probably BASIC tokenized program data, not machine code.

## Expected

The analysis pipeline should recognize likely BASIC PRGs by load address `$0801` and BASIC line link-pointer structure, decode BASIC tokens, and classify them as BASIC/bootstrap text instead of raw 6502 code.

## Repro steps

1. Extract/analyze DDD `$0801` PRGs.
2. Observe that they are initially treated as 6502 code.
3. Observe demotion due to invalid/JAM opcodes rather than BASIC classification.

Minimal command / call:

```text
analyze_prg / disasm_prg on DDD.LOAD or BOOT PRG loading at $0801.
```

## Evidence

- Error / output (verbatim):

```text
BASIC als 6502 fehlklassifiziert.
$0801-PRGs (DDD.LOAD/BOOT) als Code geparst, dann wegen JAM-Opcodes demoted.
Heuristik könnte BASIC erkennen (Load $0801 + Link-Pointer-Kette) und Tokens decoden.
```

- Artifacts: DDD extracted PRGs.

## Scope guess (optional)

PRG analysis heuristics / BASIC token decoder integration.

## Notes / follow-up

- Enhancement-level compared with the blocking MCP/UI flow bugs.
- Should not block 724/729 acceptance unless the project flow depends on readable BASIC bootstrap output.

---

## Resolution — closed to backlog

- **Decision (2026-05-30):** this is an analysis enhancement, not a product-flow
  blocker. Closed as a bug and promoted to a tracked backlog spec rather than
  fixed inline.
- **Backlog spec:** `specs/731-basic-program-classification.md` (Status: BACKLOG)
  — `$0801` BASIC detection via the line-link chain, a CBM BASIC V2 detokenizer,
  classification as a `basic`/`basic_bootstrap` segment instead of demoted 6502
  code, and emitting the `SYS` target as an entry point. Includes the DDD
  `DDD.LOAD` / `BOOT` PRGs as fixture corpus.
- **Root cause (recorded):** the pipeline parses `$0801` PRGs as 6502 from the
  load address and only demotes them when it hits JAM/illegal opcodes; it never
  recognises tokenized BASIC. Fix belongs in code-discovery as a pre-pass (Spec
  731 §4).
- **Gate (future):** Spec 731 §5 acceptance.
- **Regression risk:** n/a (no code change in this bug closure).
