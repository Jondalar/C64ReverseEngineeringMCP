// Spec 766.1 — consumer worker for probe-766-ring.
// Drains the shared recorder ring concurrently with the main-thread producer,
// validates every received record byte-exact, accumulates counts. The payload of
// record i is: [u32 LE index][fill bytes = index & 0xff]. A torn/corrupt read
// would break the fill check → allValid=false.

import { parentPort, workerData } from "node:worker_threads";
import { RecorderRingConsumer } from "../dist/runtime/headless/recorder/recorder-ring.js";

const { sab, layout } = workerData;
const consumer = new RecorderRingConsumer(sab, layout);

let received = 0;
let allValid = true;
let minIdx = Infinity;
let maxIdx = -Infinity;
const batch = [];

function decodeAndValidate(rec) {
  const p = rec.payload;
  const idx = p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24);
  const fill = idx & 0xff;
  for (let i = 4; i < p.length; i++) {
    if (p[i] !== fill) { allValid = false; return; }
  }
  received++;
  if (idx < minIdx) minIdx = idx;
  if (idx > maxIdx) maxIdx = idx;
}

let stopped = false;
function drainOnce() {
  batch.length = 0;
  consumer.drain(batch);
  for (const rec of batch) decodeAndValidate(rec);
}

const timer = setInterval(() => {
  drainOnce();
  if (stopped) {
    // final drain to catch the tail, then report
    drainOnce();
    clearInterval(timer);
    parentPort.postMessage({
      received, allValid,
      minIdx: minIdx === Infinity ? -1 : minIdx,
      maxIdx,
      dropped: consumer.droppedCount(),
      readCount: consumer.readCount(),
      writeCount: consumer.writeCount(),
    });
  }
}, 1);

parentPort.on("message", (m) => { if (m === "stop") stopped = true; });
