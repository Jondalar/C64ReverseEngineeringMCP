// Spec 726.B — `.c64retrace` writer Worker (off-hot-path disk boundary).
//
// The emulator thread only fills fixed-size ArrayBuffers (binary-log-writer.ts)
// and transfers them here. This worker is the ONLY place that touches the disk,
// so the run loop never blocks on file I/O — it overlaps with the next run
// chunk. Buffers are transferred back to the main thread for reuse so steady-
// state capture allocates nothing.
//
// Protocol (main → worker):
//   { type: 'open', path }
//   { type: 'header', buffer }                 // file header bytes (copied)
//   { type: 'chunk', buffer, length, id }      // buffer TRANSFERRED in
//   { type: 'finalize' }
// Protocol (worker → main):
//   { type: 'opened' }
//   { type: 'free', buffer, id }               // buffer TRANSFERRED back
//   { type: 'done', bytesWritten }
//   { type: 'error', message }

import { parentPort } from "node:worker_threads";
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

if (!parentPort) throw new Error("binary-log-worker: must run as a worker_thread");
const port = parentPort;

let fd: number | null = null;
let bytesWritten = 0;

function writeBytes(buffer: ArrayBuffer, length: number): void {
  if (fd === null) throw new Error("binary-log-worker: write before open");
  const view = Buffer.from(buffer, 0, length);
  let written = 0;
  while (written < length) {
    written += writeSync(fd, view, written, length - written, null);
  }
  bytesWritten += length;
}

port.on("message", (msg: {
  type: string; path?: string; buffer?: ArrayBuffer; length?: number; id?: number;
}) => {
  try {
    switch (msg.type) {
      case "open": {
        const path = msg.path!;
        mkdirSync(dirname(path), { recursive: true });
        fd = openSync(path, "w");
        bytesWritten = 0;
        port.postMessage({ type: "opened" });
        break;
      }
      case "header": {
        // Header bytes are copied (not transferred) — small, one-shot.
        writeBytes(msg.buffer!, msg.buffer!.byteLength);
        break;
      }
      case "chunk": {
        writeBytes(msg.buffer!, msg.length!);
        // Return the (now-written) buffer to the main thread for reuse.
        port.postMessage({ type: "free", buffer: msg.buffer, id: msg.id }, [msg.buffer!]);
        break;
      }
      case "finalize": {
        if (fd !== null) { try { fsyncSync(fd); } catch { /* best-effort */ } closeSync(fd); fd = null; }
        port.postMessage({ type: "done", bytesWritten });
        break;
      }
      default:
        port.postMessage({ type: "error", message: `unknown message ${msg.type}` });
    }
  } catch (e) {
    port.postMessage({ type: "error", message: (e as Error).message ?? String(e) });
  }
});
