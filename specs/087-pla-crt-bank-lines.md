# Spec 087 — PLA truth-table + CRT runtime bank mapping

## Problem

Current memory bus uses if-cascade for $01 LORAM/HIRAM/CHAREN bank decisions, ignores cartridge EXROM/GAME pin states, has no proper PLA model. CRT cartridges are extracted (Spec for extract_crt) but not RUNTIME-mapped — the headless can't actually execute a cartridge image.

For "100% C64 VM" we need the real PLA (906114-01) truth table: 5 inputs (LORAM, HIRAM, CHAREN, EXROM, GAME) → 8 outputs (which chip drives each 4K bank slot).

## Decision

Implement the full 32-entry PLA truth table as a const lookup. Memory bus consults PLA on every access via current $01 + cartridge pin state. CRT cartridge runtime adds top-5 cart types (Type 0 normal, Action Replay, Final Cartridge III, Ocean, Magic Desk, Easy Flash). Other types → REQUIREMENTS.md backlog.

## Scope

### PLA model

```ts
// 5 inputs: LORAM, HIRAM, CHAREN, /EXROM, /GAME
// Outputs per 4K bank: which chip is active
type PlaConfig = {
  bank8: 'ram' | 'cartLow' | 'basic';     // $8000-$9FFF
  bankA: 'ram' | 'cartHi' | 'basic';      // $A000-$BFFF
  bankD: 'ram' | 'io' | 'charrom';        // $D000-$DFFF
  bankE: 'ram' | 'kernal' | 'cartHi';     // $E000-$FFFF
};

// 32-entry truth table indexed by (LORAM<<4 | HIRAM<<3 | CHAREN<<2 | EXROM<<1 | GAME)
const PLA_TABLE: PlaConfig[] = [/* 32 entries from VICE c64memlimit.c */];
```

Source: VICE `src/c64/c64mem.c` mem_pla_config_changed() — has authoritative truth table.

### Bus integration

`HeadlessMemoryBus` has `read(addr)`, `write(addr, value)`. Currently uses `mode` bits from $01.

Refactor:
```ts
class HeadlessMemoryBus {
  private exromPin = true;  // 1 = released (no cart) / 0 = asserted
  private gamePin = true;
  private currentPla: PlaConfig;

  setCartridgePins(exrom: boolean, game: boolean): void {
    this.exromPin = exrom; this.gamePin = game;
    this.recomputePla();
  }

  private recomputePla(): void {
    const c01 = this.ram[0x01];
    const idx = ((c01 & 0x07) << 2) | (this.exromPin?2:0) | (this.gamePin?1:0);
    this.currentPla = PLA_TABLE[idx];
  }

  read(addr: number): number {
    if (addr < 0xA000) return this.ram[addr]; // always RAM up to $9FFF (or cart low if cart)
    if (addr < 0xC000) {
      // $A000-$BFFF
      switch (this.currentPla.bankA) {
        case 'ram': return this.ram[addr];
        case 'basic': return this.basicRom[addr - 0xA000];
        case 'cartHi': return this.cart!.romHi[addr - 0xA000];
      }
    }
    // ... etc.
  }
}
```

### CRT cartridge runtime

`src/runtime/headless/cartridge.ts` — already exists for extract; extend for runtime:

```ts
export interface CartRuntime {
  type: number;                    // CRT type (0=normal, 1=Action Replay, ...)
  exromPin: boolean;
  gamePin: boolean;
  romLo: Uint8Array;               // $8000-$9FFF chunk
  romHi: Uint8Array;               // $A000-$BFFF or $E000-$FFFF chunk

  read(addr: number): number;      // type-specific read
  write(addr: number, val: number): void;  // type-specific (banking writes)
  reset(): void;
}
```

### Cart types implemented (user-prioritised, May 2026)

User confirmed wichtigste types — nur diese, Rest → R31 backlog:

1. **Type 0 — Normal cartridge** (8K, 16K, Ultimax 16K).
   - 8K: EXROM=0 GAME=1, ROM at $8000-$9FFF.
   - 16K: EXROM=0 GAME=0, ROM at $8000-$BFFF.
   - Ultimax: EXROM=1 GAME=0, ROM at $8000-$9FFF + $E000-$FFFF.

2. **Type 5 — Ocean** (32K-512K, banking via $DE00).
   - Write $DE00 → bank select (0..N). Each bank 16K mapped at $8000-$BFFF.

3. **Type 19 — Magic Desk** (32K-128K).
   - Write $DE00 bank select, bit 7 = disable cart.

4. **Type 32 — Easy Flash** (1MB Flash).
   - Write $DE00 bank lo, $DE02 EXROM/GAME control. 64 banks × 16K.
   - Optional: EAPI runtime helpers in cart RAM at $DF00 for flash erase/write.

5. **Type 60 — GMOD2** (512K Flash + 2KB EEPROM serial).
   - Write $DE00 bank select bits 0-5 + bit 6 (flash visible) + bit 7 (EEPROM CLK).
   - $DE00 also reads EEPROM SDA bit.

6. **Type 70 — GMOD3** (16MB Flash, banking via $DE00 + $DE02).
   - Larger than GMOD2; same EAPI-style flash layout. Refer to VICE
     `src/c64/cart/gmod3.c` for exact register layout.

7. **GMOD4** (when finalised by Individual Computers).
   - Stub now, finalise when CRT type ID stabilises.

8. **Protovision Megabyter** (cartridge type — confirm CRT type ID
   during impl. Likely uses simple bank-switching via $DE00.)

9. **C64MegaCart** (multi-game cart, simple bank switching via $DE00).

For each: cart-type handler file in `src/runtime/headless/cartridges/<type>.ts`
implementing the `CartRuntime` interface from this spec.

### Wire-up

`integrated-session.ts`:
- Optional `cartridgePath` in IntegratedSessionOptions.
- If set, parse CRT, instantiate CartRuntime, attach to bus via `bus.setCartridge(cart)` + `bus.setCartridgePins(cart.exromPin, cart.gamePin)`.
- Per write to $DE00-$DFFF: route to cart.write() (which may update pins → bus.recomputePla()).

### MCP tool extension

- `headless_session_start` accepts `cartridgePath`.
- New tool `headless_cartridge_status` reports current cart type + bank state.

## Out of scope (REQUIREMENTS.md R31 backlog)

- Action Replay, Final Cartridge III, Super Snapshot V5, Stardos, KCS,
  Westermann, RamCart, IDE64, GeoRAM, REU, RetroReplay, Atomic Power, etc.
  (~40 types). Add per demand.
- Cart RAM beyond ROM (some carts have onboard RAM).
- Freeze button input mechanism.
- Cart-driven NMI (carts that trigger NMI via $DE00 writes).
- EEPROM serial protocol full simulation (GMOD2 SDA/CLK timing-accurate).

## Acceptance

- Boot a CRT (e.g. Tape Replay or Action Replay disk) in headless → cart code executes.
- $01 RMW pattern works correctly: write 35→34→35 → CHAREN flip swaps charrom and I/O.
- Smoke test: load a 16K cart (e.g. Forbidden Forest .crt), reset CPU → CPU starts at cart's $8000 reset vector, runs game.
- VICE diff: PLA decisions match VICE for randomly-sampled $01 values + cart states.
