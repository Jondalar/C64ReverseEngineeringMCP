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

// ── Plain-text (TUI) renderer ─────────────────────────────────────────────────
// For the interactive monitor console (Spec 754): NO markdown pipes, columns
// space-aligned, and a lane is shown ONLY if it carries data in the window
// (drive/IEC/IO/flow columns vanish when idle). Empty filler rows are dropped.
export function renderText(slice: SwimlaneSlice, opts: RenderMarkdownOpts = {}): string {
  const maxRows = opts.maxRows ?? 200;
  type Cells = { cycle: string; c64: string; flow: string; io: string; bus: string; drv: string; dio: string };
  const all: Cells[] = slice.rows.map((row) => ({
    cycle: String(row.cycle),
    c64: (row.c64Pc !== undefined ? hex(row.c64Pc) : "") + (row.c64Op ? " " + row.c64Op : ""),
    flow: row.c64Flow ?? "",
    io: fmtIo(row.c64IoRw, row.c64IoAddr, row.c64IoValue),
    bus: fmtBus(row.busAtn, row.busClk, row.busData),
    drv: (row.drvPc !== undefined ? hex(row.drvPc) : "") + (row.drvOp ? " " + row.drvOp : ""),
    dio: fmtIo(row.drvIoRw, row.drvIoAddr, row.drvIoValue),
  })).filter((c) => c.c64 || c.io || c.bus || c.drv || c.dio); // drop empty filler rows
  const shown = all.slice(0, maxRows);
  const truncated = all.length > maxRows;
  if (!shown.length) return `swimlane ${slice.startCycle}–${slice.endCycle}: (no events in window)`;
  const has = (k: keyof Cells) => shown.some((c) => c[k] !== "" && !(k === "flow" && c[k] === "main"));
  const cols: { key: keyof Cells; head: string }[] = [{ key: "cycle", head: "cycle" }, { key: "c64", head: "c64" }];
  if (has("flow")) cols.push({ key: "flow", head: "flow" });
  if (has("io")) cols.push({ key: "io", head: "io" });
  if (has("bus")) cols.push({ key: "bus", head: "iec" });
  if (has("drv")) cols.push({ key: "drv", head: "1541" });
  if (has("dio")) cols.push({ key: "dio", head: "drv_io" });
  const w: Record<string, number> = {};
  for (const c of cols) w[c.key] = Math.max(c.head.length, ...shown.map((r) => r[c.key].length), 1);
  const line = (get: (k: keyof Cells) => string) => cols.map((c) => get(c.key).padEnd(w[c.key]!)).join("  ").trimEnd();
  const lines = [
    `swimlane ${slice.startCycle}–${slice.endCycle}${slice.compact ? " (compact)" : ""}  ${shown.length}${truncated ? "/" + all.length : ""} rows`,
    line((k) => cols.find((c) => c.key === k)!.head),
  ];
  for (const r of shown) lines.push(line((k) => r[k]));
  if (truncated) lines.push(`… ${all.length - maxRows} more — narrow with \`swimlane <s> <e>\``);
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
