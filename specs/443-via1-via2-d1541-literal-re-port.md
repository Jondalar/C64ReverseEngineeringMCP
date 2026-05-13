# Spec 443 — VIA1 + VIA2 d1541 literal re-port

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 442 (viacore re-audit)  
**Doctrine:** VIA1 partially done (Spec 433). VIA2 never audited.
Both must reach 1:1.

## Source

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c` 420 LoC
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via2d.c` (or
  `via1571.c` / `via4000.c` depending on drive type — verify path)

VIA2 file:line confirmation required first task (grep VICE tree).

## Headless target

- `src/runtime/headless/via/via1d1541.ts` 383 LoC
- `src/runtime/headless/via/via2d1541.ts` 197 LoC

## Audit (Claude-self)

For each: produce `docs/spec-443-via1d1541-audit.md` and
`docs/spec-443-via2d1541-audit.md`.

Each row: VICE-fn → TS-impl → verdict.

### VIA1 functions in scope

- `via1d1541_setup_context`
- `set_int` — IRQ → drive CPU
- `store_pra` / `read_pra` (1541 stock: no-op except for parallel
  cable variant)
- `store_prb` / `read_prb` — IEC bus interface, literal formulas
- `set_ca2` / `set_cb2` — no-ops on 1541
- `store_pcr` / `read_pcr`
- `reset`
- `pa_undump` / `prb_undump`

### VIA2 functions in scope

- `via2d_setup_context` (= `via1571d_setup_context` for 1541 type)
- `set_int`
- `store_pra` / `read_pra` — head step + density + LED
- `store_prb` / `read_prb` — head data byte
- `set_ca2` / `set_cb2` — BYTE-READY (CA2), MODE switch (CB2)
- `store_pcr` / `read_pcr`
- Shift register coupling with rotation (PA reads from shifter)
- BYTE-READY ↔ SO line ↔ rotation_byte_ready

## Acceptance

1. Two audit docs committed.
2. Formula verification in unit tests:
   - `tests/via1d1541-formulas.test.ts` (extend existing — Spec 433
     had 0 vectors)
   - `tests/via2d1541-formulas.test.ts` (new — 0 today)
3. SO-line wiring verified end-to-end (VIA2 CA2 → CPU SO flag for
   BIT instruction).
4. All canaries green.

## Do Not

- Don't merge VIA1 and VIA2 wrappers.
- Don't add parallel-cable support (separate spec, deferred).
- Don't audit via6522-vice.ts internals here (Spec 442 owns).
