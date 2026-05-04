# Spec 106 — Headless M2.4: PLA and Memory Bus Fidelity

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.4
Depth: deep
Predecessors: Spec 098 (M1.1), Spec 105 (M2.3 VIC fetch tracking)

## Motivation

Memory banking covers basic boot and KERNAL access. Edge cases are
open: 6510 `$00/$01` direction quirks, open-bus reads (last VIC
fetch), Ultimax mode, color RAM half-byte readback, character ROM
access through VIC, I/O1/I/O2 cartridge ranges, and the
RAM-ROM-RAM "swiss cheese" pattern.

## Acceptance

- `$00/$01` 6510 IO port: DDR (`$00`) controls direction; reading
  `$00` returns DDR; reading `$01` returns DDR-masked actual lines.
  Input bits read external state; output bits read the written value.
- 16-state PLA truth table: every LORAM/HIRAM/CHAREN combination
  crossed with EXROM and GAME maps each range correctly. All 16
  states tested.
- Open-bus reads: unmapped ranges return the last byte fetched by VIC
  in the current half-cycle.
- Color RAM: `$D800-$DBFF` returns the 4-bit colour value plus
  open-bus upper 4 bits.
- Ultimax mode (GAME=0, EXROM=1): `$1000-$7FFF` and `$A000-$CFFF`
  unmapped; `$8000-$9FFF` and `$E000-$FFFF` map to cart ROMs; I/O
  remains mapped.
- VIC sees character ROM at `$1000-$1FFF` and `$9000-$9FFF` (banks 0
  and 2) regardless of CPU `$01`.
- I/O1 (`$DE00-$DEFF`) + I/O2 (`$DF00-$DFFF`) route to a cartridge
  handler when present.

## Sub-stories

### M2.4a — PLA truth-table tests
Table-driven test that synthesizes the 16-state matrix and asserts
read + write behavior per range.

### M2.4b — `$00/$01` port split
Separate DDR and PORT registers cleanly. Weak-pull-up capacitive fade
on previously-output-now-input bits is documented as a known gap.

### M2.4c — Open-bus model
Track last-VIC-fetched byte. Unmapped reads return it.

### M2.4d — Color RAM nibble readback
Return colour value in low 4 bits + open-bus upper 4.

### M2.4e — Ultimax fixture
Synthesize an Ultimax-mode CRT fixture and assert mapping.

### M2.4f — I/O1/I/O2 cart routing hooks
Minimal interface for M6 to plug into. Default = unmapped + open-bus.

### M2.4g — Documentation
`docs/pla-fidelity-notes.md` for intentional gaps and references.

## Deliverables

- EDIT `src/runtime/headless/c64/c64-bus.ts` (PLA, open-bus, color
  RAM nibble)
- EDIT or NEW `src/runtime/headless/c64/cpu-port.ts`
  (DDR/PORT separation)
- NEW `src/runtime/headless/c64/pla-fidelity-tests.ts`
- NEW synthetic Ultimax CRT fixture
- `docs/pla-fidelity-notes.md`

## Test fixtures

- 16 PLA-state synthetic PRGs (or one driver PRG that cycles states).
- 1 Ultimax CRT fixture.
- 1 open-bus read fixture.
- 1 color RAM nibble fixture.

## Dependencies

- Spec 098.
- Spec 105 (VIC publishes last-fetched byte for open-bus model).

## Risks and mitigations

- **Open-bus VIC coupling**: requires VIC to expose last-fetched byte.
  Mitigation: small `getLastFetchedByte()` interface; cycle-accurate
  not required; "last fetched" suffices for most software.
- **DDR weak fade**: real HW capacitive decay on output bits read as
  input. Almost no software depends on it. Mitigation: skip the fade,
  document gap.
- **Cart routing hook shape**: M6 will fill these in. Mitigation:
  define minimal I/O1/I/O2 callback interface now, M6 implements cart
  logic.
- **Ultimax rare in our path**: may surface latent bugs. Mitigation:
  synthetic CRT only; real cart games handled in M6.

## Fallback paths

- Open-bus value coupled too tightly to VIC: return constant `$FF`,
  document, refine in a follow-up spec.
- Ultimax fixture reveals deep bugs: split into a follow-up; ship the
  rest of M2.4.

## Exit criteria

- 16-state PLA fixture green.
- `$00/$01` DDR/PORT split correct.
- Open-bus test green.
- Color RAM nibble test green.
- Ultimax fixture boots to expected first frame.
- Spec 097 LOAD smoke unchanged.

## File-touch list

- EDIT `src/runtime/headless/c64/c64-bus.ts`
- EDIT or NEW `src/runtime/headless/c64/cpu-port.ts`
- NEW `src/runtime/headless/c64/pla-fidelity-tests.ts`
- NEW `samples/synthetic/cart/ultimax-test.crt`
- NEW `samples/synthetic/pla/*.prg`
- NEW `docs/pla-fidelity-notes.md`

## Out of scope

- Full cart bank-switching (M6 cart mappers).
- 8580 vs 6581 SID bus interaction (M2.6).
- REU / GeoRAM expansion bus.
