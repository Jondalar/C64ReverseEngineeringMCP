// Spec 726.B — main-thread binary trace log writer.
//
// The emulator thread calls the synchronous append* methods to fill a
// preallocated ArrayBuffer (no await, no disk, no JSON, no SQL — §2c). When a
// chunk fills it is flipped into a pending-send list and a fresh buffer is taken
// from the free pool. `drain()` (called only at the paused chunk boundary)
// transfers filled chunks to the writer Worker and applies backpressure: if the
// Worker's in-flight queue is too deep it awaits `free` returns. This is the
// ONLY backpressure point (§2b rule 6) and it never runs while the emulator
// steps, so it cannot influence emulation. Events are NEVER dropped.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  TraceOp, encodeCpuStep, encodeMemAccess, encodeIecLine, encodeVicEvent,
  encodeSidWrite, encodeMark, encodeFileHeader, type TraceFileMeta,
} from "./binary-format.js";

const CHUNK_BYTES = 1 << 20;        // 1 MiB transport chunk
const POOL_TARGET = 4;              // preallocated reusable buffers
const INFLIGHT_HIGH_WATER = 8;      // backpressure: await `free` past this many chunks in the Worker

function workerScriptPath(): string {
  // dist/runtime/headless/trace/binary-log-writer.js → binary-log-worker.js
  return resolvePath(fileURLToPath(import.meta.url), "..", "binary-log-worker.js");
}

interface PendingChunk { buffer: ArrayBuffer; length: number; id: number; }

export interface BinaryLogStats {
  eventCount: number;
  bytesEncoded: number;
  chunksFlushed: number;
  dropped: number;        // always 0 — no-drop invariant
  allocatedChunks: number;
}

export class BinaryTraceLogWriter {
  private worker: Worker;
  private opened: Promise<void>;
  private openedResolve!: () => void;
  private finalizeResolve: ((bytes: number) => void) | null = null;
  private finalizeReject: ((e: Error) => void) | null = null;
  private error: Error | null = null;
  private closed = false; // set once the worker reports "done" (clean finalize)

  // current fill buffer
  private curBuf: ArrayBuffer;
  private curDv: DataView;
  private curOff = 0;

  private freePool: ArrayBuffer[] = [];
  private pendingSend: PendingChunk[] = [];
  private inFlight = 0;
  private freeWaiters: Array<() => void> = [];
  private nextId = 1;

  private stats: BinaryLogStats = {
    eventCount: 0, bytesEncoded: 0, chunksFlushed: 0, dropped: 0, allocatedChunks: 1,
  };

  constructor(private readonly path: string, header: TraceFileMeta) {
    this.curBuf = new ArrayBuffer(CHUNK_BYTES);
    this.curDv = new DataView(this.curBuf);
    for (let i = 0; i < POOL_TARGET; i++) this.freePool.push(new ArrayBuffer(CHUNK_BYTES));
    this.stats.allocatedChunks = 1 + POOL_TARGET;

    this.worker = new Worker(workerScriptPath());
    this.opened = new Promise<void>((res) => { this.openedResolve = res; });
    this.worker.on("message", (m: { type: string; buffer?: ArrayBuffer; bytesWritten?: number; message?: string }) => {
      switch (m.type) {
        case "opened": this.openedResolve(); break;
        case "free":
          if (m.buffer) this.freePool.push(m.buffer);
          this.inFlight--;
          { const w = this.freeWaiters.shift(); if (w) w(); }
          break;
        case "done": this.closed = true; this.finalizeResolve?.(m.bytesWritten ?? 0); break;
        case "error":
          this.fail(new Error(`binary-log-worker: ${m.message}`));
          break;
      }
    });
    this.worker.on("error", (e) => this.fail(e));
    // A non-zero exit BEFORE a clean "done" is a crash → fail pending awaits. The
    // normal terminate() after "done" also exits non-zero; `closed` skips that.
    this.worker.on("exit", (code) => { if (code !== 0 && !this.closed) this.fail(new Error(`binary-log-worker exited code ${code}`)); });

    this.worker.postMessage({ type: "open", path });
    const hdr = encodeFileHeader(header);
    // header bytes are copied (small), not transferred.
    this.worker.postMessage({ type: "header", buffer: hdr.buffer.slice(0, hdr.byteLength) });
  }

  /** Surface a fatal writer/worker error to every pending await (open, drain
   *  backpressure, finalize) so nothing hangs. First error wins. */
  private fail(e: Error): void {
    if (!this.error) this.error = e;
    this.openedResolve();
    if (this.finalizeReject) { const rej = this.finalizeReject; this.finalizeReject = null; this.finalizeResolve = null; rej(this.error); }
    const waiters = this.freeWaiters; this.freeWaiters = [];
    for (const w of waiters) w();
  }

  async ready(): Promise<void> {
    await this.opened;
    if (this.error) throw this.error;
  }

  getStats(): BinaryLogStats { return { ...this.stats }; }

  // -- sync append methods (hot path) ---------------------------------------

  appendCpuStep(side: "c64" | "drive", cycle: number, pc: number, opcode: number,
                a: number, x: number, y: number, sp: number, p: number, b1: number, b2: number): void {
    const op = side === "drive" ? TraceOp.DRIVE_CPU_STEP : TraceOp.CPU_STEP;
    let off = encodeCpuStep(this.curDv, this.curOff, CHUNK_BYTES, op, cycle, pc, opcode, a, x, y, sp, p, b1, b2);
    if (off < 0) { this.flip(); off = encodeCpuStep(this.curDv, 0, CHUNK_BYTES, op, cycle, pc, opcode, a, x, y, sp, p, b1, b2); }
    this.commit(off);
  }

  appendMemAccess(kind: "ram" | "io" | "drive_ram", cycle: number, addr: number, value: number, pc: number, access: number): void {
    const op = kind === "io" ? TraceOp.IO_WRITE : kind === "drive_ram" ? TraceOp.DRIVE_RAM_WRITE : TraceOp.RAM_WRITE;
    let off = encodeMemAccess(this.curDv, this.curOff, CHUNK_BYTES, op, cycle, addr, value, pc, access);
    if (off < 0) { this.flip(); off = encodeMemAccess(this.curDv, 0, CHUNK_BYTES, op, cycle, addr, value, pc, access); }
    this.commit(off);
  }

  appendIec(cycle: number, lines: number): void {
    let off = encodeIecLine(this.curDv, this.curOff, CHUNK_BYTES, cycle, lines);
    if (off < 0) { this.flip(); off = encodeIecLine(this.curDv, 0, CHUNK_BYTES, cycle, lines); }
    this.commit(off);
  }

  appendVic(cycle: number, rasterY: number, kindCode: number, value: number): void {
    let off = encodeVicEvent(this.curDv, this.curOff, CHUNK_BYTES, cycle, rasterY, kindCode, value);
    if (off < 0) { this.flip(); off = encodeVicEvent(this.curDv, 0, CHUNK_BYTES, cycle, rasterY, kindCode, value); }
    this.commit(off);
  }

  appendSid(cycle: number, reg: number, value: number): void {
    let off = encodeSidWrite(this.curDv, this.curOff, CHUNK_BYTES, cycle, reg, value);
    if (off < 0) { this.flip(); off = encodeSidWrite(this.curDv, 0, CHUNK_BYTES, cycle, reg, value); }
    this.commit(off);
  }

  appendMark(cycle: number, label: string): void {
    let off = encodeMark(this.curDv, this.curOff, CHUNK_BYTES, cycle, label);
    if (off < 0) { this.flip(); off = encodeMark(this.curDv, 0, CHUNK_BYTES, cycle, label); }
    this.commit(off);
  }

  private commit(newOff: number): void {
    this.stats.bytesEncoded += newOff - this.curOff;
    this.curOff = newOff;
    this.stats.eventCount++;
  }

  /** Move the filled current chunk into pendingSend, take a fresh fill buffer.
   *  Sync + alloc-only: never awaits (cannot — runs inside the sync observer). */
  private flip(): void {
    if (this.curOff > 0) {
      this.pendingSend.push({ buffer: this.curBuf, length: this.curOff, id: this.nextId++ });
      const next = this.freePool.pop();
      if (next) { this.curBuf = next; }
      else { this.curBuf = new ArrayBuffer(CHUNK_BYTES); this.stats.allocatedChunks++; }
      this.curDv = new DataView(this.curBuf);
      this.curOff = 0;
    }
  }

  /** Transfer pending chunks to the Worker; apply backpressure at the binary
   *  append boundary only (emulator paused). Reclaims freed buffers. */
  async drain(): Promise<void> {
    if (this.error) throw this.error;
    // Send everything currently pending.
    while (this.pendingSend.length > 0) {
      const c = this.pendingSend.shift()!;
      this.worker.postMessage({ type: "chunk", buffer: c.buffer, length: c.length, id: c.id }, [c.buffer]);
      this.inFlight++;
      this.stats.chunksFlushed++;
      // Backpressure: block (await `free`) only when the Worker is behind.
      while (this.inFlight >= INFLIGHT_HIGH_WATER && !this.error) {
        await new Promise<void>((res) => this.freeWaiters.push(res));
      }
      if (this.error) throw this.error;
    }
  }

  /** Flush the partial current chunk, drain all, close the file. Returns bytes. */
  async finalize(): Promise<{ bytesWritten: number; stats: BinaryLogStats }> {
    if (this.error) throw this.error;
    this.flip();              // push partial current chunk
    await this.drain();
    const bytes = await new Promise<number>((res, rej) => {
      if (this.error) { rej(this.error); return; }
      this.finalizeResolve = res;
      this.finalizeReject = rej;
      this.worker.postMessage({ type: "finalize" });
    });
    await this.worker.terminate();
    if (this.error) throw this.error;
    return { bytesWritten: bytes, stats: this.getStats() };
  }
}

export { CHUNK_BYTES };
