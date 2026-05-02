// Spec 020: 1541 drive 6502 platform knowledge. Symbol set sourced from
// the public 1541 ROM annotation at https://g3sl.github.io/c1541rom.html
// (cached locally at tools/data/c1541-rom.json once the scrape lands).
// The seed values below cover the most common labels needed for typical
// fastloader / drive-side disassembly so a 1541 disasm no longer reuses
// the C64 KERNAL / VIC / SID labels by accident.

import type { PlatformKnowledge } from "./c64.js";

export const c1541PlatformKnowledge: PlatformKnowledge = {
  zp: {
    0x00: "drive RAM (variable area)",
    0x01: "drive RAM (variable area)",
    0x18: "current track",
    0x19: "current sector",
  },
  io: {
    0x1800: { name: "VIA1 PRB (serial bus + ATN)" },
    0x1801: { name: "VIA1 PRA" },
    0x1802: { name: "VIA1 DDRB" },
    0x1803: { name: "VIA1 DDRA" },
    0x180c: { name: "VIA1 PCR" },
    0x180d: { name: "VIA1 IFR" },
    0x180e: { name: "VIA1 IER" },
    0x1c00: { name: "VIA2 PRB (LED / motor / write protect)" },
    0x1c01: { name: "VIA2 PRA (data port)" },
    0x1c02: { name: "VIA2 DDRB" },
    0x1c03: { name: "VIA2 DDRA" },
    0x1c0b: { name: "VIA2 ACR (read/write control)" },
    0x1c0c: { name: "VIA2 PCR" },
  },
  rom: {
    0xa47c: "dos_search_header",
    0xa51a: "dos_init_drive",
    0xa7e4: "dos_seek",
    0xa786: "dos_format_track",
    0xc100: "dos_command_listener",
    0xeb22: "dos_send_byte",
    0xfd31: "dos_irq_entry",
    0xff10: "dos_reset_vector_low",
    0xfffa: "NMI vector",
    0xfffc: "RESET vector",
    0xfffe: "IRQ vector",
  },
  ramRangeAnnotations: [
    { start: 0x0100, end: 0x01ff, name: "stack" },
    { start: 0x0200, end: 0x02ff, name: "command channel buffer" },
    { start: 0x0300, end: 0x03ff, name: "buffer #2" },
    { start: 0x0400, end: 0x04ff, name: "buffer #3" },
    { start: 0x0500, end: 0x05ff, name: "buffer #4" },
    { start: 0x0600, end: 0x06ff, name: "buffer #5" },
    { start: 0x0700, end: 0x07ff, name: "buffer #6" },
  ],
};
