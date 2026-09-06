// Spec 824.2 — address → source line for a rendered disassembly.
//
// The renderer (pipeline/src/lib/prg-disasm.ts) emits no per-line address
// column. What it DOES emit, deterministically, is enough to rebuild one:
//
//   .pc = $XXXX "code"        origin (KickAss)      * = $XXXX            (64tass)
//   .pseudopc $XXXX { … }     relocated block       .logical $XXXX … .here
//   // SEGMENT $XXXX-$YYYY    segment header        ; SEGMENT $XXXX-$YYYY
//   WXXXX:                    generated label at every referenced address
//   .byte / .word / .fill     data with a countable size
//   <mnemonic> <operand>      an instruction whose size follows from its
//                             operand form (the renderer writes zero-page
//                             operands as $HH and absolute ones as $HHHH or a
//                             label; `.abs` / `@w` force the 3-byte form)
//
// The map walks the text once per pass (two passes, so a hand-written label
// referenced before its definition resolves), counting bytes forward from the
// last anchor and re-synchronising at every anchor. Anchors also tell us when
// the count went wrong: `driftAt` records every anchor whose expected address
// differed from the running count, which is the map's own confidence report.
//
// Pure: no DOM, no React, no fetch. Unit-tested by scripts/smoke-824-2-source-jump.mjs.

export type AsmDialect = "kickass" | "64tass" | "plain";

export type AsmLineKind = "origin" | "anchor" | "label" | "code" | "data";

export interface AsmLineEntry {
  /** 0-based line index into the source */
  line: number;
  /** address of the first byte this line stands for */
  address: number;
  /** bytes the line occupies (0 for labels, origins and anchors) */
  size: number;
  kind: AsmLineKind;
}

export interface AsmAddressMap {
  entries: AsmLineEntry[];
  byLine: Map<number, AsmLineEntry>;
  /** anchors (WXXXX: labels, SEGMENT headers) where the running count disagreed */
  driftAt: Array<{ line: number; expected: number; actual: number }>;
  /** symbols seen: labels at their line address, `.label x = $…` / `x = $…` definitions */
  symbols: Map<string, number>;
}

export interface AsmLineHit {
  line: number;
  /** address the hit line starts at */
  address: number;
  /** true when a line starts exactly at the requested address */
  exact: boolean;
}

const BRANCHES = new Set(["bcc", "bcs", "beq", "bmi", "bne", "bpl", "bvc", "bvs"]);

const MNEMONICS = new Set([
  "adc", "and", "asl", "bcc", "bcs", "beq", "bit", "bmi", "bne", "bpl", "brk", "bvc", "bvs", "clc", "cld", "cli", "clv", "cmp", "cpx", "cpy", "dec", "dex", "dey", "eor", "inc", "inx", "iny", "jmp", "jsr", "lda", "ldx", "ldy", "lsr", "nop", "ora", "pha", "php", "pla", "plp", "rol", "ror", "rti", "rts", "sbc", "sec", "sed", "sei", "sta", "stx", "sty", "tax", "tay", "tsx", "txa", "txs", "tya",
  // undocumented, as the renderer names them when it renders them as mnemonics
  "alr", "anc", "ane", "arr", "axs", "dcp", "isc", "las", "lax", "lxa", "rla", "rra", "sax", "sbx", "sha", "shs", "shx", "shy", "slo", "sre", "tas", "jam", "kil", "hlt", "dop", "top", "isb", "dcm", "ins", "lae", "xaa",
]);

/** parse `$1F`, `%0101`, `123`, `0x1f` → number, else undefined */
export function parseNumber(token: string): number | undefined {
  const t = token.trim();
  if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^%[01]+$/.test(t)) return parseInt(t.slice(1), 2);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return undefined;
}

/** split on commas that sit outside quotes and parentheses */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < text.length) { cur += text[i + 1]; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** index of a `//` (kickass) or `;` (64tass) line comment outside string literals, else -1 */
function lineCommentIndex(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ";") return i;
    if (ch === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

/** the byte width an operand expression implies: 1 for a zero-page value, 2 otherwise */
function operandWidth(expr: string, symbols: Map<string, number>): 1 | 2 {
  const e = expr.trim();
  if (/^\$[0-9a-f]{1,2}$/i.test(e)) return 1;
  if (/^\$[0-9a-f]{3,}$/i.test(e)) return 2;
  if (/^%[01]{1,8}$/.test(e)) return 1;
  if (/^[0-9]+$/.test(e)) return parseInt(e, 10) < 0x100 ? 1 : 2;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) {
    const v = symbols.get(e);
    if (v !== undefined && v < 0x100) return 1;
    return 2;
  }
  // any expression with an operator, a lo/hi selector or an unknown shape: absolute
  return 2;
}

/**
 * Size in bytes of `<mnemonic>[.suffix] [operand]` as the renderer writes it.
 * Returns undefined when the word is not a 6502 mnemonic.
 */
export function instructionSize(mnemonic: string, suffix: string | undefined, operand: string | undefined, symbols: Map<string, number>): number | undefined {
  const m = mnemonic.toLowerCase();
  if (!MNEMONICS.has(m)) return undefined;
  let op = (operand ?? "").trim();
  if (op.length === 0) return 1; // implied / accumulator
  if (/^a$/i.test(op)) return 1; // `asl a` (64tass spelling of accumulator)
  if (BRANCHES.has(m)) return 2;
  let forced: 2 | 3 | undefined;
  const sfx = (suffix ?? "").toLowerCase();
  if (sfx === "abs" || sfx === "a" || sfx === "w") forced = 3;
  if (sfx === "z" || sfx === "zp" || sfx === "b") forced = 2;
  // 64tass width prefixes `@w` / `@b`
  const at = op.match(/^@([wb])\s+(.*)$/i);
  if (at) { forced = at[1]!.toLowerCase() === "w" ? 3 : 2; op = at[2]!.trim(); }
  if (op.startsWith("#")) return 2; // immediate
  if (op.startsWith("(")) {
    // (zp,x)  (zp),y  → 2 ; (abs) → 3 (jmp indirect)
    if (/\)\s*,\s*[yY]$/.test(op) || /,\s*[xX]\s*\)$/.test(op)) return 2;
    return 3;
  }
  if (forced) return forced;
  const indexed = op.match(/^(.*?)\s*,\s*[xXyY]$/);
  const expr = indexed ? indexed[1]! : op;
  return 1 + operandWidth(expr, symbols);
}

function directiveSize(name: string, args: string, symbols: Map<string, number>): number {
  const items = () => splitTopLevel(args);
  switch (name) {
    case "byte": case "char": return items().length;
    case "word": case "addr": case "rta": case "sint": return items().length * 2;
    case "long": case "lint": return items().length * 3;
    case "dword": case "dint": return items().length * 4;
    case "fill": {
      const [count] = items();
      if (count === undefined) return 0;
      const n = parseNumber(count) ?? symbols.get(count);
      return n ?? 0;
    }
    case "text": case "ptext": case "null": case "shift": case "shiftl": {
      let n = 0;
      for (const item of items()) {
        const q = item.match(/^(["'])(.*)\1$/s);
        if (q) n += q[2]!.replace(/\\./g, "x").length;
        else n += 1;
      }
      if (name === "ptext" || name === "null") n += 1;
      return n;
    }
    default: return 0;
  }
}

interface Frame { fileAddress: number; runtimeStart: number }

function runPass(lines: string[], symbols: Map<string, number>, record: boolean): AsmAddressMap {
  const entries: AsmLineEntry[] = [];
  const byLine = new Map<number, AsmLineEntry>();
  const driftAt: AsmAddressMap["driftAt"] = [];
  let address = 0;
  let haveOrigin = false;
  let inBlock = false;
  const frames: Frame[] = [];

  const push = (line: number, kind: AsmLineKind, size: number): void => {
    if (!record) return;
    const entry: AsmLineEntry = { line, address: address & 0xffff, size, kind };
    entries.push(entry);
    byLine.set(line, entry);
  };
  const anchor = (line: number, expected: number, kind: AsmLineKind): void => {
    if (haveOrigin && (address & 0xffff) !== (expected & 0xffff) && record) driftAt.push({ line, expected: expected & 0xffff, actual: address & 0xffff });
    address = expected & 0xffff;
    haveOrigin = true;
    push(line, kind, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    // segment header — an anchor that lives inside a comment, so read it before stripping
    const seg = raw.match(/^\s*(?:\/\/|;)\s*SEGMENT\s+\$([0-9a-f]{4})\s*-\s*\$([0-9a-f]{4})/i);
    if (seg && !inBlock) { anchor(i, parseInt(seg[1]!, 16), "anchor"); continue; }

    let text = raw;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      text = text.slice(end + 2);
    }
    // comments: whichever opens first wins — a `//…` line comment (the header's
    // `//****` contains `/*` and is NOT a block) or a `/* … */` block, which the
    // renderer opens at line start and may close on a later line
    for (;;) {
      const lc = lineCommentIndex(text);
      const open = text.indexOf("/*");
      if (open < 0 || (lc >= 0 && lc < open)) { if (lc >= 0) text = text.slice(0, lc); break; }
      const close = text.indexOf("*/", open + 2);
      if (close < 0) { text = text.slice(0, open); inBlock = true; break; }
      text = text.slice(0, open) + " " + text.slice(close + 2);
    }
    text = text.trim();
    if (text.length === 0) continue;

    // label at line start (`W4000:`, `main:`); the rest of the line may carry an instruction
    const lab = text.match(/^(?:!)?([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (lab) {
      const name = lab[1]!;
      const generated = name.match(/^W([0-9A-F]{4})$/);
      if (generated) anchor(i, parseInt(generated[1]!, 16), "label");
      else { symbols.set(name, address & 0xffff); push(i, "label", 0); }
      if (generated) symbols.set(name, address & 0xffff);
      text = lab[2]!.trim();
      if (text.length === 0) continue;
    }

    // origin: `.pc = $X "…"` / `* = $X` / `*= $X`
    const pc = text.match(/^(?:\.pc|\*)\s*=\s*([^\s"]+)/i);
    if (pc) {
      const v = parseNumber(pc[1]!) ?? symbols.get(pc[1]!);
      if (v !== undefined) { address = v & 0xffff; haveOrigin = true; }
      push(i, "origin", 0);
      continue;
    }
    // relocation block open: `.pseudopc $X {` / `.logical $X`
    const reloc = text.match(/^\.(?:pseudopc|logical)\s+([^\s{]+)/i);
    if (reloc) {
      const v = parseNumber(reloc[1]!) ?? symbols.get(reloc[1]!) ?? address;
      frames.push({ fileAddress: address & 0xffff, runtimeStart: v & 0xffff });
      address = v & 0xffff;
      haveOrigin = true;
      push(i, "origin", 0);
      continue;
    }
    // relocation block close: `}` / `.here`
    if (/^\}$/.test(text) || /^\.here$/i.test(text)) {
      const f = frames.pop();
      if (f) address = (f.fileAddress + ((address - f.runtimeStart) & 0xffff)) & 0xffff;
      push(i, "origin", 0);
      continue;
    }
    // symbol definitions: `.label x = $…`, `.const x = …`, `x = $…`
    const def = text.match(/^(?:\.(?:label|const|var)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (def) {
      const v = parseNumber(def[2]!);
      if (v !== undefined) symbols.set(def[1]!, v);
      continue;
    }
    // other directives
    const dir = text.match(/^\.([A-Za-z]+)\b\s*(.*)$/);
    if (dir) {
      const size = directiveSize(dir[1]!.toLowerCase(), dir[2] ?? "", symbols);
      if (size > 0) { push(i, "data", size); address = (address + size) & 0xffff; }
      continue;
    }
    // instruction
    const ins = text.match(/^([A-Za-z]{3})(?:\.([A-Za-z]+))?(?:\s+(.*))?$/);
    if (ins) {
      const size = instructionSize(ins[1]!, ins[2], ins[3], symbols);
      if (size !== undefined) { push(i, "code", size); address = (address + size) & 0xffff; continue; }
    }
    // anything else (a macro, an unknown word) occupies nothing we can count
  }
  return { entries, byLine, driftAt, symbols };
}

/**
 * Build the address map for a rendered listing. `source` may be the whole text
 * or its lines. `dialect` is informational — both comment styles and both
 * origin spellings are recognised regardless, because a 64tass file is the
 * converter's line-for-line image of the KickAss one.
 */
export function buildAsmAddressMap(source: string | string[], _dialect: AsmDialect = "kickass"): AsmAddressMap {
  const lines = Array.isArray(source) ? source : source.split("\n");
  // pass 1 learns the symbols (a hand-written zero-page label used before its definition);
  // pass 2 is the map
  const symbols = runPass(lines, new Map<string, number>(), false).symbols;
  return runPass(lines, symbols, true);
}

/**
 * The line to show for an address: a line starting exactly there (label before
 * instruction, as the renderer orders them), else the code/data line whose bytes
 * contain it. Segment-header anchors are never returned — they are comments.
 */
export function findLineForAddress(map: AsmAddressMap, address: number): AsmLineHit | undefined {
  const a = address & 0xffff;
  let containing: AsmLineEntry | undefined;
  for (const e of map.entries) {
    if (e.kind === "anchor") continue;
    if (e.address === a && (e.kind === "label" || e.size > 0)) return { line: e.line, address: e.address, exact: true };
    if (e.size > 0 && e.address < a && a < e.address + e.size && !containing) containing = e;
  }
  return containing ? { line: containing.line, address: containing.address, exact: false } : undefined;
}

/** every line that starts at `address` (the label and the instruction under it) */
export function linesAtAddress(map: AsmAddressMap, address: number): number[] {
  const a = address & 0xffff;
  return map.entries.filter((e) => e.kind !== "anchor" && e.address === a && (e.kind === "label" || e.size > 0)).map((e) => e.line);
}
