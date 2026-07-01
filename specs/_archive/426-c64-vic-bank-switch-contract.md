# Spec 426 — C64 VIC bank switch contract

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 404, 425
**Doctrine:** VIC-II banking must follow real C64 wiring and VICE x64sc.
This is not a graphics-mode rewrite and not a renderer task.

## Goal

Fix and lock the VIC-II 16KB bank selection path.

The literal VIC-II renderer already implements the 8 ECM/BMM/MCM graphics
modes very close to VICE. The remaining banking risk is that the active
TS runtime currently derives the VIC bank late in `tickLitVic()` from:

```ts
const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
const bank = (~cia2Pa) & 0x03;
```

That is not the VICE / real-C64 contract.

The VIC bank must be selected from the effective CIA2 Port A output byte:

```c
byte = PRA | ~DDRA;
new_vbank = (~byte) & 3;
```

The bank switch must be pushed when CIA2 PA/DDRA changes, not recomputed
after every `vicii_cycle()`.

## Source of truth

### Hardware reference

- Christian Bauer, "The MOS 6567/6569 video controller (VIC-II) and its
  application in the Commodore 64":
  `https://www.zimmers.net/cbmpics/cbm/c64/vic-ii.txt`

Relevant sections:

- `2.4.2 Memory map as seen by the VIC`
  - VIC has 14 address lines and sees one 16KB bank at a time.
  - Missing A14/A15 bits come from inverted CIA2 Port A bits 0/1.
  - Char ROM appears in VIC banks 0 and 2 at `$1000-$1fff` / `$9000-$9fff`.
  - Color RAM is not in the 16KB bank map; it is addressed separately by
    the lower 10 VIC address bits.
- `3.7.3 Graphics modes`
  - Confirms c-access and g-access address formation.
  - ECM clears g-address bits 9/10.

### VICE source reference

Use these installed VICE files as implementation truth:

- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cia2.c`
  - class/module equivalent: C64 CIA2 integration
  - function: `store_ciapa`
  - lines `136-155`
  - key contract:

```c
tmp = (uint8_t)~byte;
new_vbank = tmp & 3;
if (new_vbank != vbank) {
    vbank = new_vbank;
    c64_glue_set_vbank(new_vbank, pa_ddr_change);
}
```

- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64gluelogic.c`
  - class/module equivalent: C64 glue logic
  - function: `c64_glue_set_vbank`
  - lines `86-106`
  - key contract: normally perform bank switch immediately; special
    glue-logic delayed cases exist but can be deferred unless tests show
    they are required.

- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii.c`
  - class/module equivalent: VIC-II chip
  - functions: `vicii_set_vbank`, `vicii_set_phi1_vbank`,
    `vicii_set_phi2_vbank`
  - lines `364-388`
  - key contract:

```c
void vicii_set_vbank(int num_vbank)
{
    int tmp = num_vbank << 14;
    vicii_set_vbanks(tmp, tmp);
}
```

- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-fetch.c`
  - class/module equivalent: VIC-II fetch path
  - functions: `fetch_phi1`, `fetch_phi2`, `g_fetch_addr`,
    `vicii_fetch_matrix`
  - lines `50-100`, `158-199`, `234-272`
  - key contract: actual fetch address is local VIC address plus
    `vicii.vbank_phi1` / `vicii.vbank_phi2`.

## Current TS files

Primary implementation targets:

- `src/runtime/headless/peripherals/cia2.ts`
  - TS class/module equivalent of VICE `c64cia2.c`
  - currently receives CIA2 PA/DDRA changes and forwards IEC output.
- `src/runtime/headless/integrated-session.ts`
  - currently recomputes `vbank_phi1` / `vbank_phi2` inside
    `tickLitVic()`.
- `src/runtime/headless/vic/literal/vicii.ts`
  - owns literal VIC init/reset and RAM binding.
- `src/runtime/headless/vic/literal/vicii-types.ts`
  - contains `vicii.vbank_phi1` / `vicii.vbank_phi2`.
- `src/runtime/headless/vic/literal/vicii-fetch.ts`
  - uses `vbank_phi1` / `vbank_phi2` during fetches.
- `src/runtime/headless/peripherals/vic-renderer.ts`
  - has `computeVicBankBase()` helper; use only for test expectations or
    UI reporting, not as the core source of truth.

## Current problem

The current active literal path derives the bank in
`IntegratedSession.tickLitVic()`:

```ts
const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
const bank = (~cia2Pa) & 0x03;
lv.vbank_phi1 = bank * 0x4000;
lv.vbank_phi2 = bank * 0x4000;
```

Problems:

1. `pra & ddra` is not the effective CIA output byte.
   - For CIA output, VICE uses `PRA | ~DDRA`.
   - CIA input bits float high unless externally driven.
   - With DDRA bit 0/1 as input, `pra & ddra` forces the bit low, which
     can select the wrong VIC bank.

2. The bank is applied after `vicii_cycle()`.
   - `tickLitVic()` calls `vicii_cycle()` first, then updates
     `vbank_phi1/phi2`.
   - VICE applies bank changes when CIA2 PA/DDRA changes via
     `c64_glue_set_vbank()` -> `vicii_set_vbank()`.
   - Raster bank splits can become one cycle late.

3. The bank source is hidden in the renderer tick.
   - Bank switching is C64 glue/CIA2 behavior, not renderer behavior.
   - `tickLitVic()` should not derive global machine wiring state.

## Required design

Introduce an explicit C64 VIC bank switch path:

```ts
function setLiteralVicBank(newVbank: number): void {
  const base = (newVbank & 0x03) << 14;
  vicii.vbank_phi1 = base;
  vicii.vbank_phi2 = base;
}
```

Then call it from the CIA2 PA/DDRA store path when the effective output
byte changes:

```ts
const byte = (pra | ~ddra) & 0xff;
const newVbank = (~byte) & 0x03;
if (newVbank !== currentVbank) {
  currentVbank = newVbank;
  setLiteralVicBank(newVbank);
}
```

This should mirror VICE:

```text
c64cia2.c store_ciapa
  -> c64_glue_set_vbank(new_vbank, pa_ddr_change)
     -> perform_vbank_switch(new_vbank)
        -> mem_set_vbank(new_vbank)
           -> vicii_set_vbank(new_vbank)
```

## Implementation steps

### Step 1 — Add literal VIC bank setter

Add a small exported function in `src/runtime/headless/vic/literal/vicii.ts`:

```ts
export function vicii_set_vbank(num_vbank: number): void {
  const base = (num_vbank & 0x03) << 14;
  vicii.vbank_phi1 = base;
  vicii.vbank_phi2 = base;
}
```

Optional but useful:

```ts
export function vicii_set_vbanks(phi1: number, phi2: number): void { ... }
export function vicii_get_vbank(): number { return (vicii.vbank_phi1 >>> 14) & 3; }
```

Keep this literal to VICE `vicii.c:364-376`.

### Step 2 — Wire CIA2 to VIC bank switching

Extend `installCia2()` options in `src/runtime/headless/peripherals/cia2.ts`:

```ts
onVicBankChange?: (newVbank: number, effectivePa: number, ddrChanged: boolean) => void;
```

Inside the existing `storePa` callback, after computing current PRA/DDRA,
compute:

```ts
const effectivePa = (pra | ~ddr) & 0xff;
const newVbank = (~effectivePa) & 0x03;
```

Call `onVicBankChange` only when `newVbank` changes, matching VICE
`if (new_vbank != vbank)`.

The callback should be invoked for both:

- writes to CIA2 PRA (`$DD00`)
- writes to CIA2 DDRA (`$DD02`)

because both can change the effective output byte.

### Step 3 — Store current VIC bank state in `IntegratedSession`

In `IntegratedSession`, keep a private field:

```ts
private literalVicBank: number = -1; // unknown until CIA2 reset/store path publishes effective PA
```

Important: verify the reset/default value against actual CIA2 reset
behavior in current TS and VICE. Do not hardcode an assumed visible bank
without checking the effective PA byte after CIA reset.

When `installCia2()` calls `onVicBankChange`, call:

```ts
LIT_VICII.vicii_set_vbank(newVbank);
this.literalVicBank = newVbank;
```

### Step 4 — Remove bank derivation from `tickLitVic()`

Delete this pattern from `tickLitVic()`:

```ts
const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
const bank = (~cia2Pa) & 0x03;
lv.vbank_phi1 = bank * 0x4000;
lv.vbank_phi2 = bank * 0x4000;
```

After this spec, `tickLitVic()` must only run the literal VIC cycle and
framebuffer capture. It must not derive CIA2 state.

### Step 5 — Verify Char ROM overlay remains correct

Keep the current Char ROM overlay model unless a test proves it wrong:

```ts
vicii.vaddr_chargen_mask_phi1 = 0x7000;
vicii.vaddr_chargen_value_phi1 = 0x1000;
vicii.vaddr_chargen_mask_phi2 = 0x7000;
vicii.vaddr_chargen_value_phi2 = 0x1000;
```

This matches Zimmers:

- Char ROM in bank 0 at `$1000-$1fff`
- Char ROM in bank 2 at `$9000-$9fff`
- no Char ROM overlay in banks 1 and 3

### Step 6 — Verify Color RAM path remains separate

Do not move Color RAM into the 16KB bank map.

Keep `mem_color_ram_vicii` as separate 1KB storage indexed by lower 10
bits of the matrix address:

```ts
vicii.cbuf[vicii.vmli] = host.mem_color_ram_vicii[vicii.vc] & 0xf;
```

This matches Zimmers: Color RAM is connected to the upper four data bits
and addressed by the lower 10 VIC address bits, not by CIA2 bank.

## Required tests

### 1. Unit smoke: effective CIA2 PA to VIC bank

Create `scripts/smoke-426-vic-bank-effective-pa.mjs`.

Test cases:

| PRA bits 1..0 | DDRA bits 1..0 | effective PA bits | VICE new_vbank |
|---|---|---|---|
| `11` | `11` | `11` | `0` |
| `10` | `11` | `10` | `1` |
| `01` | `11` | `01` | `2` |
| `00` | `11` | `00` | `3` |
| `00` | `00` | `11` | `0` |
| `00` | `01` | `10` | `1` |
| `00` | `10` | `01` | `2` |

The DDRA=input cases are the important regression: input bits must float
high in the effective output byte.

### 2. Integration smoke: VIC fetches from selected bank

Create `scripts/smoke-426-vic-bank-fetch.mjs`.

Setup:

- Put unique screen/charset or bitmap bytes at each 16KB bank:
  - bank 0 `$0000`
  - bank 1 `$4000`
  - bank 2 `$8000`
  - bank 3 `$c000`
- Program `$D018` to a fixed screen/charset or bitmap location.
- Write CIA2 `$DD02`/`$DD00` to select each bank.
- Run enough cycles for at least one visible fetch.
- Assert the pixel or `vbuf/gbuf` source changes to the expected bank.

### 3. Char ROM overlay smoke

Create `scripts/smoke-426-vic-charrom-overlay.mjs`.

Assert:

- bank 0 local `$1000-$1fff` fetches Char ROM.
- bank 1 local `$1000-$1fff` fetches RAM at `$5000-$5fff`.
- bank 2 local `$1000-$1fff` fetches Char ROM at absolute `$9000-$9fff`.
- bank 3 local `$1000-$1fff` fetches RAM at `$d000-$dfff` equivalent
  VIC address space, not CPU I/O.

### 4. Existing canaries

Run after the focused tests:

- `smoke-404-cycle-table-diff`
- `smoke-404-badline-trace`
- `smoke-404-sprite-dma`
- `smoke-404-raster-irq`
- `smoke-423-motm-canary`
- `smoke-423-krill-loader`
- Last Ninja current boot/render canary, if present

## DO

- Do keep the VIC bank switch in the CIA2/glue path.
- Do keep `tickLitVic()` free of CIA2 bank derivation.
- Do cite VICE `c64cia2.c`, `c64gluelogic.c`, and `vicii.c` in comments.
- Do use Zimmers as the hardware explanation for inverted CIA2 PA bits,
  Char ROM overlay, and Color RAM separation.
- Do test DDRA=input cases explicitly.
- Do keep all 8 VIC modes untouched unless a test proves a mode bug.

## DON'T

- Do not rewrite `vicii-draw-cycle.ts`.
- Do not change ECM/BMM/MCM color tables.
- Do not patch games or loaders.
- Do not change G64/D64/GCR/IEC/VIA logic.
- Do not put Color RAM into the selected 16KB bank.
- Do not use `pra & ddra` for VIC bank selection.
- Do not recompute bank inside `tickLitVic()`.
- Do not introduce another scheduler mode.

## Acceptance

This spec is DONE only when:

1. VIC bank is selected from `(PRA | ~DDRA)`, then inverted with `~byte & 3`.
2. Bank changes are pushed from CIA2 PA/DDRA writes.
3. `tickLitVic()` no longer derives or writes `vbank_phi1/phi2`.
4. Char ROM overlay matches Zimmers banks 0 and 2.
5. Color RAM remains separate from the 16KB VIC bank map.
6. Focused 426 smokes pass.
7. Existing 404/423 canaries stay green.
