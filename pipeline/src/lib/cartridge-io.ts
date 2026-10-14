// What the cartridge I/O window ($DE00-$DFFF) means depends on the CARTRIDGE, not on the C64.
//
// The platform knowledge store names $DE00 for the one cartridge it has rows for (EasyFlash:
// EF_BANK at $DE00, EF_CTRL at $DE02), and every listing used to print that name for every store to
// $DE00 whatever was plugged in. A GMod2 listing said "EasyFlash bank register"; a Magic Desk one said
// the same. The register is a property of the hardware type, so the listing asks for it by the CRT
// header's hardware type (the id a .crt carries at offset $16, VICE `cartridge.h`).
//
// The rule, in one place:
//   - the type has its own row here for the address        -> that row's text;
//   - the type is EasyFlash (32)                            -> the store's EF_ rows, as before;
//   - anything else (another type, or no type known) where the store would say EF_  -> the neutral
//     "cartridge I/O $DE00", which claims nothing about the hardware.
// The bit meanings are the ones the VICE mapper code decodes (`gmod2.c` io1_store / io1_read,
// `magicdesk.c`, `ocean.c`, `megabyter.c`).

import { hex16 } from "./format";

const EASYFLASH = 32;

const hexAddr = (address: number): string => `$${hex16(address).toUpperCase()}`;

/** The register text for `address` under a hardware type, or undefined when the type documents nothing there. */
function registerText(hardwareType: number, address: number): string | undefined {
  const inIo1 = address >= 0xde00 && address <= 0xdeff;
  switch (hardwareType) {
    case 60: // GMod2: one register answers the whole IO1 page
      return inIo1
        ? "GMod2 control register: bits 0-5 ROM bank, bit 4 EEPROM DI, bit 5 EEPROM CLK, bit 6 EEPROM CS, bit 7 flash write enable; read: bit 7 = EEPROM DO"
        : undefined;
    case 19: // Magic Desk
      return inIo1 ? "Magic Desk bank register: bits 0-6 ROM bank, bit 7 = cartridge off" : undefined;
    case 5: // Ocean
      return inIo1 ? "Ocean bank register: bits 0-5 ROM bank" : undefined;
    case 86: // Protovision MegaByter: A1 clear = bank, A1 set = mode
      if (!inIo1) return undefined;
      return (address & 2) === 0
        ? "MegaByter bank register: bits 0-6 ROM bank"
        : "MegaByter mode register: bit 7 LED, bit 1 EXROM, bit 0 GAME";
    default:
      return undefined;
  }
}

/**
 * The comment to print for a store/load at `address` in the cartridge I/O window, instead of what the
 * platform store says — or undefined to leave the store's answer alone.
 *
 * @param storeSymbol the symbol the platform store has for the address (null when it has none)
 */
export function cartridgeIoComment(address: number, hardwareType: number | undefined, storeSymbol: string | null): string | undefined {
  if (address < 0xde00 || address > 0xdfff) return undefined;
  if (hardwareType === EASYFLASH) return undefined;
  if (hardwareType !== undefined) {
    const own = registerText(hardwareType, address);
    if (own) return own;
  }
  // the store's only rows in this window are EasyFlash's, and this is not (known to be) an EasyFlash
  if (storeSymbol !== null && storeSymbol.startsWith("EF_")) return `cartridge I/O ${hexAddr(address)}`;
  return undefined;
}
