// Spec 766.4 — the recorder worker thread.
//
// A thin shell: it owns the AnchorStore (the scrub history) and does ALL the
// recorder's heavy work OFF the emulation thread. It drains the shared-memory
// ring (recorder-ring.ts) on a timer, frames each record (anchor-record.ts),
// and feeds the store (anchor-store.ts). The emulation thread only ever does a
// fire-and-forget memcpy into the ring — it never waits on, reads from, or
// allocates for this worker (BUG-049: no per-second hash/copy on the hot path).
//
// Request/response protocol (main → worker), each carrying a `reqId` echoed back:
//   { type: 'stats', reqId }
//   { type: 'list', reqId }
//   { type: 'getAnchor', reqId, seq }          → body bytes TRANSFERRED out
//   { type: 'findByCycle', reqId, cycle }
//   { type: 'getMedium', reqId, kind, gen }    → medium bytes TRANSFERRED out
//   { type: 'stop' }
// Replies: { type: 'reply', reqId, ok, value }  (+ transferred buffers when present)

import { parentPort, workerData } from "node:worker_threads";
import { RecorderRingConsumer, type RecorderRingLayout, type RecorderRecord } from "./recorder-ring.js";
import { AnchorStore } from "./anchor-store.js";
import {
  REC_ANCHOR, REC_MEDIUM,
  ANCHOR_HEADER_BYTES, readAnchorHeader,
  MEDIUM_HEADER_BYTES, readMediumHeader,
} from "./anchor-record.js";

if (!parentPort) throw new Error("recorder-worker: must run as a worker_thread");
const port = parentPort;

const { sab, layout, mediumSab, mediumLayout, capacityBytes, mediumKeep, drainIntervalMs } = workerData as {
  sab: SharedArrayBuffer;
  layout: RecorderRingLayout;
  mediumSab?: SharedArrayBuffer;
  mediumLayout?: RecorderRingLayout;
  capacityBytes?: number;
  mediumKeep?: number;
  drainIntervalMs?: number;
};

const consumer = new RecorderRingConsumer(sab, layout);
// Medium images travel on their own (big-but-rare) ring so the anchor ring slots
// stay small. Optional — single-ring callers (the 766.4 store probe) omit it.
const mediumConsumer = mediumSab && mediumLayout ? new RecorderRingConsumer(mediumSab, mediumLayout) : null;
const store = new AnchorStore(capacityBytes ?? 32 * 1024 * 1024, mediumKeep ?? 3);
const batch: RecorderRecord[] = [];

function applyRecord(rec: RecorderRecord): void {
  const p = rec.payload;
  if (rec.type === REC_ANCHOR) {
    if (p.length < ANCHOR_HEADER_BYTES) return;
    store.putAnchor(readAnchorHeader(p, 0), p.subarray(ANCHOR_HEADER_BYTES));
  } else if (rec.type === REC_MEDIUM) {
    if (p.length < MEDIUM_HEADER_BYTES) return;
    const h = readMediumHeader(p, 0);
    store.putMedium(h.kind, h.generation, p.subarray(MEDIUM_HEADER_BYTES), h.wallMs);
  }
}

function drainOnce(): number {
  batch.length = 0;
  consumer.drain(batch);
  for (const rec of batch) applyRecord(rec);
  let n = batch.length;
  if (mediumConsumer) {
    batch.length = 0;
    mediumConsumer.drain(batch);
    for (const rec of batch) applyRecord(rec);
    n += batch.length;
  }
  return n;
}

const timer = setInterval(drainOnce, drainIntervalMs ?? 50);

port.on("message", (msg: { type: string; reqId?: number; seq?: number; cycle?: number; kind?: number; gen?: number }) => {
  try {
    if (msg.type === "stop") {
      clearInterval(timer);
      drainOnce(); // final catch-up
      port.postMessage({ type: "stopped" });
      return;
    }
    // Drain before any query so the answer reflects the latest produced records.
    drainOnce();
    switch (msg.type) {
      case "stats":
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: true, value: { ...store.stats(), dropped: consumer.droppedCount() } });
        break;
      case "list":
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: true, value: store.list() });
        break;
      case "getAnchor": {
        const header = store.getAnchorHeader(msg.seq!);
        const bytes = store.getAnchorBytes(msg.seq!);
        if (!header || !bytes) { port.postMessage({ type: "reply", reqId: msg.reqId, ok: false, value: null }); break; }
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: true, value: { header, bytes } }, [bytes.buffer as ArrayBuffer]);
        break;
      }
      case "findByCycle": {
        const e = store.findByCycle(msg.cycle!);
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: e !== null, value: e });
        break;
      }
      case "getMedium": {
        const m = store.getMedium(msg.kind!, msg.gen!);
        if (!m) { port.postMessage({ type: "reply", reqId: msg.reqId, ok: false, value: null }); break; }
        const copy = m.bytes.slice();
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: true, value: { kind: m.kind, generation: m.generation, wallMs: m.wallMs, bytes: copy } }, [copy.buffer as ArrayBuffer]);
        break;
      }
      default:
        port.postMessage({ type: "reply", reqId: msg.reqId, ok: false, value: `unknown request ${msg.type}` });
    }
  } catch (e) {
    port.postMessage({ type: "reply", reqId: msg.reqId, ok: false, value: (e as Error).message ?? String(e) });
  }
});
