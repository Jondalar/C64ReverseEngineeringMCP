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
// space-aligned, a lane is shown ONLY if it carries data (drive/IEC/IO/flow
// vanish when idle), empty filler rows dropped, and consecutive loop iterations
// are FOLDED (body once + `↺×N`).
//
// Fold rules (the cycle-accurate-stream subtleties, per the user):
//  - FLOW-SCOPED: the fold key includes the flow lane (main/irq/nmi) + the c64
//    and drive PC/op "shape" — NOT the IO/bus values (those are the varying part).
//  - INTERRUPT-FENCED: because flow is in the key, an IRQ/NMI block in the middle
//    of a main loop breaks the fold automatically → you SEE when the IRQ hit.
//  - VARIATION KEPT: a polling loop (same PCs, different read each pass) folds the
//    body once and summarises the varying IO cell as a range (`$D012 r=9D..A2`),
//    so the exit condition isn't silently swallowed.
type Cells = { cycle: string; c64: string; flow: string; io: string; bus: string; drv: string; dio: string };

/** Merge one body-row position across its iterations: shape stays, varying
 *  IO/bus cells become a range/summary. */
function summarizeCell(vals: string[]): string {
  const distinct = [...new Set(vals.filter((v) => v !== ""))];
  if (distinct.length <= 1) return distinct[0] ?? "";
  // `$ADDR rw=VAL` sharing the same `$ADDR rw=` prefix → collapse to MIN..MAX.
  const m = distinct.map((s) => s.match(/^(\$[0-9A-F]+ [rw]=)([0-9A-F]+)$/));
  if (m.every((x) => x) && new Set(m.map((x) => x![1])).size === 1) {
    const vs = m.map((x) => parseInt(x![2], 16));
    const lo = Math.min(...vs).toString(16).toUpperCase().padStart(2, "0");
    const hi = Math.max(...vs).toString(16).toUpperCase().padStart(2, "0");
    return `${m[0]![1]}${lo}..${hi}`;
  }
  return `${distinct[0]} …`;
}

interface FoldGroup { reps: number; body: Cells[]; }
function foldCells(all: Cells[], maxPeriod = 64): (Cells | FoldGroup)[] {
  const key = (c: Cells) => `${c.flow}${c.c64}${c.drv}`; // shape only
  const out: (Cells | FoldGroup)[] = [];
  let i = 0;
  while (i < all.length) {
    let found: { L: number; reps: number } | null = null;
    const maxL = Math.min(maxPeriod, Math.floor((all.length - i) / 2));
    for (let L = 1; L <= maxL; L++) {
      let reps = 1;
      for (;;) {
        let match = true;
        for (let k = 0; k < L; k++) {
          if (i + reps * L + k >= all.length || key(all[i + k]!) !== key(all[i + reps * L + k]!)) { match = false; break; }
        }
        if (!match) break;
        reps++;
      }
      if (reps >= 2 && L * reps >= 3) { found = { L, reps }; break; } // smallest period wins
    }
    if (found) {
      const { L, reps } = found;
      const body: Cells[] = [];
      for (let k = 0; k < L; k++) {
        const variants = Array.from({ length: reps }, (_, r) => all[i + r * L + k]!);
        body.push({
          ...variants[0]!,
          io: summarizeCell(variants.map((v) => v.io)),
          bus: summarizeCell(variants.map((v) => v.bus)),
          dio: summarizeCell(variants.map((v) => v.dio)),
        });
      }
      out.push({ reps, body });
      i += L * reps;
    } else {
      out.push(all[i]!); i++;
    }
  }
  return out;
}

export interface RenderTextOpts extends RenderMarkdownOpts { fold?: boolean; }

export function renderText(slice: SwimlaneSlice, opts: RenderTextOpts = {}): string {
  const maxRows = opts.maxRows ?? 200;
  const all: Cells[] = slice.rows.map((row) => ({
    cycle: String(row.cycle),
    c64: (row.c64Pc !== undefined ? hex(row.c64Pc) : "") + (row.c64Op ? " " + row.c64Op : ""),
    flow: row.c64Flow ?? "",
    io: fmtIo(row.c64IoRw, row.c64IoAddr, row.c64IoValue),
    bus: fmtBus(row.busAtn, row.busClk, row.busData),
    drv: (row.drvPc !== undefined ? hex(row.drvPc) : "") + (row.drvOp ? " " + row.drvOp : ""),
    dio: fmtIo(row.drvIoRw, row.drvIoAddr, row.drvIoValue),
  })).filter((c) => c.c64 || c.io || c.bus || c.drv || c.dio); // drop empty filler rows

  const items = (opts.fold === false) ? all.map((c) => c as Cells | FoldGroup) : foldCells(all);
  // Expand to render-rows; a fold group's first body row carries the `↺×N` tag.
  const rr: { c: Cells; tag?: string }[] = [];
  for (const it of items) {
    if ("reps" in it) it.body.forEach((c, idx) => rr.push({ c, tag: idx === 0 ? `↺×${it.reps}` : undefined }));
    else rr.push({ c: it });
  }
  const shown = rr.slice(0, maxRows);
  const truncated = rr.length > maxRows;
  if (!shown.length) return `swimlane ${slice.startCycle}–${slice.endCycle}: (no events in window)`;

  const has = (k: keyof Cells) => shown.some((r) => r.c[k] !== "" && !(k === "flow" && r.c[k] === "main"));
  const cols: { key: keyof Cells; head: string }[] = [{ key: "cycle", head: "cycle" }, { key: "c64", head: "c64" }];
  if (has("flow")) cols.push({ key: "flow", head: "flow" });
  if (has("io")) cols.push({ key: "io", head: "io" });
  if (has("bus")) cols.push({ key: "bus", head: "iec" });
  if (has("drv")) cols.push({ key: "drv", head: "1541" });
  if (has("dio")) cols.push({ key: "dio", head: "drv_io" });
  const w: Record<string, number> = {};
  for (const c of cols) w[c.key] = Math.max(c.head.length, ...shown.map((r) => r.c[c.key].length), 1);
  const fmtRow = (get: (k: keyof Cells) => string, tag?: string) =>
    (cols.map((c) => get(c.key).padEnd(w[c.key]!)).join("  ") + (tag ? "  " + tag : "")).trimEnd();

  const lines = [
    `swimlane ${slice.startCycle}–${slice.endCycle}${slice.compact ? " (compact)" : ""}  ${shown.length} rows (${all.length} raw)`,
    fmtRow((k) => cols.find((c) => c.key === k)!.head),
  ];
  for (const r of shown) lines.push(fmtRow((k) => r.c[k], r.tag));
  if (truncated) lines.push(`… ${rr.length - maxRows} more rows — narrow with \`swimlane <s> <e>\``);
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
