# PLA + Memory Bus Fidelity Notes (Spec 106 / M2.4) — v1

## v1 status

| Sub-story | Status     | Where                                                           |
|-----------|------------|-----------------------------------------------------------------|
| M2.4a PLA truth-table     | **Covered (no-cart half)** | 10 checks — $01=$37 (BASIC+KERNAL+IO), $33 (BASIC+KERNAL+char), $35 (KERNAL hidden), $30 (all RAM). 8 cart-state combinations gated on EXROM/GAME from cartridge wiring (Spec 128 / M6) |
| M2.4b $00/$01 CPU port    | **Covered**     | DDR latch + port value read/write round-trip. Capacitive fade gap (rare, see below) |
| M2.4c open-bus reads      | **Stubbed**     | Color RAM upper nibble = constant $f0; full open-bus VIC-coupled value deferred per spec fallback |
| M2.4d color RAM nibble    | **Covered**     | 5 checks — $D800-$DBFF reads return high nibble = $f, low = stored. Outside that range full byte preserved |
| M2.4e Ultimax fixture     | **Gap (deferred)** | EXROM/GAME from cartridge plumbing exists; Ultimax CRT fixture deferred to Spec 128 / M6 cart support |
| M2.4f I/O1/I/O2 cart hooks| **Stubbed**     | Cartridge interface in memory-bus.ts already routes; no concrete cart yet |
| M2.4g Documentation       | **This file**   | — |

`npm run smoke:pla-fidelity` — 22/22 pass.
`npm run regress` — 5/5 still green.

## PLA truth table (no-cart, EXROM=GAME=1)

`$01` low 3 bits → bank visibility:

| $01    | LORAM | HIRAM | CHAREN | $A000-$BFFF | $D000-$DFFF | $E000-$FFFF |
|--------|-------|-------|--------|-------------|-------------|-------------|
| $37    | 1     | 1     | 1      | BASIC       | I/O         | KERNAL      |
| $36    | 0     | 1     | 1      | RAM         | I/O         | KERNAL      |
| $35    | 1     | 0     | 1      | RAM         | I/O         | RAM         |
| $34    | 0     | 0     | 1      | RAM         | RAM         | RAM         |
| $33    | 1     | 1     | 0      | BASIC       | char ROM    | KERNAL      |
| $32    | 0     | 1     | 0      | RAM         | char ROM    | KERNAL      |
| $31    | 1     | 0     | 0      | RAM         | char ROM    | RAM         |
| $30    | 0     | 0     | 0      | RAM         | RAM         | RAM         |

I/O bank covers $D000-$DFFF: VIC ($D000-$D02E), SID ($D400-$D41C),
color RAM ($D800-$DBFF), CIA1 ($DC00-$DCFF), CIA2 ($DD00-$DDFF),
I/O1 ($DE00-$DEFF), I/O2 ($DF00-$DFFF).

## Color RAM nibble readback

Real HW: 1Kx4 SRAM at $D800-$DBFF. Only low nibble stored; high
nibble returns open-bus (last VIC fetch). Our model approximates
open-bus as constant $f0 to keep the lower-nibble round-trip
testable without leaking VIC state into deterministic test output.

```
write $D800, $4F  → SRAM cell stores $0F
read  $D800       → $f0 | $0f = $ff
write $D801, $07
read  $D801       → $f0 | $07 = $f7
```

Outside $D800-$DBFF (e.g. CIA registers at $DC00+) full bytes preserved.

Spec 106 fallback path: "Open-bus value coupled too tightly to VIC:
return constant $FF, document, refine in a follow-up spec." We picked
$f0 — close enough that color reads work, distinct enough that test
fixtures can recognise the open-bus contribution.

## Documented gaps

### M2.4b — DDR weak-fade

Real HW: when a CPU port pin is set to output then switched back to
input, capacitor on the pin holds the previously-driven level for a
short time (~40-200 µs) before fading. We don't model this. Almost
no software depends on the fade behavior; relevant only to the
"FREEZE" cartridge press-to-reset detection.

### M2.4c — Open-bus full model

Real open-bus value depends on the last VIC fetch in the current
half-cycle (sprite pointer, screen byte, char byte, bitmap byte).
Our $f0 stub satisfies low-nibble round-trip but won't reproduce
software that reads open-bus to detect VIC fetch type. Refine when
a target game requires it.

### M2.4e — Ultimax mode

PLA logic exists (`if (ultimax) bank8 = 'cart_lo'; bankE = 'cart_hi_ultimax'`).
No Ultimax-mode CRT fixture committed; cart wiring hooks need M6
to ship a real test path.

### M2.4f — I/O1/I/O2 cart hooks

`bus.cartridge?.read/write` route to the optional cartridge interface
when present. No concrete cart instance is constructed in v1; M6
will add cart classes that subscribe to $DE00-$DFFF.

## Files

- `src/runtime/headless/memory-bus.ts` — color RAM nibble readback at
  $D800-$DBFF.
- `src/runtime/headless/c64/pla-fidelity-tests.ts` — 4 suites, 22 checks.
- `scripts/smoke-pla-fidelity.mjs` + `npm run smoke:pla-fidelity`.
