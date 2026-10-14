// Where a pointer walk may continue when a call leaves the image being rendered.
//
// `disasm` renders one file, but the routine a `jsr` lands in is often resident in ANOTHER
// file of the same project (the resident engine, a loader, a printer). Whether a zero-page pair
// handed to that routine is a pointer is decided by what the routine does with it, so the
// renderer needs that file's bytes. This module lists, from what the project already knows -
// every analysed artifact's effective segments (the address index's source), next to its
// bytes - the files that hold CODE (code segments, and `jmp` jump tables) and the address
// ranges the code covers. The renderer
// (`--callee-catalog`) opens a file only when a walk reaches an address inside one of the
// ranges; nothing is rendered from it. Two files with code at the same address are both
// listed: the renderer treats them as ambiguous when they disagree.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findAnalysisJsons } from "./address-index.js";
import { loadEffectiveSegments } from "./effective-segments.js";

export interface CalleeCatalogEntry {
  owner: string;
  path: string;
  loadAddress: number;
  codeRanges: Array<[number, number]>;
}

function loadAddressOf(prg: string): number | undefined {
  try {
    const fd = openSync(prg, "r");
    try {
      const header = Buffer.alloc(2);
      if (readSync(fd, header, 0, 2, 0) !== 2) return undefined;
      return header[0]! | (header[1]! << 8);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The project's other PRGs that have analysed code, with the ranges that code covers. */
export function buildCalleeCatalog(projectDir: string, sourceAbs: string): CalleeCatalogEntry[] {
  const self = resolve(sourceAbs);
  const entries: CalleeCatalogEntry[] = [];
  for (const analysis of findAnalysisJsons(projectDir)) {
    const stem = basename(analysis).replace(/_analysis\.json$/, "");
    const prg = join(dirname(analysis), `${stem}.prg`);
    if (!existsSync(prg) || resolve(prg) === self) continue;
    const loadAddress = loadAddressOf(prg);
    if (loadAddress === undefined) continue;
    // the name a listing's annotations are saved under, or the one the analysis' own stem implies
    const annotations = [`${stem}_annotations.json`, `${stem}_disasm_annotations.json`]
      .map((name) => join(dirname(analysis), name)).find((candidate) => existsSync(candidate))
      ?? join(dirname(analysis), `${stem}_annotations.json`);
    let segments;
    try { segments = loadEffectiveSegments(analysis, existsSync(annotations) ? annotations : undefined).segments; } catch { continue; }
    const last = loadAddress + Math.max(0, statSync(prg).size - 2) - 1;
    const codeRanges = segments
      .filter((segment) => segment.kind === "code")
      .map((segment): [number, number] => [Math.max(segment.start, loadAddress), Math.min(segment.end, last)])
      .filter(([from, to]) => from <= to);
    // A `jumpTables` row of kind `jmp` is a run of JMP instructions (an engine's API vectors):
    // executable, though the segment pass files it as data.
    if (existsSync(annotations)) {
      try {
        const doc = JSON.parse(readFileSync(annotations, "utf8")) as { jumpTables?: Array<{ start?: string | number; end?: string | number; kind?: string }> };
        for (const table of doc.jumpTables ?? []) {
          if (table.kind !== "jmp") continue;
          const toNumber = (v: string | number | undefined): number => (typeof v === "number" ? v : Number.parseInt(String(v ?? "").replace(/^\$|^0x/i, ""), 16));
          const from = Math.max(toNumber(table.start), loadAddress);
          const to = Math.min(toNumber(table.end), last);
          if (Number.isFinite(from) && Number.isFinite(to) && from <= to) codeRanges.push([from, to]);
        }
      } catch { /* a broken annotations file adds no ranges; the renderer reports it */ }
    }
    if (codeRanges.length === 0) continue;
    entries.push({ owner: stem, path: prg, loadAddress, codeRanges });
  }
  return entries;
}
