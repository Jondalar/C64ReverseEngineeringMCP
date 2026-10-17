/**
 * Spec 914 D1 — a listing is a list of lines, and a dialect is a way of writing them down.
 *
 * The renderer used to build KickAssembler text and a second pass pattern-converted that text
 * into 64tass. Every spelling difference lived in a regular expression over finished text, and
 * a third dialect would have been a third pass. Now the renderer builds `ListingLine`s — a
 * label, an instruction with its operand as an expression, a data directive, a comment, an
 * equate, a relocation block — and one emitter per dialect writes them. The structure is a
 * TypeScript type and nothing else: it is never a file.
 *
 * What differs between the two dialects is small and is all here: how a comment starts, how an
 * equate is spelled, how the origin and the CPU are set, how a zero-page operand is forced to
 * its absolute form, how a relocated block opens and closes. Operands are expressions both
 * assemblers read the same way, so they travel as text inside the line.
 */

/** The dialects a listing can be written in. Values are the ones the project setting uses. */
export type Dialect = "kickass" | "64tass";

export const DIALECTS: readonly Dialect[] = ["kickass", "64tass"];

/** The file extension a listing in this dialect carries. */
export function listingExtension(dialect: Dialect): ".asm" | ".tas" {
  return dialect === "64tass" ? ".tas" : ".asm";
}

/** The dialect a listing file name says it is written in, or undefined for any other name. */
export function dialectOfPath(path: string): Dialect | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext === "tas" || ext === "tass") return "64tass";
  if (ext === "asm") return "kickass";
  return undefined;
}

/** The comment marker of a dialect. */
export function commentMarker(dialect: Dialect): string {
  return dialect === "64tass" ? ";" : "//";
}

/** Where the trailing comment of an instruction or data line starts, when the line sets no column. */
export const DEFAULT_COMMENT_COLUMN = 34;

export type ListingLine =
  /** An empty line. */
  | { k: "blank" }
  /**
   * A whole-line comment. `raw` is everything after the marker, leading spaces included, so
   * the banner `//****` and the two-space header lines keep their layout in both dialects.
   * `indent` is the number of spaces before the marker.
   */
  | { k: "comment"; raw: string; indent?: number }
  /**
   * A multi-line comment. `plain` writes the rows as they are between the block opener and closer
   * (64tass: a semicolon in front of each); `banner` puts the first row after the opener, the last before
   * the closer and a star in front of the ones between.
   */
  | { k: "block"; rows: string[]; style: "plain" | "banner" }
  /** `name:` with an optional trailing comment. */
  | { k: "label"; name: string; comment?: string }
  /**
   * One instruction. `operand` is the expression, `wide` forces the absolute (3-byte) form on
   * an operand that fits the zero page. `col` is the column the comment starts at.
   */
  | { k: "insn"; mnemonic: string; operand?: string; wide?: boolean; comment?: string; col?: number }
  /** `.byte` / `.word` with its argument list. `col` is the column the comment starts at (the whole directive counts). */
  | { k: "data"; directive: "byte" | "word"; args: string; comment?: string; col?: number }
  /** `name = value`, with an optional trailing comment. */
  | { k: "equate"; name: string; value: string; comment?: string }
  /** The CPU. Always the 6502 — the line exists so a dialect spells it. */
  | { k: "cpu" }
  /** The program counter, for the code that follows. */
  | { k: "origin"; address: number; name?: string }
  /** Opens a block whose bytes sit where they are stored and run at `address`. */
  | { k: "relocBegin"; address: number }
  /** Closes the innermost relocation block. */
  | { k: "relocEnd" }
  /** Text bytes: `value` is already escaped for a quoted string. Only the menu exporter writes these. */
  | { k: "text"; value: string; comment?: string }
  /** Makes the `text` lines that follow raw ASCII bytes — each assembler's default encoding is a different one. */
  | { k: "encoding" };

/** The line constructors the renderer uses; each is the one place a shape is spelled. */
export const L = {
  blank: (): ListingLine => ({ k: "blank" }),
  /** `// text` — one space after the marker. */
  comment: (text: string, indent = 0): ListingLine => ({ k: "comment", raw: text === "" ? "" : ` ${text}`, ...(indent > 0 ? { indent } : {}) }),
  /** The comment exactly as written after the marker. */
  commentRaw: (raw: string, indent = 0): ListingLine => ({ k: "comment", raw, ...(indent > 0 ? { indent } : {}) }),
  block: (rows: string[], style: "plain" | "banner" = "plain"): ListingLine => ({ k: "block", rows, style }),
  label: (name: string, comment?: string): ListingLine => ({ k: "label", name, ...(comment ? { comment } : {}) }),
  insn: (mnemonic: string, operand: string | undefined, wide: boolean, comment?: string): ListingLine => ({
    k: "insn", mnemonic, ...(operand ? { operand } : {}), ...(wide ? { wide: true } : {}), ...(comment ? { comment } : {}),
  }),
  byte: (args: string, comment?: string, col?: number): ListingLine => ({
    k: "data", directive: "byte", args, ...(comment ? { comment } : {}), ...(col !== undefined ? { col } : {}),
  }),
  word: (args: string, comment?: string): ListingLine => ({ k: "data", directive: "word", args, ...(comment ? { comment } : {}) }),
  equate: (name: string, value: string, comment?: string): ListingLine => ({ k: "equate", name, value, ...(comment ? { comment } : {}) }),
  cpu: (): ListingLine => ({ k: "cpu" }),
  origin: (address: number, name?: string): ListingLine => ({ k: "origin", address, ...(name ? { name } : {}) }),
  relocBegin: (address: number): ListingLine => ({ k: "relocBegin", address }),
  relocEnd: (): ListingLine => ({ k: "relocEnd" }),
  text: (value: string, comment?: string): ListingLine => ({ k: "text", value, ...(comment ? { comment } : {}) }),
  encoding: (): ListingLine => ({ k: "encoding" }),
};

const hex16 = (value: number): string => (value & 0xffff).toString(16).toUpperCase().padStart(4, "0");

/** The indentation a line inside a relocation block gets, per level. */
const RELOC_INDENT = "        ";

function trailing(dialect: Dialect, text: string, comment: string | undefined, col: number): string {
  if (!comment) return text;
  return `${text.padEnd(col)}${commentMarker(dialect)} ${comment}`;
}

/** The text of one instruction, without indentation or comment. */
export function instructionText(dialect: Dialect, mnemonic: string, operand: string | undefined, wide: boolean | undefined): string {
  if (!operand) return mnemonic;
  if (wide) return dialect === "64tass" ? `${mnemonic} @w ${operand}` : `${mnemonic}.abs ${operand}`;
  return `${mnemonic.padEnd(5)}${operand}`;
}

/** An equate in a dialect, without indentation or comment. */
export function equateText(dialect: Dialect, name: string, value: string): string {
  return dialect === "64tass" ? `${name} = ${value}` : `.label ${name} = ${value}`;
}

/** One line of a block comment in 64tass, which has no block comment. */
function semicolonRow(row: string): string {
  return `;${row === "" ? "" : ` ${row}`}`;
}

/** Writes lines down in one dialect. Output is the file's text, newline terminated. */
export function emitListing(lines: readonly ListingLine[], dialect: Dialect): string {
  const out: string[] = [];
  const marker = commentMarker(dialect);
  let depth = 0;
  const push = (text: string): void => {
    out.push(depth > 0 && text.length > 0 ? `${RELOC_INDENT.repeat(depth)}${text}` : text);
  };
  for (const line of lines) {
    switch (line.k) {
      case "blank":
        push("");
        break;
      case "comment":
        push(`${" ".repeat(line.indent ?? 0)}${marker}${line.raw}`);
        break;
      case "block":
        if (dialect === "64tass") {
          if (line.style === "plain") {
            push(";");
            for (const row of line.rows) push(semicolonRow(row).trimEnd());
            push(";");
          } else {
            for (const row of line.rows) push(semicolonRow(row).trimEnd());
          }
        } else if (line.style === "plain") {
          push("/*");
          for (const row of line.rows) push(row);
          push("*/");
        } else {
          line.rows.forEach((row, index) => {
            if (line.rows.length === 1) push(`/* ${row} */`);
            else if (index === 0) push(`/* ${row}`);
            else if (index === line.rows.length - 1) push(` * ${row} */`);
            else push(` * ${row}`);
          });
        }
        break;
      case "label":
        push(`${line.name}:${line.comment ? ` ${marker} ${line.comment}` : ""}`);
        break;
      case "insn":
        push(`      ${trailing(dialect, instructionText(dialect, line.mnemonic, line.operand, line.wide), line.comment, line.col ?? DEFAULT_COMMENT_COLUMN)}`.trimEnd());
        break;
      case "data": {
        const text = `      ${trailing(dialect, `.${line.directive} ${line.args}`, line.comment, line.col ?? DEFAULT_COMMENT_COLUMN)}`;
        push(line.comment ? text.trimEnd() : text);
        break;
      }
      case "equate":
        push(`      ${equateText(dialect, line.name, line.value)}${line.comment ? `  ${marker} ${line.comment}` : ""}`);
        break;
      case "cpu":
        push(dialect === "64tass" ? '      .cpu "6502"' : "      .cpu _6502");
        break;
      case "origin":
        push(dialect === "64tass" ? `      * = $${hex16(line.address)}` : `      .pc = $${hex16(line.address)} "${line.name ?? "code"}"`);
        break;
      case "relocBegin":
        push(dialect === "64tass" ? `      .logical $${hex16(line.address)}` : `      .pseudopc $${hex16(line.address)} {`);
        depth += 1;
        break;
      case "relocEnd":
        depth = Math.max(0, depth - 1);
        push(dialect === "64tass" ? "      .here" : "      }");
        break;
      case "encoding":
        push(dialect === "64tass" ? '      .enc "none"' : '      .encoding "ascii"');
        break;
      case "text":
        push(`      ${trailing(dialect, `.text "${line.value}"`, line.comment, line.comment ? DEFAULT_COMMENT_COLUMN : 0)}`.trimEnd());
        break;
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * The names a list of lines defines and the expressions it uses — what the equate backstop and
 * the graph-name equates used to read back off finished text with regular expressions.
 */
export interface ListingScan {
  /** Labels and equates, in order. */
  defined: string[];
  /** Operand and argument expressions of instructions and data directives, with the directive that holds them. */
  operands: Array<{ kind: "insn" | "byte" | "word"; text: string }>;
}

export function scanListing(lines: readonly ListingLine[]): ListingScan {
  const defined: string[] = [];
  const operands: ListingScan["operands"] = [];
  for (const line of lines) {
    if (line.k === "label") defined.push(line.name);
    else if (line.k === "equate") defined.push(line.name);
    else if (line.k === "insn" && line.operand) operands.push({ kind: "insn", text: line.operand });
    else if (line.k === "data") operands.push({ kind: line.directive, text: line.args });
  }
  return { defined, operands };
}

/** Instructions and data lines in a list of lines. */
export function countListingLines(lines: readonly ListingLine[]): { instructionCount: number; dataLineCount: number } {
  let instructionCount = 0;
  let dataLineCount = 0;
  for (const line of lines) {
    if (line.k === "insn") instructionCount += 1;
    else if (line.k === "data" || line.k === "text") dataLineCount += 1;
  }
  return { instructionCount, dataLineCount };
}

/** The assembler a dialect is written for, as a person names it. */
export function dialectName(dialect: Dialect): string {
  return dialect === "64tass" ? "64tass" : "KickAssembler";
}

/** The `format` an artifact record of a listing in this dialect carries. */
export function listingFormat(dialect: Dialect): "asm" | "tass" {
  return dialect === "64tass" ? "tass" : "asm";
}

/** Parses a dialect given on a command line; anything else is refused by name. */
export function parseDialect(value: string, flag: string): Dialect {
  if (value === "kickass" || value === "64tass") return value;
  throw new Error(`${flag} ${JSON.stringify(value)} is not a dialect; use kickass or 64tass`);
}
