// Spec 726.B — DuckDB index builder over the `.c64retrace` binary log.
//
// The binary log is the timeline AUTHORITY; this indexer is a DERIVED query
// projection that can be (re)built at any time, off the emulator hot path. It
// reconstructs exactly the `trace_run` / `trace_event` / `trace_mark` schema the
// shipped readers consume (Spec 726 §6a), so `trace_store_*` /
// `runtime_query_events` work against a rebuilt store with no reader changes.

import { readFileSync } from "node:fs";
import {
  decodeFileHeader, decodeEvent, TraceOp, ACCESS_WRITE, IEC_BIT,
  type DecodedEvent, type TraceFileMeta,
} from "./binary-format.js";
import {
  openTraceRunStore, writeTraceRunHeader, closeTraceRunStore,
  type TraceEventRow,
} from "./trace-run-store.js";
import type { RuntimeTraceDefinition, RuntimeTraceRun } from "./trace-definition.js";

// Flush the DuckDB Appender every N rows to bound its internal buffer.
const APPENDER_FLUSH = 50_000;

/** Translate a decoded binary event into the reader-facing channel + data_json
 *  row. Returns null for MARK (handled separately) and for unknown opcodes. */
function eventToRow(ev: DecodedEvent, seq: number): TraceEventRow | null {
  switch (ev.op) {
    case TraceOp.CPU_STEP:
    case TraceOp.DRIVE_CPU_STEP: {
      const drive = ev.op === TraceOp.DRIVE_CPU_STEP;
      const data: Record<string, unknown> = {
        pc: ev.pc, opcode: ev.opcode, b1: ev.b1, b2: ev.b2,
        a: ev.a, x: ev.x, y: ev.y, sp: ev.sp, p: ev.p,
      };
      if (drive) { data.side = "drive"; data.clk = ev.cycle; }
      return {
        seq, cycle: ev.cycle, channel: drive ? "drive_pc" : "cpu",
        triggerKind: "pc-range", captureKind: "cpu-row", dataJson: JSON.stringify(data),
      };
    }
    case TraceOp.RAM_WRITE:
    case TraceOp.IO_WRITE:
    case TraceOp.DRIVE_RAM_WRITE: {
      const drive = ev.op === TraceOp.DRIVE_RAM_WRITE;
      const op = ev.access === ACCESS_WRITE ? "write" : "read";
      const data: Record<string, unknown> = {
        addr: ev.addr, value: ev.value, op, pc: ev.pc, side: drive ? "drive" : "c64",
      };
      if (drive) data.cycle_drive = ev.cycle; else data.cycle_c64 = ev.cycle;
      return {
        seq, cycle: ev.cycle, channel: ev.op === TraceOp.IO_WRITE ? "io" : "bus_access",
        triggerKind: "mem-access", captureKind: "mem-row", dataJson: JSON.stringify(data),
      };
    }
    case TraceOp.IEC_LINE_CHANGE: {
      const L = ev.lines ?? 0;
      const data = {
        atn: !!(L & IEC_BIT.atn), clk: !!(L & IEC_BIT.clk), data: !!(L & IEC_BIT.data),
        c64_atn: !!(L & IEC_BIT.c64_atn), c64_clk: !!(L & IEC_BIT.c64_clk), c64_data: !!(L & IEC_BIT.c64_data),
        drv_clk: !!(L & IEC_BIT.drv_clk), drv_data: !!(L & IEC_BIT.drv_data), drv_atn_ack: !!(L & IEC_BIT.drv_atn_ack),
      };
      return { seq, cycle: ev.cycle, channel: "iec", triggerKind: "iec-transition", captureKind: "iec-row", dataJson: JSON.stringify(data) };
    }
    case TraceOp.VIC_REG_WRITE:
      return {
        seq, cycle: ev.cycle, channel: "vic", triggerKind: "raster-window", captureKind: "vic-row",
        dataJson: JSON.stringify({ kind: "raster", raster_y: ev.rasterY, value: ev.value }),
      };
    case TraceOp.SID_REG_WRITE:
      return {
        seq, cycle: ev.cycle, channel: "sid", triggerKind: "mem-access", captureKind: "raw",
        dataJson: JSON.stringify({ reg: ev.reg, value: ev.value }),
      };
    default:
      return null; // MARK + reserved/unknown
  }
}

export interface IndexResult {
  runId: string;
  eventCount: number;
  markCount: number;
  channels: number;
  outputPath: string;
}

/** Build (or rebuild) a DuckDB index from a `.c64retrace` file. Idempotent at
 *  the file level: writes a fresh store at `duckdbPath` (caller controls path). */
export async function indexBinaryLog(retracePath: string, duckdbPath: string): Promise<IndexResult> {
  const buf = new Uint8Array(readFileSync(retracePath));
  const { meta, headerLen } = decodeFileHeader(buf);

  const def: RuntimeTraceDefinition = JSON.parse(meta.defJson);
  const store = await openTraceRunStore(duckdbPath);
  try {
    const marks: { cycle: number; label: string }[] = [];
    const channels = new Set<string>();
    let seq = 0;
    let eventCount = 0;
    let lastCycle = meta.cycleStart;
    let off = headerLen;

    // Bulk ingest via the DuckDB Appender (columnar, ~10-30x faster than
    // INSERT VALUES strings). Column order MUST match the trace_event DDL:
    // run_id, seq, cycle, channel, trigger_kind, capture_kind, data_json.
    const appender = await store.conn.createAppender("trace_event");
    let sinceFlush = 0;
    for (;;) {
      const r = decodeEvent(buf, off);
      if (!r) break;
      off = r.next;
      lastCycle = r.ev.cycle;
      if (r.ev.op === TraceOp.MARK) { marks.push({ cycle: r.ev.cycle, label: r.ev.label ?? "" }); continue; }
      const row = eventToRow(r.ev, seq++);
      if (!row) continue;
      channels.add(row.channel);
      appender.appendVarchar(meta.runId);
      appender.appendUBigInt(BigInt(row.seq));
      appender.appendUBigInt(BigInt(Math.trunc(row.cycle)));
      appender.appendVarchar(row.channel);
      appender.appendVarchar(row.triggerKind);
      appender.appendVarchar(row.captureKind);
      appender.appendVarchar(row.dataJson);
      appender.endRow();
      eventCount++;
      if (++sinceFlush >= APPENDER_FLUSH) { appender.flushSync(); sinceFlush = 0; }
    }
    appender.flushSync();
    appender.closeSync();

    const run: RuntimeTraceRun = {
      runId: meta.runId,
      definitionId: meta.defId,
      definitionVersion: meta.defVersion,
      startCheckpointId: meta.startCheckpointId,
      media: meta.mediaSha || meta.mediaName ? { sha256: meta.mediaSha, sourceName: meta.mediaName } : undefined,
      cycleStart: meta.cycleStart,
      cycleEnd: lastCycle,
      marks,
      evidenceRef: duckdbPath,
      eventCount,
      bytesWritten: buf.length,
    };
    await writeTraceRunHeader(store, run, def);
    return { runId: meta.runId, eventCount, markCount: marks.length, channels: channels.size, outputPath: duckdbPath };
  } finally {
    await closeTraceRunStore(store);
  }
}

/** Read just the file header meta (cheap — no event decode). */
export function readBinaryLogMeta(retracePath: string): TraceFileMeta {
  const head = new Uint8Array(readFileSync(retracePath));
  return decodeFileHeader(head).meta;
}
