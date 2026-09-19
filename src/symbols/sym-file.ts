// Spec 804 — the build layer's input: assembler symbol files, read as they come.
//
// Measured 2026-09-19 (the old 804 §1 measured the same):
//   KickAssembler -vicesymbols   → `al C:814 .print_string`   (VICE label file, memspace C:)
//   KickAssembler (always)       → `.label print_string=$814`  (its own .sym)
//   64tass --vice-labels -l x.vs → `al 814 .print_string`      (no memspace)
// The VICE memspace prefix is KEPT, not thrown away: `C:` is the computer, `8:` drive 8.
// Other drives (9:, 10:, 11:) have no runtime space here and are skipped.

import type { RuntimeSpace } from "./types.js";

export interface SymbolLine {
  name: string;
  address: number;
  space: RuntimeSpace;
}

function hex(s: string): number | undefined {
  const t = s.trim().replace(/^\$/u, "").replace(/^0x/iu, "");
  if (!/^[0-9a-f]{1,4}$/iu.test(t)) return undefined;
  return parseInt(t, 16);
}

const NAME = /^[A-Za-z_.@][A-Za-z0-9_.@]*$/u;

export function parseSymbolLine(raw: string): SymbolLine | undefined {
  const line = raw.trim();
  if (!line || line.startsWith(";") || line.startsWith("#")) return undefined;
  // VICE: `al [X:]addr .name`
  const al = line.match(/^al\s+(?:([0-9A-Za-z]{1,2}):)?([0-9A-Fa-f$x]+)\s+\.?(\S+)\s*$/u);
  if (al) {
    const mem = (al[1] ?? "C").toUpperCase();
    const space: RuntimeSpace | undefined = mem === "C" ? "c64" : mem === "8" ? "drive8" : undefined;
    const address = hex(al[2]!);
    const name = al[3]!;
    if (!space || address === undefined || !NAME.test(name)) return undefined;
    return { name, address, space };
  }
  // KickAssembler .sym: `.label name=$addr` (also `.const` equates; both name an address)
  const kick = line.match(/^\.(?:label|const)\s+([^=\s]+)\s*=\s*(\S+)\s*$/u);
  if (kick) {
    const address = hex(kick[2]!);
    if (address === undefined || !NAME.test(kick[1]!)) return undefined;
    return { name: kick[1]!, address, space: "c64" };
  }
  // plain `name = $addr`
  const plain = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(\$?[0-9A-Fa-f]{1,4})\s*$/u);
  if (plain) {
    const address = hex(plain[2]!);
    if (address === undefined) return undefined;
    return { name: plain[1]!, address, space: "c64" };
  }
  return undefined;
}

export function parseSymbolFile(text: string): SymbolLine[] {
  const out: SymbolLine[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const s = parseSymbolLine(line);
    if (s) out.push(s);
  }
  return out;
}
