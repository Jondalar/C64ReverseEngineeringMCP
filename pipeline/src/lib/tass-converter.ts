/**
 * Convert KickAssembler ASM to 64tass format.
 * Pure string transformation — no re-parsing of instructions.
 */
export function convertKickAsmToTass(kickAsm: string): string {
  const lines = kickAsm.split("\n");
  const result: string[] = [];
  let inBlockComment = false;

  for (const line of lines) {
    let converted = line;

    // Block comments: /* ... */ → ; per line
    if (inBlockComment) {
      if (converted.includes("*/")) {
        converted = converted.replace(/\*\/\s*$/, "").replace(/\*\//, "");
        const content = converted.replace(/^\s*\*?\s?/, "");
        result.push(`; ${content}`.trimEnd());
        inBlockComment = false;
        continue;
      }
      const content = converted.replace(/^\s*\*?\s?/, "");
      result.push(`; ${content}`.trimEnd());
      continue;
    }

    // Header: .cpu _6502 → .cpu "6502"
    if (/^\s*\.cpu\s+_6502\s*$/.test(converted)) {
      result.push('      .cpu "6502"');
      continue;
    }

    // PC assignment: .pc = $XXXX "name" → * = $XXXX
    const pcMatch = converted.match(/^\s*\.pc\s*=\s*(\$[0-9A-Fa-f]+)\s*".*?"/);
    if (pcMatch) {
      result.push(`      * = ${pcMatch[1]}`);
      continue;
    }

    // Block comment start (multi-line): line starts with /* (not // containing /*)
    const trimmedForBlock = converted.trimStart();
    if (trimmedForBlock.startsWith("/*") && !converted.includes("*/")) {
      inBlockComment = true;
      const content = trimmedForBlock.replace(/^\/\*\s*/, "");
      result.push(`; ${content}`.trimEnd());
      continue;
    }

    // Single-line block comments: /* ... */ (only when line starts with /* or has standalone /*)
    if (trimmedForBlock.startsWith("/*") || (converted.includes("/*") && !converted.trimStart().startsWith("//"))) {
      converted = converted.replace(/\/\*\s*(.*?)\s*\*\//, "; $1");
    }

    // Line comments: // → ;
    converted = convertLineComment(converted);

    result.push(converted);
  }

  return result.join("\n");
}

function convertLineComment(line: string): string {
  // Find // that's not inside a string literal
  let inString = false;
  let escape = false;

  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString && ch === "/" && line[i + 1] === "/") {
      return line.substring(0, i) + ";" + line.substring(i + 2);
    }
  }

  return line;
}
