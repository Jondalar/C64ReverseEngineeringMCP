// Spec 726.B — DuckDB index builder over the `.c64retrace` binary log.
//
// The binary log is the timeline AUTHORITY; this indexer is a DERIVED query
// projection that can be (re)built at any time, off the emulator hot path. It
// reconstructs exactly the `trace_run` / `trace_event` / `trace_mark` schema the
// shipped readers consume (Spec 726 §6a), so `trace_store_*` /
// `runtime_query_events` work against a rebuilt store with no reader changes.

import { renameSync, unlinkSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
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

// Spec 746.x — STREAMING decode. The .c64retrace must NOT be read whole into one
// Buffer: Node's readFileSync throws ERR_FS_FILE_TOO_LARGE past 2 GiB, so a long
// trace (multi-GB firehose) could never be indexed. Instead read in bounded
// windows and carry the undecoded tail (an event may straddle a window boundary)
// into the next window.
// header (defJson + meta) is KB; 16 MiB is ample. Env-overridable (floored above
// any real header) so a test can force the streaming window loop on a small fixture.
const INDEX_HEADER_MAX = Math.max(4096, Number(process.env.C64RE_INDEX_HEADER_BYTES) || 16 * 1024 * 1024);
const MAX_EVENT_BYTES = 4096;                  // largest single encoded event (mark label-bounded) → carry guard
// Window size, overridable (tests force a tiny window to exercise cross-boundary
// decode without a 2 GiB fixture). Floored well above one event.
const INDEX_WINDOW_BYTES = Math.max(
  64 * 1024,
  Number(process.env.C64RE_INDEX_WINDOW_BYTES) || 256 * 1024 * 1024,
);

/** readSync that fills `length` bytes at `bufOffset` (looping past short reads),
 *  returning the count actually read (< length only at EOF). */
function readFullSync(fd: number, buf: Buffer, bufOffset: number, length: number, position: number): number {
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, bufOffset + read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

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
      if (ev.oldValue !== undefined) data.oldValue = ev.oldValue; // Spec 753 — mutation surface
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
 *  the file level: writes a fresh store at `duckdbPath` (caller controls path).
 *
 *  Spec 746.x — `runOverrides` carries STOP-time run fields that the `.c64retrace`
 *  header (written at START) cannot know: notably `stopCheckpointId` (the at-stop
 *  checkpoint policy) and `overheadMs`. Without it the persisted DuckDB run header
 *  silently drops them on the binary path (the now-default path), so e.g. an
 *  at-stop checkpoint id is lost. Merged last so the live run is authoritative. */
export async function indexBinaryLog(
  retracePath: string,
  duckdbPath: string,
  runOverrides?: Partial<RuntimeTraceRun>,
): Promise<IndexResult> {
  const fd = openSync(retracePath, "r");
  let meta: TraceFileMeta, headerLen: number, def: RuntimeTraceDefinition, size: number, seedCarry: Uint8Array;
  let fmtVersion: number;
  try {
    size = fstatSync(fd).size;
    const hn = Math.min(size, INDEX_HEADER_MAX);
    const hbuf = Buffer.allocUnsafe(hn);
    readFullSync(fd, hbuf, 0, hn, 0);
    const hu8 = new Uint8Array(hbuf.buffer, hbuf.byteOffset, hn);
    // BUG-035 — keep the header version; v1 mem-access records decode 1 byte
    // shorter than v2, so every decodeEvent below must be told the version.
    ({ meta, headerLen, version: fmtVersion } = decodeFileHeader(hu8));
    def = JSON.parse(meta.defJson);
    // Events already read into the header window seed the event stream (copy out
    // before hbuf is dropped).
    seedCarry = hu8.slice(headerLen, hn);
  } catch (e) { closeSync(fd); throw e; }

  // Spec 746.x — build into a TEMP file in the same directory and atomically
  // rename onto the final path only after a fully successful build. This makes
  // the final .duckdb crash-safe + complete for EVERY reader (UI / MCP /
  // workspace-ui HTTP), regardless of routing or awaitIndex: a concurrent open of
  // duckdbPath while we index sees the previous complete store (or nothing) —
  // never the half-written/exclusively-locked store the index worker holds (which
  // is the temp file). A failed/partial build is unlinked, never published.
  const tmpPath = `${duckdbPath}.idx-${process.pid}-${Date.now()}.tmp`;
  const store = await openTraceRunStore(tmpPath);
  let result: IndexResult;
  try {
    const marks: { cycle: number; label: string }[] = [];
    const channels = new Set<string>();
    let seq = 0;
    let eventCount = 0;
    let lastCycle = meta.cycleStart;

    // Bulk ingest via the DuckDB Appender (columnar, ~10-30x faster than
    // INSERT VALUES strings). Column order MUST match the trace_event DDL:
    // run_id, seq, cycle, channel, trigger_kind, capture_kind, data_json.
    const appender = await store.conn.createAppender("trace_event");
    let sinceFlush = 0;
    const onEvent = (ev: DecodedEvent): void => {
      lastCycle = ev.cycle;
      if (ev.op === TraceOp.MARK) { marks.push({ cycle: ev.cycle, label: ev.label ?? "" }); return; }
      const row = eventToRow(ev, seq++);
      if (!row) return;
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
    };

    // Streaming window loop: prepend the carried tail into the read buffer, read
    // the next window after it, decode complete events, carry the remainder.
    const chunkBuf = Buffer.allocUnsafe(INDEX_WINDOW_BYTES);
    let carry = seedCarry;
    let filePos = Math.min(size, INDEX_HEADER_MAX);
    for (;;) {
      if (carry.length > 0) chunkBuf.set(carry, 0);
      const space = INDEX_WINDOW_BYTES - carry.length;
      const toRead = Math.min(space, size - filePos);
      let got = 0;
      if (toRead > 0) { got = readFullSync(fd, chunkBuf, carry.length, toRead, filePos); filePos += got; }
      const windowLen = carry.length + got;
      if (windowLen === 0) break;
      const window = new Uint8Array(chunkBuf.buffer, chunkBuf.byteOffset, windowLen);
      let off = 0;
      for (;;) {
        const r = decodeEvent(window, off, fmtVersion);
        if (!r) break;
        onEvent(r.ev);
        off = r.next;
      }
      const tail = window.subarray(off).slice(); // copy — chunkBuf is reused next window
      if (filePos >= size) break; // EOF: any tail left is a truncated final event (aborted trace) → drop
      if (tail.length > MAX_EVENT_BYTES) {
        throw new Error(`trace index: ${tail.length} undecodable bytes near offset ${filePos} of ${retracePath} (corrupt .c64retrace?)`);
      }
      carry = tail;
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
      bytesWritten: size,
      ...runOverrides,
    };
    await writeTraceRunHeader(store, run, def);
    result = { runId: meta.runId, eventCount, markCount: marks.length, channels: channels.size, outputPath: duckdbPath };
  } catch (e) {
    // Close + delete the temp store so a failed build never becomes the visible
    // store (the .c64retrace remains the authority and is re-indexable).
    closeSync(fd);
    await closeTraceRunStore(store).catch(() => {});
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
    throw e;
  }
  // Release the handles, THEN atomically publish (rename replaces any prior store
  // in one syscall — no window where duckdbPath is partial or missing-table).
  closeSync(fd);
  await closeTraceRunStore(store);
  renameSync(tmpPath, duckdbPath);
  return result;
}

/** Read just the file header meta — only the leading bytes, never the whole log
 *  (a multi-GB .c64retrace would exceed readFileSync's 2 GiB cap). */
export function readBinaryLogMeta(retracePath: string): TraceFileMeta {
  const fd = openSync(retracePath, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, INDEX_HEADER_MAX);
    const b = Buffer.allocUnsafe(n);
    readFullSync(fd, b, 0, n, 0);
    return decodeFileHeader(new Uint8Array(b.buffer, b.byteOffset, n)).meta;
  } finally {
    closeSync(fd);
  }
}
