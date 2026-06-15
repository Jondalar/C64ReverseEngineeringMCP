#!/usr/bin/env node
// Spec 766.1 — recorder shared-memory handoff ring.
//
// Proves the lossy single-producer/single-consumer ring:
//   A) single-thread LOSSY overwrite: M > N writes → newest N survive byte-exact,
//      the lapped M-N counted dropped (oldest-first eviction).
//   B) single-thread NO-LAP: M ≤ N writes → all M survive byte-exact, 0 dropped.
//   C) two-thread CONCURRENCY: a worker consumer drains while the main thread
//      floods; every received record is byte-exact (no torn corruption leaks),
//      the producer NEVER blocks (sync flood completes), and the accounting
//      closes (received + dropped == written, read cursor reaches the write cursor).
//   D) ZERO producer allocation: a 1e6-write flood grows the heap by ~nothing.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  RecorderRingProducer, RecorderRingConsumer, createRecorderRingSab,
} from "../dist/runtime/headless/recorder/recorder-ring.js";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

// payload of record i: [u32 LE i][fill = (i & 0xff)] up to `size` bytes
function mkPayload(i, size) {
  const p = new Uint8Array(size);
  p[0] = i & 0xff; p[1] = (i >> 8) & 0xff; p[2] = (i >> 16) & 0xff; p[3] = (i >> 24) & 0xff;
  const fill = i & 0xff;
  for (let k = 4; k < size; k++) p[k] = fill;
  return p;
}
function idxOf(payload) {
  return payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
}
function valid(payload) {
  const fill = idxOf(payload) & 0xff;
  for (let k = 4; k < payload.length; k++) if (payload[k] !== fill) return false;
  return true;
}

console.log("Spec 766.1 — recorder shared-memory handoff ring");

// ---- A: single-thread lossy overwrite-oldest --------------------------------
{
  const layout = { slotPayloadBytes: 64, slotCount: 8 };
  const sab = createRecorderRingSab(layout);
  const prod = new RecorderRingProducer(sab, layout);
  const cons = new RecorderRingConsumer(sab, layout);
  for (let i = 0; i < 20; i++) prod.write(1, mkPayload(i, 64));
  const out = [];
  const n = cons.drain(out);
  const idxs = out.map((r) => idxOf(r.payload));
  const allOk = out.every((r) => valid(r.payload));
  gate("A lossy: newest N survive, oldest evicted",
    n === 8 && idxs[0] === 12 && idxs[7] === 19 && allOk,
    `got ${n} recs [${idxs[0]}..${idxs[idxs.length - 1]}], dropped=${cons.droppedCount()}, valid=${allOk}`);
  gate("A lossy: dropped == lapped count", cons.droppedCount() === 12, `dropped=${cons.droppedCount()}`);
}

// ---- B: single-thread no-lap ------------------------------------------------
{
  const layout = { slotPayloadBytes: 64, slotCount: 8 };
  const sab = createRecorderRingSab(layout);
  const prod = new RecorderRingProducer(sab, layout);
  const cons = new RecorderRingConsumer(sab, layout);
  for (let i = 0; i < 5; i++) prod.write(7, mkPayload(i, 64));
  const out = [];
  const n = cons.drain(out);
  const idxs = out.map((r) => idxOf(r.payload));
  gate("B no-lap: all survive byte-exact, 0 dropped",
    n === 5 && idxs.join(",") === "0,1,2,3,4" && out.every((r) => valid(r.payload)) && cons.droppedCount() === 0,
    `got ${n} [${idxs.join(",")}], dropped=${cons.droppedCount()}, types=${out[0]?.type}`);
}

// ---- C: two-thread concurrency ----------------------------------------------
const concResult = await new Promise((res, rej) => {
  const layout = { slotPayloadBytes: 256, slotCount: 256 };
  const sab = createRecorderRingSab(layout);
  const prod = new RecorderRingProducer(sab, layout);
  const M = 200000;

  const worker = new Worker(resolve(here, "probe-766-ring-worker.mjs"), { workerData: { sab, layout } });
  worker.on("message", (r) => { worker.terminate(); res(r); });
  worker.on("error", rej);

  // Give the worker a tick to start draining, then flood synchronously.
  setTimeout(() => {
    const t0 = process.hrtime.bigint();
    const buf = mkPayload(0, 256); // reused; rewrite the index each iteration
    for (let i = 0; i < M; i++) {
      buf[0] = i & 0xff; buf[1] = (i >> 8) & 0xff; buf[2] = (i >> 16) & 0xff; buf[3] = (i >> 24) & 0xff;
      const fill = i & 0xff;
      for (let k = 4; k < 256; k++) buf[k] = fill;
      prod.write(2, buf);
    }
    void (Number(process.hrtime.bigint() - t0) / 1e6); // flood is synchronous → never blocked
    // Let the worker catch up, then stop it.
    setTimeout(() => worker.postMessage("stop"), 50);
  }, 20);
});
{
  const r = concResult;
  const accounting = r.received + Number(r.dropped) === r.writeCount && r.writeCount === 200000;
  gate("C concurrency: every received record byte-exact (no torn corruption)", r.allValid === true,
    `received=${r.received}, dropped=${r.dropped}, allValid=${r.allValid}`);
  gate("C concurrency: accounting closes (received + dropped == written)", accounting,
    `received=${r.received} + dropped=${r.dropped} =?= written=${r.writeCount}`);
  gate("C concurrency: consumer read cursor reached the write cursor",
    r.readCount === r.writeCount && r.writeCount === 200000,
    `read=${r.readCount}, write=${r.writeCount}`);
}

// ---- D: zero producer allocation --------------------------------------------
{
  const layout = { slotPayloadBytes: 256, slotCount: 64 };
  const sab = createRecorderRingSab(layout);
  const prod = new RecorderRingProducer(sab, layout);
  const buf = mkPayload(0, 256);
  // warm up
  for (let i = 0; i < 10000; i++) prod.write(3, buf);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 1_000_000; i++) prod.write(3, buf);
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  const grewMiB = (after - before) / (1024 * 1024);
  // 1e6 writes; a per-write allocation (even a tiny view) would grow the heap
  // by many MiB before GC. Allow a small slack for probe noise.
  gate("D zero producer alloc: 1e6 writes grow heap by ~nothing",
    Math.abs(grewMiB) < 4 && global.gc !== undefined,
    `heapUsed Δ=${grewMiB.toFixed(2)} MiB over 1e6 writes${global.gc ? "" : " (run with --expose-gc!)"}`);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.1 ring: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.1 ring: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
