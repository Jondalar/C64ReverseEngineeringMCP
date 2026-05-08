// Spec 249 — Bidirectional .asm / .tass sync helpers.
//
// parseAsmFile:  extract labels + inline comments from an existing
//                disassembly file produced by prg-disasm.ts so
//                annotation-suggestion code can treat them as ground-truth.
//
// emitToAsmFile: incremental patch — adds new label declarations,
//                inline comments, and routine description blocks at the
//                correct line positions without touching the rest of the
//                file.  Preserves human spacing/comments elsewhere.
//
// The "AST" is intentionally lightweight: only the structure needed for
// the two operations above.  No full 6502 grammar required.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ---- Public types -------------------------------------------------------

export interface AsmLabel {
  name: string;
  address: number;          // parsed from trailing comment "  ; $XXXX"
  lineIndex: number;        // 0-based line in the file
}

export interface AsmInlineComment {
  lineIndex: number;
  text: string;             // everything after the "; " on that line
}

export interface AsmRoutineBlock {
  address: number;
  name: string;
  descriptionLines: string[]; // the block-comment lines above the label
  labelLineIndex: number;
}

export interface AsmAst {
  /** All label lines found, keyed by address (last definition wins) */
  labels: Map<number, AsmLabel>;
  /** Inline comments keyed by line index */
  comments: Map<number, AsmInlineComment>;
  /** Routine blocks (label preceded by a ";------" banner) */
  routines: AsmRoutineBlock[];
  /** Raw lines — mutated by emitToAsmFile */
  lines: string[];
}

export interface AsmAdditions {
  /** New labels to insert.  key = address, value = label name */
  newLabels: Map<number, string>;
  /** New inline comments to append.  key = address, value = comment text */
  newComments: Map<number, string>;
  /** New routine doc blocks to insert above the label line */
  newRoutineDocs: Array<{ address: number; name: string; description: string }>;
}

// ---- Address extraction helpers -----------------------------------------

// KickAsm output: "label:              ; $ABCD  …"
// 64tass output:  "label               ; $ABCD  …"
// The address in the trailing comment is the canonical anchor.
const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*):\s*(?:;.*\$([0-9A-Fa-f]{4}))?/;
const ADDR_COMMENT_RE = /;\s*\$([0-9A-Fa-f]{4})/;
// Auto-label pattern emitted by this module
const AUTO_LABEL_PREFIX = "_auto_";

function parseLineAddress(line: string): number | undefined {
  const m = line.match(ADDR_COMMENT_RE);
  if (m) return parseInt(m[1], 16);
  return undefined;
}

function isLabelLine(line: string): string | undefined {
  const m = line.match(/^([A-Za-z_!.][A-Za-z0-9_]*):/);
  if (m) return m[1];
  return undefined;
}

function isRoutineBanner(line: string): boolean {
  return /^;\s*-{6,}/.test(line) || /^;\s*={6,}/.test(line);
}

// ---- parseAsmFile -------------------------------------------------------

export function parseAsmFile(filePath: string): AsmAst {
  const labels = new Map<number, AsmLabel>();
  const comments = new Map<number, AsmInlineComment>();
  const routines: AsmRoutineBlock[] = [];
  const lines: string[] = [];

  if (!existsSync(filePath)) {
    return { labels, comments, routines, lines };
  }

  const raw = readFileSync(filePath, "utf8");
  const rawLines = raw.split("\n");
  // Preserve trailing newline behaviour: if last line is empty it came
  // from the trailing \n — keep it so round-trips stay identical.
  for (const l of rawLines) lines.push(l);

  let pendingBannerStart = -1;
  let pendingBannerLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Collect banner comment blocks
    if (isRoutineBanner(trimmed)) {
      pendingBannerStart = i;
      pendingBannerLines = [line];
      continue;
    }
    if (pendingBannerStart >= 0 && trimmed.startsWith(";")) {
      pendingBannerLines.push(line);
      continue;
    }

    // Label line
    const labelName = isLabelLine(trimmed);
    if (labelName) {
      const addr = parseLineAddress(line);
      if (addr !== undefined) {
        const entry: AsmLabel = { name: labelName, address: addr, lineIndex: i };
        labels.set(addr, entry);

        if (pendingBannerStart >= 0 && pendingBannerLines.length > 0) {
          routines.push({
            address: addr,
            name: labelName,
            descriptionLines: [...pendingBannerLines],
            labelLineIndex: i,
          });
        }
      }
      pendingBannerStart = -1;
      pendingBannerLines = [];
      continue;
    }

    // Inline comment on instruction lines
    const semiIdx = line.indexOf(";");
    if (semiIdx >= 0) {
      const commentText = line.slice(semiIdx + 1).trim();
      if (commentText) {
        comments.set(i, { lineIndex: i, text: commentText });
      }
    }

    // Reset banner accumulation if we hit a non-comment non-label line
    if (!trimmed.startsWith(";")) {
      pendingBannerStart = -1;
      pendingBannerLines = [];
    }
  }

  return { labels, comments, routines, lines };
}

// ---- emitToAsmFile ------------------------------------------------------

// Find line index in AST where address first appears (via address-comment).
// Returns -1 if not found.
function findLineForAddress(lines: string[], addr: number): number {
  const needle = `$${addr.toString(16).toUpperCase().padStart(4, "0")}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

/**
 * Incrementally patch `filePath` with new labels, inline comments, and
 * routine doc blocks.  Lines that already carry the address are left
 * unchanged (ground-truth guard).  New label lines are inserted
 * immediately before the instruction line at that address.
 *
 * Returns the number of additions actually written.
 */
export function emitToAsmFile(filePath: string, additions: AsmAdditions): number {
  if (!existsSync(filePath)) return 0;

  const ast = parseAsmFile(filePath);
  const lines = [...ast.lines]; // working copy
  let written = 0;

  // Build set of already-known addresses (ground-truth guard)
  const knownAddresses = new Set(ast.labels.keys());

  // --- 1. Routine doc blocks (insert above label line) ---
  // Process in reverse-address order so insertions don't shift indices.
  const sortedRoutineDocs = [...additions.newRoutineDocs].sort((a, b) => b.address - a.address);
  for (const doc of sortedRoutineDocs) {
    if (knownAddresses.has(doc.address)) continue; // ground-truth guard
    const lineIdx = findLineForAddress(lines, doc.address);
    if (lineIdx < 0) continue;
    const banner = [
      `; ${"=".repeat(60)}`,
      `; Routine: ${doc.name} (auto)`,
      `; ${doc.description}`,
      `; ${"=".repeat(60)}`,
    ];
    lines.splice(lineIdx, 0, ...banner);
    written += banner.length;
  }

  // Re-parse after routine block insertions to get updated line numbers
  const ast2 = { ...parseAsmFile(filePath), lines };

  // --- 2. New label declarations ---
  const sortedLabels = [...additions.newLabels.entries()].sort((a, b) => b[0] - a[0]);
  for (const [addr, name] of sortedLabels) {
    if (knownAddresses.has(addr)) continue;
    const autoName = name.startsWith(AUTO_LABEL_PREFIX) ? name : `${AUTO_LABEL_PREFIX}${name}`;
    const lineIdx = findLineForAddress(lines, addr);
    if (lineIdx < 0) continue;
    const addrHex = `$${addr.toString(16).toUpperCase().padStart(4, "0")}`;
    lines.splice(lineIdx, 0, `${autoName}:                          ; ${addrHex}  (auto)`);
    written++;
  }

  // --- 3. Inline comments ---
  // Re-resolve line positions (insertions shifted everything).
  for (const [addr, commentText] of additions.newComments.entries()) {
    if (knownAddresses.has(addr)) continue;
    const lineIdx = findLineForAddress(lines, addr);
    if (lineIdx < 0) continue;
    // Only append if the line doesn't already carry this comment.
    if (lines[lineIdx].includes(commentText)) continue;
    const existing = lines[lineIdx];
    const semiIdx = existing.indexOf(";");
    if (semiIdx >= 0) {
      // Append after existing comment
      lines[lineIdx] = `${existing} | ${commentText}`;
    } else {
      // Pad to column 40 and add comment
      lines[lineIdx] = `${existing.padEnd(40)}; ${commentText}`;
    }
    written++;
  }

  void ast2; // used for type-check only
  writeFileSync(filePath, lines.join("\n"), "utf8");
  return written;
}
