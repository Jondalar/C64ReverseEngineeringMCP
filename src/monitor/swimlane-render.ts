// Spec 234 — swimlane markdown renderer (Spec 806 step 3: moved out of the TS
// emulator, which is gone).
//
// The SLICE comes from the runtime (`trace/read op=swimlane`, Spec 802); this is
// only the formatter `runtime_swimlane_slice` puts around it. Formatting a remote
// result is not a second reader, which is why it survives the emulator: the row
// shape below is the wire shape, not an emulator type.
//
// The runtime has its own swimlane text renderer (`swimlane_text`), but it emits
// the FOLDED TUI format the interactive monitor uses — not this markdown table.
// Routing the tool there would change its output, so the table stays here.
//
// The sibling `renderText` (folded TUI) and `renderJsonl` renderers went with the
// emulator: their only callers were the TS monitor's ws-server and its e2e.

import type { FlowKind } from "../analysis/flow-focus.js";

/** One joined cycle row: C64 lane + IEC bus + drive lane. The shape the runtime
 *  returns for `trace/read op=swimlane`. */
export interface SwimlaneRow {
  cycle: number;
  c64Pc?: number;
  /** mnemonic + operand, e.g. "LDA $D011" */
  c64Op?: string;
  /** Spec 746.13 — derived execution-context lane for this C64 step. */
  c64Flow?: FlowKind;
  c64IoRw?: "r" | "w";
  c64IoAddr?: number;
  c64IoValue?: number;
  busAtn?: 0 | 1;
  busClk?: 0 | 1;
  busData?: 0 | 1;
  drvPc?: number;
  drvOp?: string;
  drvIoRw?: "r" | "w";
  drvIoAddr?: number;
  drvIoValue?: number;
}

export interface SwimlaneSlice {
  startCycle: number;
  endCycle: number;
  rows: SwimlaneRow[];
  compact: boolean;
}

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
