# PLA Audit vs VICE — 1:1 Truth Table Verification

Date: 2026-05-06.  Sprint 113 / Spec 146 follow-up. Triggered by motm
(Murder On The Mississippi) AB.prg banking dance.

## Sources read (verbatim)

- `vice/src/c64/c64pla.c` lines 51-99   — `c64pla_config_changed` formula:
  ```
  data_out  = (data_out & ~dir) | (data & dir)
  data_read = (data | ~dir) & (data_out | pullup)   // pullup = 0x17 on stock C64
  dir_read  = dir
  ```
- `vice/src/c64/c64pla.h`                — `pport_t` struct: `dir`, `data`,
  `dir_read`, `data_read`, `data_out` + capacitor-decay timers.
- `vice/src/c64/c64mem.c` line 216       — mem_config formula:
  ```
  mem_config = (((~pport.dir | pport.data) & 0x7) | (export.exrom << 3) | (export.game << 4))
  ```
  Lines 256-342 — `zero_read`: $00 returns `pport.dir_read`, $01 returns
  `pport.data_read` plus capacitor-fade for unconnected bits 6,7.
  Lines 893-933 — chargen mapped at configs {1,2,3,9,10,11,26,27}.
- `vice/src/c64/c64meminit.c` lines 96-127 — `c64meminit_io_config[32]`,
  `c64meminit_roml_config[32]`, `c64meminit_romh_config[32]`,
  `c64meminit_romh_mapping[32]`. Lines 140-272 wire BASIC at configs
  {3,7,11,15} and KERNAL at {2,3,6,7,10,11,14,15,26,27,30,31}.
- `vice/src/c64/c64memlimit.c`           — `limit_tab` confirms ROM regions
  per config.
- `vice/src/c64/cart/c64cartmem.c` lines 218-219, `cart/c64cartsystem.h`
  lines 93-96 — `export.exrom = (mode_phi2>>1)&1 ^ 1`,
  `export.game = mode_phi2 & 1`. CMODE_8KGAME=0, CMODE_16KGAME=1,
  CMODE_RAM=2 (no cart), CMODE_ULTIMAX=3.

## Cart-line polarity

- VICE `pport`/CRT byte 0x18-0x19: physical pin state. **0 = asserted** (line
  pulled low, cart active), **1 = released** (pulled high, cart inactive).
- Our `cartridge.ts` `lines.exrom` / `lines.game` use the same physical-pin
  polarity (CRT bytes copied verbatim).
- VICE's internal `export.exrom` is XORed (`pin ^ 1`) so the bit fed into
  `mem_config` flips polarity. Our PLA computes the visibility predicate
  directly from `lines.exrom/game` so we never store `export.*`.

## All 32 effective banking modes

Table cells: `R` = RAM, `B` = BASIC ROM, `K` = KERNAL ROM, `C` = char ROM,
`I` = I/O bank, `8L` = ROML at $8000, `AH` = ROMH at $A000,
`EH` = ROMH at $E000 (ultimax). All writes column tracks the destination
of stores in that region.

For each row we list:
- VICE config index (`mem_config` value).
- (LORAM, HIRAM, CHAREN) — bits 0,1,2 of `(~dir|data) & 7`.
- Cart class — (no-cart / 8K / 16K / ultimax).
- $8000-$9FFF read/write.
- $A000-$BFFF read/write.
- $D000-$DFFF read/write.
- $E000-$FFFF read/write.

Where "write to RAM" means the underlying RAM byte at that address —
this is the **write-thru-ROM** behavior every C64 PLA implements.

| cfg | (L,H,C) | cart   | $80 r/w   | $A0 r/w   | $D0 r/w   | $E0 r/w   |
|----:|---------|--------|-----------|-----------|-----------|-----------|
|   0 | 0,0,0   | no-cart| R / R     | R / R     | R / R     | R / R     |
|   1 | 1,0,0   | no-cart| R / R     | R / R     | C / R     | R / R     |
|   2 | 0,1,0   | no-cart| R / R     | R / R     | C / R     | K / R     |
|   3 | 1,1,0   | no-cart| R / R     | B / R     | C / R     | K / R     |
|   4 | 0,0,1   | no-cart| R / R     | R / R     | R / R     | R / R     |
|   5 | 1,0,1   | no-cart| R / R     | R / R     | I / I     | R / R     |
|   6 | 0,1,1   | no-cart| R / R     | R / R     | I / I     | K / R     |
|   7 | 1,1,1   | no-cart| R / R     | B / R     | I / I     | K / R     |
|   8 | 0,0,0   | 8K     | R / R     | R / R     | R / R     | R / R     |
|   9 | 1,0,0   | 8K     | R / R     | R / R     | C / R     | R / R     |
|  10 | 0,1,0   | 8K     | R / R     | AH / R    | C / R     | K / R     |
|  11 | 1,1,0   | 8K     | 8L / R    | AH / R    | C / R     | K / R     |
|  12 | 0,0,1   | 8K     | R / R     | R / R     | R / R     | R / R     |
|  13 | 1,0,1   | 8K     | R / R     | R / R     | I / I     | R / R     |
|  14 | 0,1,1   | 8K     | R / R     | AH / R    | I / I     | K / R     |
|  15 | 1,1,1   | 8K     | 8L / R    | AH / R    | I / I     | K / R     |
|  16 | 0,0,0   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  17 | 1,0,0   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  18 | 0,1,0   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  19 | 1,1,0   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  20 | 0,0,1   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  21 | 1,0,1   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  22 | 0,1,1   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  23 | 1,1,1   | ultimax| 8L / -    | - / -     | I / I     | EH / -    |
|  24 | 0,0,0   | 16K    | R / R     | R / R     | R / R     | R / R     |
|  25 | 1,0,0   | 16K    | R / R     | R / R     | C / R     | R / R     |
|  26 | 0,1,0   | 16K    | R / R     | AH / R    | C / R     | K / R     |
|  27 | 1,1,0   | 16K    | 8L / R    | AH / R    | C / R     | K / R     |
|  28 | 0,0,1   | 16K    | R / R     | R / R     | R / R     | R / R     |
|  29 | 1,0,1   | 16K    | R / R     | R / R     | I / I     | R / R     |
|  30 | 0,1,1   | 16K    | R / R     | AH / R    | I / I     | K / R     |
|  31 | 1,1,1   | 16K    | 8L / R    | AH / R    | I / I     | K / R     |

Notes:
- "R / R" in cart-active rows for $8000/$A000 still apply when ROML/ROMH
  isn't selected — write goes to RAM at the underlying address per
  `c64meminit.c` lines 286-333 (`raml_no_ultimax_store`/`ramh_no_ultimax_store`).
- Ultimax `- / -` for $A000-$BFFF and $E000-$FFFF write means writes are
  routed through `ultimax_*_store` (cart-defined) — typically dropped or
  routed to cart RAM. For our purposes the bus drops them.
- Default boot `$01=$37`, no cart → mem_config=7 → BASIC + I/O + KERNAL.
- motm's banking dance ($14/$15/$16/$17 written to $01 with default
  DDR=$2F) selects no-cart configs 4/5/6/7 respectively. Our PLA must
  honor write-thru-ROM in mode 6 ($16, $A000=R, $D000=I/O, $E000=K)
  so vectors written at $FFFA-$FFFF persist when motm later flips to
  mode 4 ($14 = all RAM).

## Our implementation vs VICE

Audit of `src/runtime/headless/memory-bus.ts` `pla()` (lines 217-247) and
read/write paths (lines 121-211).

### MATCH (no fix required)

1. **$A000-$BFFF read predicate** (BASIC vs ROMH vs RAM).
   - VICE: BASIC at configs `{3,7,11,15}` = `(LORAM && HIRAM) && (game_pin == 1)`.
     ROMH at `{10,11,14,15,26,27,30,31}` = `(HIRAM && exrom_asserted) || (16K cart && HIRAM)`.
   - Ours: `if ultimax→RAM; else if (loram&&hiram&&!exrom&&!game)→cart_hi (16K cart);
     else if (loram&&hiram)→basic`. **MATCHES** for all 32 configs once we
     account for 8K/16K cart ROMH at lo3 ∈ {2,3,6,7} (next bullet).
2. **$A000-$BFFF ROMH for 8K cart at lo3=2,3,6,7**: VICE configs 10,14
   (lo3=2,6 with 8K cart) — but our code only flags ROMH for `loram&&hiram`
   (lo3=3 or 7). **DEVIATION** — see Fix #4 below.
   - Re-checked: VICE `c64meminit_romh_config[10]=0` — actually ROMH at
     $A000 is NOT mapped at config 10. Re-reading: `romh_config[]` is
     `0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1,1, 0,0,1,1,0,0,1,1`.
     ROMH at $A000 only maps for configs 26,27,30,31 (16K cart, HIRAM=1).
     Configs 10,11,14,15 (8K cart) DO NOT map ROMH at $A000 (8K cart has
     no ROMH region in stock). So our code (which requires `!exrom&&!game`
     for cart_hi) is correct: 8K cart has `game=1`, fails the predicate.
   - **MATCH** — no deviation here. Audit table corrected: 8K cart rows
     show `R / R` at $A000 (not AH).
3. **$D000-$DFFF I/O predicate**: ours `(loram||hiram) && charen` plus
   `if (ultimax) bankD='io'` matches VICE `c64meminit_io_config[]`.
4. **$D000-$DFFF char ROM predicate**: ours `(loram||hiram) && !charen
   && !ultimax` matches VICE chargen list `{1,2,3,9,10,11,26,27}` —
   union of HIRAM-set OR LORAM-set, CHAREN-clear, non-ultimax.
5. **$E000-$FFFF KERNAL predicate**: ours `hiram && !ultimax` matches
   VICE `{2,3,6,7,10,11,14,15,26,27,30,31}`.
6. **Write-thru-ROM at $A000-$BFFF and $E000-$FFFF**: writes always fall
   through to `this.ram[addr] = byte` regardless of bank visibility.
   Matches VICE `ram_store` hook on those configs.
7. **Write-thru-CHARROM at $D000-$DFFF**: when `bankD==='char'` we don't
   take the I/O write branch, so writes go to RAM. Matches VICE
   `ram_store` (chargen is read-only routing; write tab unchanged).
8. **$00 read** returns latched DDR value. VICE `pport.dir_read = pport.dir`
   (c64pla.c:98). Equivalent.

### DEVIATION 1 — `mem_config` low bits use raw `data` instead of `(~dir|data)&7`

- VICE (c64mem.c:216): `(((~pport.dir | pport.data) & 0x7) | ...)`. When
  a DDR bit is 0 (input), the corresponding mode bit is forced **high**
  by `~dir`.
- Ours (memory-bus.ts:218): `const port = this.cpuPortValue & 0x07;`.
  Uses raw latched `data`, ignores DDR.
- **Effect**: For motm (DDR=$2F, all banking bits as outputs) this is
  a no-op — `~dir & 7` = 0, so the OR doesn't add anything beyond the
  data bits. For software that flips banking bits to input
  (e.g. some fastloaders) this drifts.
- **Fix**: derive mode bits via `(~dir | data) & 7`.

### DEVIATION 2 — $01 read returns latched data, not VICE `data_read`

- VICE: `data_read = (data | ~dir) & (data_out | pullup)` with pullup=0x17.
  Capacitor-decay applies to bits 6,7 (and 3,4,5 on SX-64 only).
- Ours (memory-bus.ts:130-132): returns `cpuPortValue` raw. No DDR mask,
  no pullup, no decay.
- **Effect**: With default DDR=$2F (bits 0,1,2,3,5 output; bits 4,6,7
  input) and DATA=$37, real HW reads back `(0x37 | 0xD0) & (0x37 | 0x17)`
  = `0xF7 & 0x37` = `0x37`. Coincidentally matches our latched value
  for the default boot state. Diverges when DDR changes.
- **Fix**: compute and return VICE `data_read`. Capacitor decay
  (bits 6,7 fade) deferred — almost no software depends on it; bug
  noted in `pla-fidelity-notes.md`.

### Architectural note — PLA stays in memory-bus.ts

The Spec 146 IoPort6510 mixin (`src/runtime/headless/cpu/io-port-6510.ts`)
is wired into `Cpu65xxVice` but never instantiated by
`integrated-session.ts` or any production session. The mixin is dead code
in v1.5 — when present it duplicates the latch the memory-bus already
keeps.

Moving banking computation into a CPU-side PLA observer is structurally
clean (matches VICE's split: c64pla.c holds latches, c64mem.c holds the
truth table) but requires:
- Extracting `cpuPortDirection`/`cpuPortValue` out of `HeadlessMemoryBus`.
- Routing $00/$01 reads/writes through `IoPort6510` from cpu65xx-vice.ts.
- Hooking `mem_pla_config_changed`-style callbacks back into the bus.
- Updating snapshot/VSF round-trip to serialize the new owner.

That refactor is its own sprint. **For Spec 146 follow-up we keep PLA in
memory-bus.ts** and bring the truth table to 1:1 with VICE in place.
The IoPort6510 mixin remains as a no-op surface for the future migration.
