# Bug: BASIC PRGs at `$0801` are treated as 6502 code instead of BASIC programs

- **ID:** BUG-007
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** analysis
- **Severity:** low
- **Status:** open

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

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
