// Spec 899 — how the offsets, the series and a sweep read in a report. One place, so the
// tool and `c64re scenario run` say the same thing the same way.

import type { InputRecord } from "./input-offset.js";
import type { SeriesResult } from "./run-sandbox.js";
import type { SweepResult } from "./sweep.js";

const hex2 = (v: number): string => v.toString(16).padStart(2, "0").toUpperCase();

/** The offset every input step used — what a failing run is replayed from. */
export function formatInputs(inputs: readonly InputRecord[]): string[] {
  if (inputs.length === 0) return [];
  return [
    "input offsets (cycles past the point each step would have pressed at — give the same input_offset_cycles or jitter_seed to replay exactly):",
    ...inputs.map((i) =>
      `  step ${String(i.step).padEnd(3)} +${String(i.offset).padEnd(6)} pressed at cycle ${i.pressAt}` +
      (i.releaseAt === undefined ? "" : `, released at ${i.releaseAt}`) + `   ${i.text}`),
  ];
}

/** A series as a table: one column per sampled range, only the rows where something changed. */
export function formatSeries(s: SeriesResult): string[] {
  const head = s.reads.map((r) => r.label);
  const widths = s.reads.map((r, k) => Math.max(head[k].length, r.len * 3 - 1));
  const lines = [
    `series: ${s.reads.map((r) => r.label).join(", ")} — ${s.frames} frames` +
      (s.everyFrames > 1 ? `, every ${s.everyFrames}` : "") +
      `, sampled at raster line ${s.line}; ${s.samples} samples, ${s.rows.length} of them rows (${s.rows.length <= 1 ? "nothing changed" : `${s.rows.length - 1} change${s.rows.length === 2 ? "" : "s"}`})`,
    `  ${"frame".padEnd(6)} ${"cycle".padEnd(10)} ${"line".padEnd(5)} ${"cyc".padEnd(4)} ${head.map((h, k) => h.padEnd(widths[k])).join("  ")}`,
  ];
  for (const r of s.rows) {
    let off = 0;
    const cells = s.reads.map((rd, k) => {
      const cell = r.bytes.slice(off, off + rd.len).map(hex2).join(" ");
      off += rd.len;
      return cell.padEnd(widths[k]);
    });
    lines.push(
      `  ${String(r.frame).padEnd(6)} ${String(r.c64Cycles).padEnd(10)} ${String(r.line).padEnd(5)} ${String(r.cycle).padEnd(4)} ${cells.join("  ")}` +
      (r.seenFrame !== undefined && r.seenFrame !== r.frame ? `   (first seen in frame ${r.seenFrame})` : ""),
    );
  }
  if (s.stopped) lines.push(`  STOPPED at frame ${s.stopped.frame}: ${s.stopped.kind} at PC $${s.stopped.pc.toString(16).toUpperCase()} — the series ends here, the machine stays there`);
  return lines;
}

/** One line per offset, then where to replay from. */
export function formatSweep(w: SweepResult): string[] {
  const lines = [
    `SWEEP — ${w.count} runs, one private machine each, input at ${w.count} places across one ${w.machine.model} frame (${w.cyclesPerFrame} cycles)`,
    `${w.pass} pass, ${w.fail} fail${w.error ? `, ${w.error} error` : ""}`,
  ];
  for (const r of w.runs) {
    const bad = r.checks.filter((c) => !c.pass);
    lines.push(
      `  offset ${String(r.offset).padEnd(6)} ${r.verdict}` +
      (r.verdict === "PASS" ? "" : r.error ? `  ${r.error}` : bad.map((c) => `\n      ${c.stopped ? "UNDECIDED" : "FAIL"}  ${c.text} — ${c.actual}`).join("")),
    );
  }
  if (w.firstFailing !== undefined) {
    lines.push(`first failing offset: ${w.firstFailing} cycles — run it again with input_offset_cycles: ${w.firstFailing} (the same steps, the same press, the same result)`);
  } else if (w.error === 0) {
    lines.push("no offset failed");
  }
  return lines;
}
