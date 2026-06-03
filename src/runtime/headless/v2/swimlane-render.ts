// Spec 234 — Swimlane renderers.
//
// renderMarkdown: Markdown table (≤200 rows by default).
// renderJsonl:    Newline-separated JSON, one object per row.

import type { SwimlaneSlice, SwimlaneRow } from "./swimlane.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function hex(v: number, w = 4): string {
  return "$" + v.toString(16).toUpperCase().padStart(w, "0");
}

function fmtIo(rw: "r" | "w" | undefined, addr: number | undefined, value: number | undefined): string {
  if (rw === undefined || addr === undefined) return "";
  const val = value !== undefined ? value.toString(16).toUpperCase().padStart(2, "0") : "??";
  return `${hex(addr)} ${rw}=${val}`;
}

function fmtBus(atn: 0 | 1 | undefined, clk: 0 | 1 | undefined, data: 0 | 1 | undefined): string {
  if (atn === undefined && clk === undefined && data === undefined) return "";
  const a = atn !== undefined ? String(atn) : "-";
  const c = clk !== undefined ? String(clk) : "-";
  const d = data !== undefined ? String(data) : "-";
  return `A${a}C${c}D${d}`;
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export interface RenderMarkdownOpts {
  maxRows?: number;
}

export function renderMarkdown(slice: SwimlaneSlice, opts: RenderMarkdownOpts = {}): string {
  const maxRows = opts.maxRows ?? 200;
  const rows = slice.rows.slice(0, maxRows);
  const truncated = slice.rows.length > maxRows;

  const lines: string[] = [];

  lines.push(
    `# Swimlane ${slice.startCycle}–${slice.endCycle}` +
    (slice.compact ? " (compact)" : " (full)"),
  );
  lines.push("");
  lines.push(
    `| cycle | c64_pc | c64_op | flow | c64_io | bus | drv_pc | drv_op | drv_io |`,
  );
  lines.push(`|------:|-------:|--------|------|--------|-----|-------:|--------|--------|`);

  for (const row of rows) {
    const c64Pc  = row.c64Pc  !== undefined ? hex(row.c64Pc)  : "";
    const c64Op  = row.c64Op  ?? "";
    const flow   = row.c64Flow ?? "";
    const c64Io  = fmtIo(row.c64IoRw, row.c64IoAddr, row.c64IoValue);
    const bus    = fmtBus(row.busAtn, row.busClk, row.busData);
    const drvPc  = row.drvPc  !== undefined ? hex(row.drvPc)  : "";
    const drvOp  = row.drvOp  ?? "";
    const drvIo  = fmtIo(row.drvIoRw, row.drvIoAddr, row.drvIoValue);

    lines.push(`| ${row.cycle} | ${c64Pc} | ${c64Op} | ${flow} | ${c64Io} | ${bus} | ${drvPc} | ${drvOp} | ${drvIo} |`);
  }

  if (truncated) {
    lines.push("");
    lines.push(`> _Truncated: showing ${maxRows} of ${slice.rows.length} rows._`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── JSONL renderer ────────────────────────────────────────────────────────────

export function renderJsonl(slice: SwimlaneSlice): string {
  // Header row with slice metadata.
  const header = JSON.stringify({
    _type: "swimlane_header",
    startCycle: slice.startCycle,
    endCycle: slice.endCycle,
    compact: slice.compact,
    rowCount: slice.rows.length,
  });

  const rowLines = slice.rows.map((row) => JSON.stringify(row));
  return [header, ...rowLines].join("\n");
}
