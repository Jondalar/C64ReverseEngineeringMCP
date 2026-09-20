// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ADDRESS RULE. This file is the only place it is written down.
//
// `src/` is ESM and `pipeline/src/` is CommonJS and the two halves cannot import
// each other's modules, so this file has a twin: `pipeline/src/lib/address-rule.ts`,
// whose body is generated from this one and checked against it. Everything below the
// header marker is byte-identical in both files; `npm run check:address-rule`
// regenerates the twin (`--write`), proves the two compiled modules answer
// identically over a corpus, and refuses a THIRD copy anywhere in the repo.
//
// It has that gate because the rule has now been written twice and drifted twice.
// The first time, `entry_points` read `"E800"` as hex while the relocation loader ran
// `parseInt(s, 10)` on it — `"E800"` became NaN and printed as `null`, and `"2000"`
// became decimal 2000, i.e. $07D0. One notation, two meanings, decided by which field
// the value landed in. That was fixed by stating the rule — in two files. Then a new
// door (`disasm_raw`) was written against the statement rather than against the
// function, and the pipeline half kept four more inline `parseInt(x, 16)` sites of its
// own. A rule that is stated twice is a rule that will disagree with itself; a rule
// that is IMPORTED cannot.
// ─────────────────────────────────────────────────────────────────────────────
// ── shared body begins (generated into pipeline/src/lib/address-rule.ts) ──

/** What every refusal says, so a caller is told the rule at the moment it bites. */
export const ADDRESS_RULE =
  "an address is HEX — \"E800\", \"$E800\" and \"0xE800\" all mean $E800; a bare JSON number is taken as-is (not re-read as hex)";

/** The same rule for a counted quantity, which is where it is easiest to misread. */
export const COUNT_RULE =
  `${ADDRESS_RULE}. A byte count follows the same rule and is not clamped to 16 bits`;

/**
 * An address: hex, `$` and `0x` optional decoration, a JSON number taken as given.
 * Clamped to 16 bits, because a 6502 address is 16 bits.
 */
export function parseAddress(value: unknown, field = "address"): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field}: ${JSON.stringify(value)} is not an address — ${ADDRESS_RULE}`);
    }
    return value & 0xffff;
  }
  if (typeof value === "string") {
    const text = value.trim().replace(/^\$/, "").replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]{1,4}$/.test(text)) {
      throw new Error(`${field}: ${JSON.stringify(value)} is not an address — ${ADDRESS_RULE}`);
    }
    return parseInt(text, 16) & 0xffff;
  }
  throw new Error(`${field}: ${JSON.stringify(value)} is not an address — ${ADDRESS_RULE}`);
}

/**
 * A byte count — an offset, a length — read by the same rule as an address.
 *
 * `offset` and `length` are counted, not addressed, and that is exactly why the rule
 * needs saying here too: two notations for one field is the defect this module exists
 * to end. So the rule does not fork — a string is HEX (`"100"` is 256 bytes), a JSON
 * number is taken as given (`100` is 100 bytes). Unlike an address a count is not
 * clamped to 16 bits: a window can sit anywhere in a file of any size.
 */
export function parseCount(value: unknown, field = "count"): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field}: ${JSON.stringify(value)} is not a byte count — ${COUNT_RULE}`);
    }
    return value;
  }
  if (typeof value === "string") {
    const text = value.trim().replace(/^\$/, "").replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]{1,8}$/.test(text)) {
      throw new Error(`${field}: ${JSON.stringify(value)} is not a byte count — ${COUNT_RULE}`);
    }
    return parseInt(text, 16);
  }
  throw new Error(`${field}: ${JSON.stringify(value)} is not a byte count — ${COUNT_RULE}`);
}

/**
 * A comma-separated list of addresses, the notation the CLI's positional entry-point
 * slot has always used. Empty entries are dropped; anything that is not an address is
 * refused by position, never turned into NaN.
 */
export function parseAddressList(value: string, field = "entry_points"): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index) => parseAddress(part, `${field}[${index}]`));
}

/** True when every comma-separated item reads as an address — used to tell a list from a path. */
export function looksLikeAddressList(value: string): boolean {
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  return parts.every((part) => /^(\$|0[xX])?[0-9a-fA-F]{1,4}$/.test(part));
}

// ── shared body ends ──
