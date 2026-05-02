// Spec 048: pipeline-side mirror of src/platform-knowledge/c1541.ts.
// Kept here because the pipeline is CommonJS while src/ is ESM.
// Edits must be mirrored manually until the
// `npm run sync:platform-tables` script lands.
//
// Symbol source: https://g3sl.github.io/c1541rom.html (cached at
// tools/data/c1541-rom.json). The full ROM symbol table is loaded
// + merged at module load time so renderer lookups are O(1).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const c1541ZpComments: Record<number, string> = {
  0x18: "current track",
  0x19: "current sector",
};

export const c1541IoComments: Record<number, string> = {
  0x1800: "VIA1 PRB (serial bus + ATN)",
  0x1801: "VIA1 PRA",
  0x1802: "VIA1 DDRB",
  0x1803: "VIA1 DDRA",
  0x180c: "VIA1 PCR",
  0x180d: "VIA1 IFR",
  0x180e: "VIA1 IER",
  0x1c00: "VIA2 PRB (LED / motor / write protect)",
  0x1c01: "VIA2 PRA (data port)",
  0x1c02: "VIA2 DDRB",
  0x1c03: "VIA2 DDRA",
  0x1c0b: "VIA2 ACR (read/write control)",
  0x1c0c: "VIA2 PCR",
};

// Seed ROM symbols (kept inline so the table works even if the
// JSON cache is missing). Augmented by the cache loader below.
const SEED_ROM: Record<number, string> = {
  0xa47c: "dos_search_header",
  0xa51a: "dos_init_drive",
  0xa7e4: "dos_seek",
  0xa786: "dos_format_track",
  0xc100: "dos_command_listener",
  0xeb22: "dos_send_byte",
  0xfd31: "dos_irq_entry",
};

function loadCachedRomSymbols(): Record<number, string> {
  const candidates = [
    resolve(__dirname, "../../../tools/data/c1541-rom.json"),
    resolve(__dirname, "../../../../tools/data/c1541-rom.json"),
    resolve(process.cwd(), "tools/data/c1541-rom.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { symbols?: Record<string, string> };
      const out: Record<number, string> = {};
      for (const [hex, name] of Object.entries(raw.symbols ?? {})) {
        const addr = parseInt(hex, 16);
        if (!Number.isNaN(addr)) out[addr] = name;
      }
      return out;
    } catch {
      continue;
    }
  }
  return {};
}

export const c1541RomComments: Record<number, string> = {
  ...SEED_ROM,
  ...loadCachedRomSymbols(),
};
