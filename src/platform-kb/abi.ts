// Spec 826 D4 — the KERNAL / BASIC calling conventions, as rows of the ONE
// platform store (817 D1: a hand table lives here and nowhere else; this file
// is the second sanctioned one next to extensions.ts, and check:platform-kb
// allows it by name).
//
// One row per (address, location, role). Locations use 826 D1's names —
// `A` `X` `Y` `C` `Z` … and `zp:$XX` — and roles are `in` (read before written:
// a parameter), `out` (written for the caller: a result), `clobbers` (written,
// meaningless afterwards), `preserves` (saved and restored). The values follow
// the Commodore 64 Programmer's Reference Guide "Registers affected" lines and
// c64ref's Input/Output prose; where the two disagree the gate freezes what is
// written here (826 OQ3).
//
// The signature producer (826 D2) reads these through `PlatformKb.abi()` as the
// summary of a `jsr $FFD2`: CHROUT consumes A and clobbers nothing.

import type { PlatformAbiRow, PlatformTag } from "./schema.js";

export const ABI_SOURCE = "c64re-extension";

type Role = PlatformAbiRow["role"];

interface AbiEntry {
  address: number;
  name: string;
  in?: string[];
  out?: string[];
  clobbers?: string[];
  preserves?: string[];
  note?: string;
}

// The KERNAL jump table $FF81–$FFF3 (+ READST/SETTMO/SCNKEY/UDTIM entries).
const C64_KERNAL: AbiEntry[] = [
  { address: 0xff81, name: "CINT", clobbers: ["A", "X", "Y"], note: "initialise screen editor and VIC" },
  { address: 0xff84, name: "IOINIT", clobbers: ["A", "X", "Y"], note: "initialise CIA, SID, IRQ timer" },
  { address: 0xff87, name: "RAMTAS", clobbers: ["A", "X", "Y"], note: "RAM test, set memory pointers" },
  { address: 0xff8a, name: "RESTOR", clobbers: ["A", "X", "Y"], note: "restore the I/O vectors" },
  { address: 0xff8d, name: "VECTOR", in: ["C", "X", "Y"], out: ["X", "Y"], clobbers: ["A", "Y"], note: "C=1 read vectors to (X,Y); C=0 set from (X,Y)" },
  { address: 0xff90, name: "SETMSG", in: ["A"], clobbers: ["A"], note: "A = message control bits" },
  { address: 0xff93, name: "SECOND", in: ["A"], clobbers: ["A"], note: "A = secondary address after LISTEN" },
  { address: 0xff96, name: "TKSA", in: ["A"], clobbers: ["A"], note: "A = secondary address after TALK" },
  { address: 0xff99, name: "MEMTOP", in: ["C", "X", "Y"], out: ["X", "Y"], clobbers: ["X", "Y"], note: "C=1 read top of RAM into (X,Y); C=0 set" },
  { address: 0xff9c, name: "MEMBOT", in: ["C", "X", "Y"], out: ["X", "Y"], clobbers: ["X", "Y"], note: "C=1 read bottom of RAM into (X,Y); C=0 set" },
  { address: 0xff9f, name: "SCNKEY", clobbers: ["A", "X", "Y"], note: "scan the keyboard" },
  { address: 0xffa2, name: "SETTMO", in: ["A"], note: "A = IEEE timeout flag" },
  { address: 0xffa5, name: "ACPTR", out: ["A"], clobbers: ["A", "X"], note: "A = byte from the serial bus" },
  { address: 0xffa8, name: "CIOUT", in: ["A"], note: "A = byte to the serial bus" },
  { address: 0xffab, name: "UNTLK", clobbers: ["A"], note: "send UNTALK" },
  { address: 0xffae, name: "UNLSN", clobbers: ["A"], note: "send UNLISTEN" },
  { address: 0xffb1, name: "LISTEN", in: ["A"], clobbers: ["A"], note: "A = device number" },
  { address: 0xffb4, name: "TALK", in: ["A"], clobbers: ["A"], note: "A = device number" },
  { address: 0xffb7, name: "READST", out: ["A"], clobbers: ["A"], note: "A = I/O status word" },
  { address: 0xffba, name: "SETLFS", in: ["A", "X", "Y"], note: "A = logical file, X = device, Y = secondary address" },
  { address: 0xffbd, name: "SETNAM", in: ["A", "X", "Y"], note: "A = name length, (X,Y) = name address" },
  { address: 0xffc0, name: "OPEN", out: ["C", "A"], clobbers: ["A", "X", "Y"], note: "C=1 error, A = error code; uses SETLFS/SETNAM state" },
  { address: 0xffc3, name: "CLOSE", in: ["A"], out: ["C", "A"], clobbers: ["A", "X", "Y"], note: "A = logical file" },
  { address: 0xffc6, name: "CHKIN", in: ["X"], out: ["C", "A"], clobbers: ["A", "X"], note: "X = logical file to read from" },
  { address: 0xffc9, name: "CHKOUT", in: ["X"], out: ["C", "A"], clobbers: ["A", "X"], note: "X = logical file to write to" },
  { address: 0xffcc, name: "CLRCHN", clobbers: ["A", "X"], note: "restore default channels" },
  { address: 0xffcf, name: "CHRIN", out: ["A", "C"], clobbers: ["A", "X"], note: "A = character from the input channel" },
  { address: 0xffd2, name: "CHROUT", in: ["A"], note: "A = character to the output channel; registers preserved" },
  { address: 0xffd5, name: "LOAD", in: ["A", "X", "Y"], out: ["C", "A", "X", "Y"], clobbers: ["A", "X", "Y"], note: "A = 0 load / 1 verify; (X,Y) = address when secondary = 0; (X,Y) = end address on return; C=1 error, A = code" },
  { address: 0xffd8, name: "SAVE", in: ["A", "X", "Y"], out: ["C", "A"], clobbers: ["A", "X", "Y"], note: "A = zero-page address of the start pointer; (X,Y) = end address + 1" },
  { address: 0xffdb, name: "SETTIM", in: ["A", "X", "Y"], note: "(A,X,Y) = jiffy clock, most significant first" },
  { address: 0xffde, name: "RDTIM", out: ["A", "X", "Y"], clobbers: ["A", "X", "Y"], note: "(A,X,Y) = jiffy clock" },
  { address: 0xffe1, name: "STOP", out: ["Z", "A"], clobbers: ["A", "X"], note: "Z=1 when STOP is pressed" },
  { address: 0xffe4, name: "GETIN", out: ["A", "C"], clobbers: ["A", "X", "Y"], note: "A = character from the keyboard queue (0 = none)" },
  { address: 0xffe7, name: "CLALL", clobbers: ["A", "X"], note: "close every file, restore channels" },
  { address: 0xffea, name: "UDTIM", clobbers: ["A", "X"], note: "advance the jiffy clock" },
  { address: 0xffed, name: "SCREEN", out: ["X", "Y"], clobbers: ["X", "Y"], note: "X = columns, Y = rows" },
  { address: 0xfff0, name: "PLOT", in: ["C", "X", "Y"], out: ["X", "Y"], clobbers: ["A", "X", "Y"], note: "C=1 read cursor into (X=row, Y=column); C=0 set" },
  { address: 0xfff3, name: "IOBASE", out: ["X", "Y"], clobbers: ["X", "Y"], note: "(X,Y) = base of the I/O block" },
];

// BASIC ROM entries the corpus calls directly. Kept short on purpose: the ROM
// under which game code usually lives is banked out (826.0 T1), so these are
// the few real ones.
const C64_BASIC: AbiEntry[] = [
  { address: 0xab1e, name: "STROUT", in: ["A", "Y"], clobbers: ["A", "X", "Y"], note: "print the zero-terminated string at (A=lo, Y=hi)" },
  { address: 0xbdcd, name: "LINPRT", in: ["A", "X"], clobbers: ["A", "X", "Y"], note: "print the 16-bit integer (A=hi, X=lo) in decimal" },
  { address: 0xb391, name: "GIVAYF", in: ["A", "Y"], clobbers: ["A", "X", "Y"], note: "signed 16-bit (A=hi, Y=lo) → FAC1" },
  { address: 0xb7f7, name: "GETADR", out: ["A", "Y"], clobbers: ["A", "X", "Y"], note: "FAC1 → unsigned 16-bit in (Y=lo, A=hi) and $14/$15" },
  { address: 0xe544, name: "CLRSCR", clobbers: ["A", "X", "Y"], note: "clear the screen (KERNAL, not on the jump table)" },
];

export function loadAbi(): PlatformAbiRow[] {
  const rows: PlatformAbiRow[] = [];
  const platform: PlatformTag = "c64";
  const push = (e: AbiEntry, role: Role, locations: string[] | undefined) => {
    for (const location of locations ?? []) rows.push({ platform, address: e.address, location, role, note: e.note ?? null, source: ABI_SOURCE });
  };
  for (const e of [...C64_KERNAL, ...C64_BASIC]) {
    push(e, "in", e.in);
    push(e, "out", e.out);
    push(e, "clobbers", e.clobbers);
    push(e, "preserves", e.preserves);
  }
  const roleOrder: Record<Role, number> = { in: 0, out: 1, clobbers: 2, preserves: 3 };
  return rows.sort((a, b) => a.address - b.address || roleOrder[a.role] - roleOrder[b.role] || a.location.localeCompare(b.location));
}

/** The names the table knows, for the gate: address → name. */
export function abiNames(): Map<number, string> {
  return new Map([...C64_KERNAL, ...C64_BASIC].map((e) => [e.address, e.name]));
}
