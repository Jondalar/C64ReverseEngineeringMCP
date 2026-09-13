// Spec 817 D1 — the ONE table the seeder owns.
//
// c64ref is the producer for everything it covers (ZP, RAM map, I/O, BASIC and
// KERNAL ROM). What it does not cover is listed HERE and nowhere else:
//
//   - cartridge I/O in the $DE00 page (EasyFlash registers) — a C64 fact c64ref
//     has no source for;
//   - the 1541 drive: its zero page, VIA registers and DOS ROM symbols. The ROM
//     symbols come from g3sl.github.io/c1541rom.html, cached at
//     tools/data/c1541-rom.json — that cache is the source, this file only
//     names where it is.
//
// Adding an address→name pair anywhere else in the repo fails
// `npm run check:platform-kb`. Adding it here is the sanctioned way, and the
// seeder folds it into the same store with source = "c64re-extension".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformTag } from "./schema.js";

export interface ExtensionEntry {
  platform: PlatformTag;
  address: number;
  symbol?: string;
  name: string;
  description?: string;
}

export const EXTENSION_SOURCE = "c64re-extension";

const C64_CARTRIDGE_IO: ExtensionEntry[] = [
  { platform: "c64", address: 0xde00, symbol: "EF_BANK", name: "EasyFlash bank register",
    description: "Write-only. Selects the 8 KiB bank presented at ROML ($8000) and ROMH ($A000/$E000). Reading it does not return the bank." },
  { platform: "c64", address: 0xde02, symbol: "EF_CTRL", name: "EasyFlash control register (LED, GAME/EXROM mode)",
    description: "Write-only. Bit 7 = LED, bit 2 = GAME, bit 1 = EXROM, bit 0 = /GAME direction. The GAME/EXROM pair chooses the cartridge mode, and Ultimax is the one that changes WRITE behaviour across the address space (see $0001)." },
];

// The banking behaviour that is not an address but is asked about as one.
//
// c64ref names $00/$01 and stops there: the whole store holds 8188 symbols and not one
// description, because it was built as a name index. What an agent actually asks — "does
// STA $E123 reach RAM while KERNAL is banked in" — had no answer anywhere, and issue #21
// is what a session does without one: it guessed, guessed wrong, guessed wrong a second
// time in the correction, and wrote the wrong answer into three doctrine files.
//
// The text below is not doctrine. It is what `trx64-core/src/full.rs::write` does, read
// off the implementation, which is itself a 1:1 port of VICE's c64meminit/c64mem.
const C64_BANKING: ExtensionEntry[] = [
  { platform: "c64", address: 0x0000, symbol: "D6510", name: "6510 on-chip I/O data direction register",
    description: "Bits 0-2 must be outputs (set to 1) for LORAM/HIRAM/CHAREN in $01 to drive the PLA. $2F is the normal value." },
  { platform: "c64", address: 0x0001, symbol: "R6510", name: "6510 on-chip I/O port — LORAM/HIRAM/CHAREN + datasette",
    description: [
      "Bit 0 LORAM, bit 1 HIRAM, bit 2 CHAREN select what is READ at $A000-$BFFF, $D000-$DFFF and $E000-$FFFF.",
      "WRITES are not gated by any of them: STA into $A000-$BFFF or $E000-$FFFF always reaches the RAM underneath,",
      "whatever $01 holds. Never guard a write on account of $01.",
      "One exception, and it is genuine: $D000-$DFFF with CHAREN=1 is I/O, and a write there goes to the VIC/SID/CIA",
      "register or colour RAM, not to RAM. With CHAREN=0 the char ROM is a read-only mux and writes fall through to RAM.",
      "A cartridge is a separate mechanism: in 8K/16K modes writes to $8000-$BFFF still reach RAM (the cart may also",
      "consume them — EasyFlash latches a flash command cycle). In ULTIMAX mode most of the map has no RAM wired at all",
      "and writes above $0FFF are dropped on the floor.",
      "Source: trx64-core full.rs::write, a 1:1 port of VICE; confirmed against the C64 memory-map tables.",
    ].join(" ") },
];

const C1541_ZP: ExtensionEntry[] = [
  { platform: "c1541", address: 0x18, name: "current track" },
  { platform: "c1541", address: 0x19, name: "current sector" },
];

const C1541_IO: ExtensionEntry[] = [
  { platform: "c1541", address: 0x1800, symbol: "VIA1_PRB", name: "VIA1 PRB (serial bus + ATN)" },
  { platform: "c1541", address: 0x1801, symbol: "VIA1_PRA", name: "VIA1 PRA" },
  { platform: "c1541", address: 0x1802, symbol: "VIA1_DDRB", name: "VIA1 DDRB" },
  { platform: "c1541", address: 0x1803, symbol: "VIA1_DDRA", name: "VIA1 DDRA" },
  { platform: "c1541", address: 0x180c, symbol: "VIA1_PCR", name: "VIA1 PCR" },
  { platform: "c1541", address: 0x180d, symbol: "VIA1_IFR", name: "VIA1 IFR" },
  { platform: "c1541", address: 0x180e, symbol: "VIA1_IER", name: "VIA1 IER" },
  { platform: "c1541", address: 0x1c00, symbol: "VIA2_PRB", name: "VIA2 PRB (LED / motor / write protect)" },
  { platform: "c1541", address: 0x1c01, symbol: "VIA2_PRA", name: "VIA2 PRA (data port)" },
  { platform: "c1541", address: 0x1c02, symbol: "VIA2_DDRB", name: "VIA2 DDRB" },
  { platform: "c1541", address: 0x1c03, symbol: "VIA2_DDRA", name: "VIA2 DDRA" },
  { platform: "c1541", address: 0x1c0b, symbol: "VIA2_ACR", name: "VIA2 ACR (read/write control)" },
  { platform: "c1541", address: 0x1c0c, symbol: "VIA2_PCR", name: "VIA2 PCR" },
];

// Seed symbols that predate the cache; the cache overrides them by address.
const C1541_ROM_SEED: ExtensionEntry[] = [
  { platform: "c1541", address: 0xa47c, symbol: "dos_search_header", name: "dos_search_header" },
  { platform: "c1541", address: 0xa51a, symbol: "dos_init_drive", name: "dos_init_drive" },
  { platform: "c1541", address: 0xa7e4, symbol: "dos_seek", name: "dos_seek" },
  { platform: "c1541", address: 0xa786, symbol: "dos_format_track", name: "dos_format_track" },
  { platform: "c1541", address: 0xc100, symbol: "dos_command_listener", name: "dos_command_listener" },
  { platform: "c1541", address: 0xeb22, symbol: "dos_send_byte", name: "dos_send_byte" },
  { platform: "c1541", address: 0xfd31, symbol: "dos_irq_entry", name: "dos_irq_entry" },
];

function loadC1541RomCache(repoRoot: string): ExtensionEntry[] {
  const path = join(repoRoot, "tools", "data", "c1541-rom.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { symbols?: Record<string, string> };
  const out: ExtensionEntry[] = [];
  for (const [hex, name] of Object.entries(raw.symbols ?? {})) {
    const address = parseInt(hex, 16);
    if (Number.isNaN(address)) continue;
    out.push({ platform: "c1541", address, symbol: name, name });
  }
  return out;
}

/** Later entries win on (platform, address) — the cache overrides the seed. */
export function loadExtensions(repoRoot: string): ExtensionEntry[] {
  const ordered = [...C64_BANKING, ...C64_CARTRIDGE_IO, ...C1541_ZP, ...C1541_IO, ...C1541_ROM_SEED, ...loadC1541RomCache(repoRoot)];
  const byKey = new Map<string, ExtensionEntry>();
  for (const entry of ordered) byKey.set(`${entry.platform}:${entry.address}`, entry);
  return [...byKey.values()].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : a.address - b.address));
}
