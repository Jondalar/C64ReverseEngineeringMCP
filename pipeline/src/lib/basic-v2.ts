/**
 * Spec 829 — BASIC V2 tooling: the chain walk, the lister, its exact inverse,
 * and the SYS / USR / LOAD facts.
 *
 * Pure: no I/O, no network, no ROM at run time. Everything the module needs is
 * a checked-in constant, which is the point of D1 — a listing must not change
 * when the network does.
 *
 * ---------------------------------------------------------------------------
 * D1 — where the token order comes from
 * ---------------------------------------------------------------------------
 * The 76 tokens $80..$CB below are the BASIC V2 keyword table at $A09E in the
 * BASIC ROM, in ROM order. That table is a run of keyword strings with the high
 * bit set on each keyword's LAST character; the ROM's CRUNCH routine walks it
 * from the top and the match index IS the token number. So the order is not a
 * convention somebody chose — $80 is END because END is the first string in the
 * table, and $CB is GO because GO is the last one. Two consequences the code
 * below depends on:
 *
 *   1. Tokenising takes the FIRST match in table order, not the longest. That
 *      is why INPUT# ($84) sits before INPUT ($85) and PRINT# ($98) before
 *      PRINT ($99): the earlier entry has to win, or `INPUT#1` would tokenise
 *      as INPUT followed by a stray `#`. Likewise GOTO ($89) before GO ($CB),
 *      which is why `GOTO` is one token and `GO TO` is two.
 *   2. The operators are keywords like any other — `+` is $AA, not $2B. Outside
 *      a string, the character `+` always means the token.
 *
 * Cross-checked on names against *C64/C128 Spielend BASIC lernen*, Appendix A
 * (see the spec): that list is OCR-damaged and omits POKE, LEFT$, MID$, FRE,
 * DEF, TAB( and SPC(, so it is a check on names and never a source. Nothing
 * from it is copied here.
 *
 * ---------------------------------------------------------------------------
 * D3 — the round trip is enforced by construction, not hoped for
 * ---------------------------------------------------------------------------
 * `renderLineBody` renders a line and then re-tokenises its own output. If the
 * bytes do not come back identical it escapes the offending byte as `{$XX}` and
 * renders again. So `tokenize(detokenize(b)) === b` holds for ANY byte string
 * the walk accepts, including bytes no BASIC ROM would ever have produced —
 * they simply show up as escapes, which is exactly the signal a reader wants.
 */

// ---------------------------------------------------------------------------
// The token table
// ---------------------------------------------------------------------------

export interface BasicToken {
  /** The byte value as stored in the program. */
  token: number;
  /** The keyword exactly as LIST prints it. */
  keyword: string;
}

export const BASIC_V2_TOKEN_MIN = 0x80;
export const BASIC_V2_TOKEN_MAX = 0xcb;

/** The BASIC V2 keyword table at $A09E, in ROM order. 76 entries, $80..$CB. */
export const BASIC_V2_TOKENS: readonly BasicToken[] = [
  { token: 0x80, keyword: "END" },
  { token: 0x81, keyword: "FOR" },
  { token: 0x82, keyword: "NEXT" },
  { token: 0x83, keyword: "DATA" },
  { token: 0x84, keyword: "INPUT#" },
  { token: 0x85, keyword: "INPUT" },
  { token: 0x86, keyword: "DIM" },
  { token: 0x87, keyword: "READ" },
  { token: 0x88, keyword: "LET" },
  { token: 0x89, keyword: "GOTO" },
  { token: 0x8a, keyword: "RUN" },
  { token: 0x8b, keyword: "IF" },
  { token: 0x8c, keyword: "RESTORE" },
  { token: 0x8d, keyword: "GOSUB" },
  { token: 0x8e, keyword: "RETURN" },
  { token: 0x8f, keyword: "REM" },
  { token: 0x90, keyword: "STOP" },
  { token: 0x91, keyword: "ON" },
  { token: 0x92, keyword: "WAIT" },
  { token: 0x93, keyword: "LOAD" },
  { token: 0x94, keyword: "SAVE" },
  { token: 0x95, keyword: "VERIFY" },
  { token: 0x96, keyword: "DEF" },
  { token: 0x97, keyword: "POKE" },
  { token: 0x98, keyword: "PRINT#" },
  { token: 0x99, keyword: "PRINT" },
  { token: 0x9a, keyword: "CONT" },
  { token: 0x9b, keyword: "LIST" },
  { token: 0x9c, keyword: "CLR" },
  { token: 0x9d, keyword: "CMD" },
  { token: 0x9e, keyword: "SYS" },
  { token: 0x9f, keyword: "OPEN" },
  { token: 0xa0, keyword: "CLOSE" },
  { token: 0xa1, keyword: "GET" },
  { token: 0xa2, keyword: "NEW" },
  { token: 0xa3, keyword: "TAB(" },
  { token: 0xa4, keyword: "TO" },
  { token: 0xa5, keyword: "FN" },
  { token: 0xa6, keyword: "SPC(" },
  { token: 0xa7, keyword: "THEN" },
  { token: 0xa8, keyword: "NOT" },
  { token: 0xa9, keyword: "STEP" },
  { token: 0xaa, keyword: "+" },
  { token: 0xab, keyword: "-" },
  { token: 0xac, keyword: "*" },
  { token: 0xad, keyword: "/" },
  { token: 0xae, keyword: "^" },
  { token: 0xaf, keyword: "AND" },
  { token: 0xb0, keyword: "OR" },
  { token: 0xb1, keyword: ">" },
  { token: 0xb2, keyword: "=" },
  { token: 0xb3, keyword: "<" },
  { token: 0xb4, keyword: "SGN" },
  { token: 0xb5, keyword: "INT" },
  { token: 0xb6, keyword: "ABS" },
  { token: 0xb7, keyword: "USR" },
  { token: 0xb8, keyword: "FRE" },
  { token: 0xb9, keyword: "POS" },
  { token: 0xba, keyword: "SQR" },
  { token: 0xbb, keyword: "RND" },
  { token: 0xbc, keyword: "LOG" },
  { token: 0xbd, keyword: "EXP" },
  { token: 0xbe, keyword: "COS" },
  { token: 0xbf, keyword: "SIN" },
  { token: 0xc0, keyword: "TAN" },
  { token: 0xc1, keyword: "ATN" },
  { token: 0xc2, keyword: "PEEK" },
  { token: 0xc3, keyword: "LEN" },
  { token: 0xc4, keyword: "STR$" },
  { token: 0xc5, keyword: "VAL" },
  { token: 0xc6, keyword: "ASC" },
  { token: 0xc7, keyword: "CHR$" },
  { token: 0xc8, keyword: "LEFT$" },
  { token: 0xc9, keyword: "RIGHT$" },
  { token: 0xca, keyword: "MID$" },
  { token: 0xcb, keyword: "GO" },
];

/**
 * π is not part of the keyword table — the ROM handles it separately in CRUNCH
 * ($A584: `CMP #$FF` before anything else) — but it is a token byte all the
 * same, so it is carried here rather than pretended away.
 */
export const BASIC_V2_PI: BasicToken = { token: 0xff, keyword: "π" };

/** The token bytes this module names by symbol rather than by number. */
export const BASIC_TOKEN = {
  DATA: 0x83,
  GOTO: 0x89,
  REM: 0x8f,
  LOAD: 0x93,
  PRINT: 0x99,
  SYS: 0x9e,
  USR: 0xb7,
  PI: 0xff,
} as const;

const KEYWORD_BY_TOKEN = new Map<number, string>(BASIC_V2_TOKENS.map((t) => [t.token, t.keyword]));

/** The keyword LIST prints for a token byte, or undefined for a non-token. */
export function keywordForToken(byte: number): string | undefined {
  return KEYWORD_BY_TOKEN.get(byte);
}

// ---------------------------------------------------------------------------
// D5 — PETSCII control and colour names
// ---------------------------------------------------------------------------

const CONTROL_NAME_TABLE: ReadonlyArray<readonly [number, string]> = [
  [0x05, "WHT"],
  [0x08, "DISABLE SHIFT+C="],
  [0x09, "ENABLE SHIFT+C="],
  [0x0d, "RETURN"],
  [0x0e, "LOWER CASE"],
  [0x11, "DOWN"],
  [0x12, "RVS ON"],
  [0x13, "HOME"],
  [0x14, "DEL"],
  [0x1c, "RED"],
  [0x1d, "RIGHT"],
  [0x1e, "GRN"],
  [0x1f, "BLU"],
  [0x81, "ORANGE"],
  [0x8d, "SHIFT+RETURN"],
  [0x8e, "UPPER CASE"],
  [0x90, "BLK"],
  [0x91, "UP"],
  [0x92, "RVS OFF"],
  [0x93, "CLR"],
  [0x94, "INST"],
  [0x95, "BRN"],
  [0x96, "LT RED"],
  [0x97, "GRY 1"],
  [0x98, "GRY 2"],
  [0x99, "LT GRN"],
  [0x9a, "LT BLU"],
  [0x9b, "GRY 3"],
  [0x9c, "PUR"],
  [0x9d, "LEFT"],
  [0x9e, "YEL"],
  [0x9f, "CYN"],
  [0xff, "PI"],
];

/** byte → canonical `{NAME}` label. The one rendering; the reverse map is tolerant. */
export const PETSCII_CONTROL_NAMES: ReadonlyMap<number, string> = new Map(CONTROL_NAME_TABLE);

/**
 * Spellings accepted on the way back in but never emitted. D5's own examples use
 * `{CYAN}`, the table above is the C64 keyboard's own shorthand `{CYN}`; both
 * have to mean $9F or the spec disagrees with itself.
 */
const CONTROL_NAME_ALIASES: ReadonlyArray<readonly [string, number]> = [
  ["WHITE", 0x05],
  ["CR", 0x0d],
  ["LOWERCASE", 0x0e],
  ["LOWER", 0x0e],
  ["CURSOR DOWN", 0x11],
  ["REVERSE ON", 0x12],
  ["RVSON", 0x12],
  ["CURSOR RIGHT", 0x1d],
  ["GREEN", 0x1e],
  ["BLUE", 0x1f],
  ["ORNG", 0x81],
  ["UPPERCASE", 0x8e],
  ["UPPER", 0x8e],
  ["BLACK", 0x90],
  ["CURSOR UP", 0x91],
  ["REVERSE OFF", 0x92],
  ["RVSOFF", 0x92],
  ["CLEAR", 0x93],
  ["BROWN", 0x95],
  ["LIGHT RED", 0x96],
  ["LT.RED", 0x96],
  ["GREY 1", 0x97],
  ["GRAY 1", 0x97],
  ["GREY 2", 0x98],
  ["GRAY 2", 0x98],
  ["LIGHT GREEN", 0x99],
  ["LIGHT BLUE", 0x9a],
  ["GREY 3", 0x9b],
  ["GRAY 3", 0x9b],
  ["PURPLE", 0x9c],
  ["CURSOR LEFT", 0x9d],
  ["YELLOW", 0x9e],
  ["CYAN", 0x9f],
];

function normaliseControlName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

const BYTE_BY_CONTROL_NAME: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [byte, name] of CONTROL_NAME_TABLE) map.set(normaliseControlName(name), byte);
  for (const [name, byte] of CONTROL_NAME_ALIASES) map.set(normaliseControlName(name), byte);
  return map;
})();

/** `{NAME}` label → byte, canonical names and the tolerated aliases. */
export const PETSCII_CONTROL_BYTES = BYTE_BY_CONTROL_NAME;

// ---------------------------------------------------------------------------
// The line record chain (D2)
// ---------------------------------------------------------------------------

export interface BasicLine {
  /** The BASIC line number. */
  number: number;
  /** Byte offset of the record inside the image. */
  offset: number;
  /** Address of the record, i.e. loadAddress + offset. */
  address: number;
  /** The 2-byte next-line pointer exactly as stored. */
  nextPointer: number;
  /** The token bytes, without the $00 terminator. */
  bytes: number[];
}

export interface BasicWalkOk {
  ok: true;
  loadAddress: number;
  lines: BasicLine[];
  /** Byte offset just past the terminating $0000 pointer. */
  endOffset: number;
  /**
   * Address of the final `$0000` next-line pointer. The BASIC region ends
   * there; anything after it — a SYS target, a packed payload — is not BASIC
   * and must not be swallowed by the BASIC segment.
   */
  endAddress: number;
  /**
   * The BASIC region as an inclusive address range: `start` is the load
   * address, `end` is the second byte of the terminating `$0000`. A caller
   * carving segments uses this and starts machine code at `end + 1`.
   */
  programRange: { start: number; end: number };
  /**
   * False when the line numbers do not ascend. Not an error: the editor always
   * produces an ascending list, but a protected listing is written by machine
   * code and out-of-order numbers are one of the oldest LIST-breaking tricks.
   * The pointer chain is what has to ascend; this is reported, not enforced.
   */
  ascendingLineNumbers: boolean;
}

export interface BasicWalkFail {
  ok: false;
  reason: string;
  /** Byte offset inside the image where the chain broke. */
  offset: number;
}

export type BasicWalkResult = BasicWalkOk | BasicWalkFail;

function hex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

function hex4(word: number): string {
  return word.toString(16).toUpperCase().padStart(4, "0");
}

function toByteArray(bytes: ArrayLike<number>): number[] {
  const out: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] & 0xff;
  return out;
}

/**
 * Walk the line-record chain from `loadAddress`. Only a clean walk yields lines;
 * anything else says where it broke, because half a listing is how the bug this
 * spec closes came about in the first place (D2).
 */
export function walkBasicProgram(bytes: ArrayLike<number>, loadAddress: number): BasicWalkResult {
  if (!Number.isInteger(loadAddress) || loadAddress < 0 || loadAddress > 0xffff) {
    return { ok: false, reason: `load address $${hex4(loadAddress | 0)} is outside the 64K address space`, offset: 0 };
  }
  const image = toByteArray(bytes);
  const lines: BasicLine[] = [];
  let offset = 0;

  for (;;) {
    if (image.length - offset < 2) {
      return lines.length === 0
        ? { ok: false, reason: "image is too short to hold a line record", offset }
        : { ok: false, reason: "the chain never ends at a $0000 next-line pointer", offset };
    }
    const pointer = image[offset] | (image[offset + 1] << 8);
    if (pointer === 0) {
      const endOffset = offset + 2;
      if (lines.length === 0) {
        return { ok: false, reason: "the program is empty — the first next-line pointer is already $0000", offset };
      }
      let ascending = true;
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].number <= lines[i - 1].number) ascending = false;
      }
      return {
        ok: true,
        loadAddress,
        lines,
        endOffset,
        endAddress: loadAddress + endOffset - 2,
        programRange: { start: loadAddress, end: loadAddress + endOffset - 1 },
        ascendingLineNumbers: ascending,
      };
    }

    if (image.length - offset < 4) {
      return { ok: false, reason: "truncated line record: the 2-byte line number is missing", offset: offset + 2 };
    }
    const lineNumber = image[offset + 2] | (image[offset + 3] << 8);
    const address = loadAddress + offset;

    if (pointer <= address) {
      return {
        ok: false,
        reason: `next-line pointer $${hex4(pointer)} does not advance past the record at $${hex4(address)}`,
        offset,
      };
    }
    const nextOffset = pointer - loadAddress;
    if (nextOffset > image.length) {
      return {
        ok: false,
        reason: `next-line pointer $${hex4(pointer)} points outside the image (${image.length} bytes from $${hex4(loadAddress)})`,
        offset,
      };
    }
    const terminator = nextOffset - 1;
    if (terminator < offset + 4) {
      return {
        ok: false,
        reason: `next-line pointer $${hex4(pointer)} leaves no room for the record's own header`,
        offset,
      };
    }
    if (image[terminator] !== 0) {
      return {
        ok: false,
        reason: `no $00 line terminator at $${hex4(loadAddress + terminator)}, where the next-line pointer says the line ends`,
        offset: terminator,
      };
    }

    lines.push({
      number: lineNumber,
      offset,
      address,
      nextPointer: pointer,
      bytes: image.slice(offset + 4, terminator),
    });
    offset = nextOffset;
  }
}

// ---------------------------------------------------------------------------
// The quote / REM state machine, shared by the lister and its inverse
// ---------------------------------------------------------------------------

/**
 * CRUNCH stops tokenising after a DATA token until the next colon. Settled
 * against the ROM disassembly rather than from memory ($A579 onward):
 *
 *   $A580  STY $0F      clear open quote/DATA flag
 *   $A5D4  SBC #$3A     subtract ":" from the byte just emitted
 *   $A5D6  BEQ $A5DC      …it WAS ":" → store $00, flag cleared
 *   $A5D8  CMP #$49     compare with DATA token - ':'   ($83 - $3A)
 *   $A5DC  STA $0F      store token-$3A; for DATA that is $49 = %01001001
 *   $A598  BIT $0F
 *   $A59A  BVS $A5C9    bit 6 set → save the byte and continue WITHOUT tokenising
 *
 * $49 carries bit 6, which is precisely the bit `BVS` tests, and a colon resets
 * $0F to zero so tokenising resumes after it. So an unquoted `DATA ONE` stores
 * the letters O, N, E — it does NOT become an ON token. The opposite is a
 * widespread belief and it is wrong; this comment exists so the next reader does
 * not "fix" it back.
 */
const DATA_SUPPRESSES_TOKENS: boolean = true;

const MODE_TOKEN = 0;
const MODE_LITERAL = 1;

interface LineState {
  isLiteral(): boolean;
  feed(byte: number): void;
}

function makeLineState(): LineState {
  let inQuote = false;
  let inRem = false;
  let inData = false;
  return {
    isLiteral: () => inQuote || inRem || inData,
    feed(byte: number): void {
      if (inRem) return; // REM eats the rest of the line, colons included
      if (byte === 0x22) {
        inQuote = !inQuote;
        return;
      }
      if (inQuote) return;
      if (inData) {
        if (byte === 0x3a) inData = false;
        return;
      }
      if (byte === BASIC_TOKEN.REM) inRem = true;
      else if (DATA_SUPPRESSES_TOKENS && byte === BASIC_TOKEN.DATA) inData = true;
    },
  };
}

/** Per-byte mode for one line's token bytes: MODE_TOKEN or MODE_LITERAL. */
function classifyLineBytes(bytes: readonly number[]): Uint8Array {
  const modes = new Uint8Array(bytes.length);
  const state = makeLineState();
  for (let i = 0; i < bytes.length; i += 1) {
    modes[i] = state.isLiteral() ? MODE_LITERAL : MODE_TOKEN;
    state.feed(bytes[i]);
  }
  return modes;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `{` and `}` are the escape delimiters, so the two PETSCII bytes that carry
 * those glyphs are always escaped — otherwise the text would be ambiguous and
 * D3 could not hold.
 */
function isDirectChar(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e && byte !== 0x7b && byte !== 0x7d;
}

function renderByte(byte: number, literal: boolean): string {
  if (isDirectChar(byte)) return String.fromCharCode(byte);
  if (!literal) {
    const keyword = KEYWORD_BY_TOKEN.get(byte);
    if (keyword !== undefined) return keyword;
    if (byte === BASIC_TOKEN.PI) return BASIC_V2_PI.keyword;
  }
  const name = PETSCII_CONTROL_NAMES.get(byte);
  if (name !== undefined) return `{${name}}`;
  return `{$${hex2(byte)}}`;
}

function renderBytesRange(
  bytes: readonly number[],
  modes: Uint8Array,
  from: number,
  to: number,
  forced?: ReadonlySet<number>,
): string {
  let out = "";
  for (let i = from; i < to; i += 1) {
    if (forced && forced.has(i)) {
      out += `{$${hex2(bytes[i])}}`;
      continue;
    }
    out += renderByte(bytes[i], modes[i] === MODE_LITERAL);
  }
  return out;
}

function sameBytes(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Render one line's token bytes, then prove the rendering by feeding it back
 * through the tokeniser. Any byte the text would not reproduce is escaped as
 * `{$XX}` and the line is rendered again. This is what makes D3 a property of
 * the code rather than a property of the fixtures.
 */
export function renderLineBody(bytes: readonly number[]): string {
  const modes = classifyLineBytes(bytes);
  const forced = new Set<number>();

  for (let attempt = 0; attempt <= bytes.length; attempt += 1) {
    const text = renderBytesRange(bytes, modes, 0, bytes.length, forced);
    let back: number[];
    try {
      back = tokenizeLineBody(text);
    } catch {
      back = [];
    }
    if (sameBytes(back, bytes)) return text;

    let culprit = 0;
    const limit = Math.min(back.length, bytes.length);
    while (culprit < limit && back[culprit] === bytes[culprit]) culprit += 1;
    if (culprit >= bytes.length) culprit = bytes.length - 1;
    while (culprit >= 0 && forced.has(culprit)) culprit -= 1;
    if (culprit < 0) break;
    forced.add(culprit);
  }
  throw new Error(`BASIC line could not be rendered reversibly: ${bytes.map(hex2).join(" ")}`);
}

/** `10 SYS 2064` — the line number, one space, the body. */
export function renderBasicLine(line: BasicLine): string {
  const body = renderLineBody(line.bytes);
  return body.length > 0 ? `${line.number} ${body}` : `${line.number}`;
}

export interface DetokenizeOptions {
  /** Default "\n". */
  lineSeparator?: string;
  /** Append the separator after the last line too. Default false. */
  trailingSeparator?: boolean;
}

/**
 * The listing. Throws when the chain walk fails — a program that is not BASIC
 * gets no listing at all, rather than a plausible-looking half of one (D2).
 */
export function detokenize(bytes: ArrayLike<number>, loadAddress: number, opts?: DetokenizeOptions): string {
  const walk = walkBasicProgram(bytes, loadAddress);
  if (!walk.ok) {
    throw new Error(
      `Not a BASIC program: ${walk.reason} (byte offset ${walk.offset}, $${hex4((loadAddress + walk.offset) & 0xffff)})`,
    );
  }
  return detokenizeLines(walk.lines, opts);
}

export function detokenizeLines(lines: readonly BasicLine[], opts?: DetokenizeOptions): string {
  const separator = opts?.lineSeparator ?? "\n";
  const text = lines.map(renderBasicLine).join(separator);
  return opts?.trailingSeparator ? text + separator : text;
}

// ---------------------------------------------------------------------------
// Tokenising — the exact inverse
// ---------------------------------------------------------------------------

export class BasicTokenizeError extends Error {
  readonly textLine: number;
  readonly column: number;
  constructor(message: string, textLine: number, column: number) {
    super(`${message} (text line ${textLine}, column ${column + 1})`);
    this.name = "BasicTokenizeError";
    this.textLine = textLine;
    this.column = column;
  }
}

function parseEscape(text: string, open: number, textLine: number): { byte: number; next: number } {
  const close = text.indexOf("}", open + 1);
  if (close === -1) throw new BasicTokenizeError("unterminated `{` escape", textLine, open);
  const body = text.slice(open + 1, close);
  const hexMatch = /^\$([0-9a-fA-F]{1,2})$/.exec(body.trim());
  if (hexMatch) return { byte: Number.parseInt(hexMatch[1], 16) & 0xff, next: close + 1 };
  const byte = BYTE_BY_CONTROL_NAME.get(normaliseControlName(body));
  if (byte === undefined) throw new BasicTokenizeError(`unknown escape {${body}}`, textLine, open);
  return { byte, next: close + 1 };
}

/**
 * First match in table order, case-insensitively — the ROM's own scan, which is
 * why `INPUT#` beats `INPUT` and why `BTOC` tokenises the TO in the middle.
 */
function matchKeyword(text: string, at: number): BasicToken | undefined {
  for (const entry of BASIC_V2_TOKENS) {
    const candidate = text.substr(at, entry.keyword.length);
    if (candidate.length === entry.keyword.length && candidate.toUpperCase() === entry.keyword) return entry;
  }
  return undefined;
}

/** One line's body text → its token bytes. */
export function tokenizeLineBody(text: string, textLine = 0): number[] {
  const out: number[] = [];
  const state = makeLineState();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      const escape = parseEscape(text, i, textLine);
      out.push(escape.byte);
      state.feed(escape.byte);
      i = escape.next;
      continue;
    }
    if (ch === BASIC_V2_PI.keyword) {
      out.push(BASIC_TOKEN.PI);
      state.feed(BASIC_TOKEN.PI);
      i += 1;
      continue;
    }
    if (!state.isLiteral()) {
      const keyword = matchKeyword(text, i);
      if (keyword) {
        out.push(keyword.token);
        state.feed(keyword.token);
        i += keyword.keyword.length;
        continue;
      }
      if (ch === "?") {
        // The ROM's own shorthand: `?` crunches to PRINT. Accepted on input,
        // never emitted, so the canonical text still round-trips.
        out.push(BASIC_TOKEN.PRINT);
        state.feed(BASIC_TOKEN.PRINT);
        i += 1;
        continue;
      }
    }
    const code = ch.charCodeAt(0);
    if (code > 0xff) throw new BasicTokenizeError(`character U+${code.toString(16).toUpperCase()} is not a PETSCII byte`, textLine, i);
    out.push(code);
    state.feed(code);
    i += 1;
  }
  return out;
}

/**
 * Text → the in-memory image at `loadAddress`, byte-identical to what BASIC
 * would have stored. The inverse of `detokenize` (D3).
 */
export function tokenize(text: string, loadAddress: number): Uint8Array {
  if (!Number.isInteger(loadAddress) || loadAddress < 0 || loadAddress > 0xffff) {
    throw new Error(`Invalid load address $${hex4(loadAddress | 0)}`);
  }
  const records: Array<{ number: number; bytes: number[] }> = [];
  const rawLines = text.split("\n");

  for (let n = 0; n < rawLines.length; n += 1) {
    const raw = rawLines[n].replace(/\r$/, "");
    if (raw.trim().length === 0) continue;
    const header = /^\s*(\d+)/.exec(raw);
    if (!header) throw new BasicTokenizeError("expected a line number", n + 1, 0);
    const lineNumber = Number.parseInt(header[1], 10);
    if (lineNumber > 0xffff) throw new BasicTokenizeError(`line number ${lineNumber} does not fit in 16 bits`, n + 1, 0);
    let body = raw.slice(header[0].length);
    if (body.startsWith(" ")) body = body.slice(1);
    records.push({ number: lineNumber, bytes: tokenizeLineBody(body, n + 1) });
  }

  const out: number[] = [];
  let address = loadAddress;
  for (const record of records) {
    const next = address + 4 + record.bytes.length + 1;
    out.push(next & 0xff, (next >> 8) & 0xff, record.number & 0xff, (record.number >> 8) & 0xff);
    out.push(...record.bytes);
    out.push(0x00);
    address = next;
  }
  out.push(0x00, 0x00);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// D4 — the SYS / USR / LOAD facts
// ---------------------------------------------------------------------------

export type BasicFactKind = "sys" | "usr" | "load";
export type BasicFactConfidence = "certain" | "inferred" | "unresolved";

/**
 * A SYS is a call into machine code, so a fact has to say WHERE it was found or
 * it can never become an edge. `site` is the absolute address of the `$9E` /
 * `$B7` / `$93` byte itself — carried down from the line record's own offset,
 * never recomputed from the rendered text — and it mirrors
 * `evidence.source_address` on every control-flow edge in this repo, which is
 * what a later producer joins on.
 */
export interface BasicFact {
  kind: BasicFactKind;
  /** The BASIC line number the keyword sits on. */
  lineNumber: number;
  /** Absolute address of the keyword token byte: loadAddress + its offset. */
  site: number;
  /** Resolved target (SYS/USR) when it is known. */
  value?: number;
  /** LOAD's file name, when it is a literal. */
  fileName?: string;
  /** The argument exactly as it lists. Always set — an unresolved one is never dropped. */
  expression?: string;
  confidence: BasicFactConfidence;
  /** Byte offset of the keyword token inside the image (site - loadAddress). */
  offset: number;
  /** LOAD's device number, when it folds. */
  device?: number;
  /** LOAD's secondary address, when it folds. */
  secondary?: number;
}

function statementEnd(bytes: readonly number[], modes: Uint8Array, from: number): number {
  let depth = 0;
  for (let i = from; i < bytes.length; i += 1) {
    if (modes[i] === MODE_LITERAL) continue;
    const byte = bytes[i];
    if (byte === 0x28) depth += 1;
    else if (byte === 0x29) depth = Math.max(0, depth - 1);
    else if (byte === 0x3a && depth === 0) return i;
  }
  return bytes.length;
}

function splitArguments(bytes: readonly number[], modes: Uint8Array, from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    if (modes[i] === MODE_LITERAL) continue;
    const byte = bytes[i];
    if (byte === 0x28) depth += 1;
    else if (byte === 0x29) depth = Math.max(0, depth - 1);
    else if (byte === 0x2c && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

function stripOuterParens(text: string): string {
  let out = text;
  while (out.length >= 2 && out.startsWith("(") && out.endsWith(")")) {
    let depth = 0;
    let matched = true;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === "(") depth += 1;
      else if (out[i] === ")") {
        depth -= 1;
        if (depth === 0 && i !== out.length - 1) {
          matched = false;
          break;
        }
      }
    }
    if (!matched) break;
    out = out.slice(1, -1);
  }
  return out;
}

/**
 * Constant folding over `+ - * / ^` and parentheses. Anything else — PEEK, a
 * variable, a function call — fails, and the caller reports the expression as
 * unresolved rather than dropping it (D4).
 */
export function foldExpression(text: string): number | undefined {
  const src = text.replace(/\s+/g, "");
  if (src.length === 0) return undefined;
  let pos = 0;
  let failed = false;

  function primary(): number {
    if (src[pos] === "(") {
      pos += 1;
      const value = expr();
      if (src[pos] !== ")") {
        failed = true;
        return 0;
      }
      pos += 1;
      return value;
    }
    const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(pos));
    if (!match) {
      failed = true;
      return 0;
    }
    pos += match[0].length;
    return Number(match[0]);
  }

  function power(): number {
    const base = primary();
    if (failed) return 0;
    if (src[pos] === "^") {
      pos += 1;
      return Math.pow(base, unary());
    }
    return base;
  }

  function unary(): number {
    if (src[pos] === "-") {
      pos += 1;
      return -unary();
    }
    if (src[pos] === "+") {
      pos += 1;
      return unary();
    }
    return power();
  }

  function term(): number {
    let value = unary();
    while (!failed && (src[pos] === "*" || src[pos] === "/")) {
      const op = src[pos];
      pos += 1;
      const rhs = unary();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }

  function expr(): number {
    let value = term();
    while (!failed && (src[pos] === "+" || src[pos] === "-")) {
      const op = src[pos];
      pos += 1;
      const rhs = term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = expr();
  if (failed || pos !== src.length || !Number.isFinite(result)) return undefined;
  return result;
}

function resolveArgument(expression: string): { value?: number; confidence: BasicFactConfidence } {
  const bare = stripOuterParens(expression.replace(/\s+/g, ""));
  if (/^\d+$/.test(bare)) {
    const value = Number.parseInt(bare, 10);
    if (value >= 0 && value <= 0xffff) return { value, confidence: "certain" };
  }
  const folded = foldExpression(expression);
  if (folded !== undefined && Number.isInteger(folded) && folded >= 0 && folded <= 0xffff) {
    return { value: folded, confidence: "inferred" };
  }
  return { confidence: "unresolved" };
}

function foldSmallInt(text: string, max: number): number | undefined {
  const value = foldExpression(text);
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value;
}

/**
 * Every SYS, USR and LOAD argument in the walked lines. USR's value is its
 * argument, not its target — USR jumps through the vector at $0311/$0312, which
 * is a memory fact and not a listing fact.
 */
export function extractBasicFacts(lines: readonly BasicLine[]): BasicFact[] {
  const facts: BasicFact[] = [];
  for (const line of lines) {
    const bytes = line.bytes;
    const modes = classifyLineBytes(bytes);
    for (let i = 0; i < bytes.length; i += 1) {
      if (modes[i] === MODE_LITERAL) continue;
      const byte = bytes[i];
      if (byte !== BASIC_TOKEN.SYS && byte !== BASIC_TOKEN.USR && byte !== BASIC_TOKEN.LOAD) continue;

      const end = statementEnd(bytes, modes, i + 1);
      // The site comes from the record's own offset — 4 bytes of header, then
      // the token's index in the line — so it survives whatever the renderer does.
      const base = {
        lineNumber: line.number,
        offset: line.offset + 4 + i,
        site: line.address + 4 + i,
      };

      if (byte === BASIC_TOKEN.LOAD) {
        const expression = renderBytesRange(bytes, modes, i + 1, end).trim();
        const args = splitArguments(bytes, modes, i + 1, end);
        const fact: BasicFact = { kind: "load", ...base, expression, confidence: "unresolved" };
        const first = args.length > 0 ? renderBytesRange(bytes, modes, args[0][0], args[0][1]).trim() : "";
        const quoted = /^"([^"]*)"?$/.exec(first);
        if (quoted) {
          fact.fileName = quoted[1];
          fact.confidence = "certain";
        }
        if (args.length > 1) {
          const device = foldSmallInt(renderBytesRange(bytes, modes, args[1][0], args[1][1]), 0xff);
          if (device !== undefined) fact.device = device;
        }
        if (args.length > 2) {
          const secondary = foldSmallInt(renderBytesRange(bytes, modes, args[2][0], args[2][1]), 0xff);
          if (secondary !== undefined) fact.secondary = secondary;
        }
        facts.push(fact);
        continue;
      }

      const expression = renderBytesRange(bytes, modes, i + 1, end).trim();
      const resolved = resolveArgument(expression);
      const fact: BasicFact = {
        kind: byte === BASIC_TOKEN.SYS ? "sys" : "usr",
        ...base,
        expression,
        confidence: resolved.confidence,
      };
      if (resolved.value !== undefined) fact.value = resolved.value;
      facts.push(fact);
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The doors the rest of the pipeline uses
// ---------------------------------------------------------------------------

/** The load address a stock BASIC program starts at. */
export const BASIC_V2_LOAD_ADDRESS = 0x0801;

/** Split a .PRG into its 2-byte load address and the image that follows it. */
export function stripPrgHeader(prg: ArrayLike<number>): { loadAddress: number; body: Uint8Array } {
  if (prg.length < 2) throw new Error("PRG is shorter than its 2-byte load address header");
  const loadAddress = (prg[0] & 0xff) | ((prg[1] & 0xff) << 8);
  const body = new Uint8Array(prg.length - 2);
  for (let i = 0; i < body.length; i += 1) body[i] = prg[i + 2] & 0xff;
  return { loadAddress, body };
}

/** The inverse: an image plus its load address, as a .PRG. */
export function toPrg(loadAddress: number, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(body.length + 2);
  out[0] = loadAddress & 0xff;
  out[1] = (loadAddress >> 8) & 0xff;
  for (let i = 0; i < body.length; i += 1) out[i + 2] = body[i] & 0xff;
  return out;
}

export interface BasicProgramAnalysisOk extends BasicWalkOk {
  listing: string;
  facts: BasicFact[];
  /**
   * D6: a stub is a two-line launcher that exists to SYS somewhere. A program
   * with logic in it is not a stub, and the disassembler has to skip it whole.
   */
  isStub: boolean;
}

export type BasicProgramAnalysis = BasicProgramAnalysisOk | BasicWalkFail;

/** Walk, list and extract in one call — the shape a tool or an analyzer wants. */
export function analyzeBasicProgram(bytes: ArrayLike<number>, loadAddress: number): BasicProgramAnalysis {
  const walk = walkBasicProgram(bytes, loadAddress);
  if (!walk.ok) return walk;
  const facts = extractBasicFacts(walk.lines);
  return {
    ...walk,
    listing: detokenizeLines(walk.lines),
    facts,
    isStub: walk.lines.length <= 2 && facts.some((f) => f.kind === "sys"),
  };
}

/** True when the bytes at `loadAddress` are a clean BASIC line-record chain. */
export function isBasicProgram(bytes: ArrayLike<number>, loadAddress: number): boolean {
  return walkBasicProgram(bytes, loadAddress).ok;
}
