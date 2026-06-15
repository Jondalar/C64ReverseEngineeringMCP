#!/usr/bin/env node
// Spec 766.4 — recorder worker store (anchor byte-ring + medium dedup) + the
// worker shell draining the shared ring.
//
//   A) STORE depth + overwrite-oldest: fixed-size anchors into a bounded slab →
//      live count ≈ slab/anchor, oldest evicted, evicted counter moves.
//   B) STORE byte-exact reconstruct: every still-present anchor reads back
//      byte-identical; an evicted seq returns null.
//   C) STORE medium dedup: a gen is stored once; keep=N bounds versions;
//      the oldest version is evicted past N.
//   D) WORKER cross-thread: a real recorder-worker drains the SAB ring while the
//      main thread floods anchors + media; queried over the message API it
//      reconstructs an anchor byte-exact, finds-by-cycle, and returns the medium.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { AnchorStore } from "../dist/runtime/headless/recorder/anchor-store.js";
import {
  encodeAnchorRecord, encodeMediumRecord, REC_ANCHOR, REC_MEDIUM,
  MEDIUM_KIND_DISK, MEDIUM_KIND_CART,
} from "../dist/runtime/headless/recorder/anchor-record.js";
import {
  RecorderRingProducer, createRecorderRingSab,
} from "../dist/runtime/headless/recorder/recorder-ring.js";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

function mkCodec(seq, len) {
  const p = new Uint8Array(len);
  p[0] = seq & 0xff; p[1] = (seq >> 8) & 0xff;
  for (let k = 2; k < len; k++) p[k] = (seq + k) & 0xff;
  return p;
}
function codecEq(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log("Spec 766.4 — recorder worker store");

// ---- A + B: store depth, eviction, byte-exact -------------------------------
{
  const CAP = 1 << 20;          // 1 MiB slab
  const LEN = 100 * 1024;       // 100 KiB anchors → ~10 live
  const N = 40;                 // write 4× the slab → forces overwrite-oldest
  const store = new AnchorStore(CAP, 3);
  const seqs = [];
  for (let i = 0; i < N; i++) {
    seqs.push(store.putAnchor({ cycle: i * 1000, wallMs: i * 500, diskGen: 0, cartGen: 0 }, mkCodec(i, LEN)));
  }
  const st = store.stats();
  const expectLive = Math.floor(CAP / LEN);
  gate("A depth ≈ slab/anchor, overwrite-oldest engaged",
    st.anchorCount >= expectLive - 1 && st.anchorCount <= expectLive + 1 && st.evicted === N - st.anchorCount,
    `live=${st.anchorCount} (~${expectLive}), evicted=${st.evicted}, newestCycle=${st.newestCycle}`);

  // newest anchors present + byte-exact; oldest evicted → null
  const list = store.list();
  let allExact = true;
  for (const e of list) { if (!codecEq(store.getAnchorBytes(e.seq), mkCodec(e.cycle / 1000, LEN))) { allExact = false; break; } }
  gate("B every present anchor reconstructs byte-exact", allExact, `${list.length} checked`);
  gate("B evicted seq returns null", store.getAnchorBytes(seqs[0]) === null, `seq ${seqs[0]} evicted`);

  // findByCycle picks the newest at/before a cycle
  const f = store.findByCycle((N - 1) * 1000);
  gate("B findByCycle returns newest at/before target", f !== null && f.cycle === (N - 1) * 1000, `cycle=${f?.cycle}`);
}

// ---- C: medium dedup --------------------------------------------------------
{
  const store = new AnchorStore(1 << 20, 3);
  const md = (g, b) => store.putMedium(MEDIUM_KIND_DISK, g, new Uint8Array([b, b, b]), 0);
  md(10, 0xaa); md(10, 0xaa); // same gen twice → stored once
  gate("C same gen stored once (idempotent)", store.getMedium(MEDIUM_KIND_DISK, 10) !== null && store.stats().mediumDisk === 10, "gen10");
  md(11, 0xbb); md(12, 0xcc); // now 3 versions (10,11,12)
  gate("C keeps up to N versions", store.getMedium(MEDIUM_KIND_DISK, 10) !== null && store.getMedium(MEDIUM_KIND_DISK, 12) !== null, "10,11,12 present");
  md(13, 0xdd); // exceeds keep=3 → evict oldest (10)
  gate("C evicts oldest version past keep=N",
    store.getMedium(MEDIUM_KIND_DISK, 10) === null && store.getMedium(MEDIUM_KIND_DISK, 13) !== null,
    `disk latest=${store.stats().mediumDisk}`);
  // cart kind is independent
  store.putMedium(MEDIUM_KIND_CART, 5, new Uint8Array([1]), 0);
  gate("C cart kind tracked independently", store.stats().mediumCart === 5 && store.stats().mediumDisk === 13, `cart=5 disk=13`);
}

// ---- D: real worker drains the shared ring ----------------------------------
const workerPath = resolve(here, "../dist/runtime/headless/recorder/recorder-worker.js");
const layout = { slotPayloadBytes: 70000, slotCount: 64 };
const sab = createRecorderRingSab(layout);
const prod = new RecorderRingProducer(sab, layout);

const worker = new Worker(workerPath, {
  workerData: { sab, layout, capacityBytes: 4 * 1024 * 1024, mediumKeep: 3, drainIntervalMs: 3 },
});
let reqSeq = 0;
const pending = new Map();
worker.on("message", (m) => {
  if (m.type === "reply") { const r = pending.get(m.reqId); if (r) { pending.delete(m.reqId); r(m); } }
  else if (m.type === "stopped") { const r = pending.get("stop"); if (r) r(); }
});
function req(type, extra = {}) {
  return new Promise((res) => { const reqId = ++reqSeq; pending.set(reqId, res); worker.postMessage({ type, reqId, ...extra }); });
}

const ANCHOR_LEN = 4096;
const MEDIUM_LEN = 60000;
const K = 50;
// flood: an anchor every step, a medium at two distinct gens
for (let i = 0; i < K; i++) {
  const rec = encodeAnchorRecord({ cycle: i * 10000, wallMs: i * 500, diskGen: i < 25 ? 1 : 2, cartGen: 0 }, mkCodec(i, ANCHOR_LEN));
  prod.write(REC_ANCHOR, rec);
  if (i === 0) prod.write(REC_MEDIUM, encodeMediumRecord({ kind: MEDIUM_KIND_DISK, generation: 1, wallMs: 0 }, mkCodec(1000, MEDIUM_LEN)));
  if (i === 25) prod.write(REC_MEDIUM, encodeMediumRecord({ kind: MEDIUM_KIND_DISK, generation: 2, wallMs: 12500 }, mkCodec(2000, MEDIUM_LEN)));
}

await new Promise((r) => setTimeout(r, 60)); // let the worker drain

const stats = (await req("stats")).value;
gate("D worker drained anchors from the ring", stats.anchorCount > 0 && stats.newestCycle === (K - 1) * 10000,
  `live=${stats.anchorCount}, newest=${stats.newestCycle}, dropped=${stats.dropped}`);

const fbc = (await req("findByCycle", { cycle: (K - 1) * 10000 })).value;
const ga = await req("getAnchor", { seq: fbc.seq });
gate("D worker reconstructs an anchor byte-exact over the wire",
  ga.ok && codecEq(new Uint8Array(ga.value.bytes), mkCodec((K - 1), ANCHOR_LEN)) && ga.value.header.cycle === (K - 1) * 10000,
  `seq=${fbc?.seq} cycle=${ga.value?.header?.cycle}`);

const gm = await req("getMedium", { kind: MEDIUM_KIND_DISK, gen: 2 });
gate("D worker returns the deduped medium for a gen",
  gm.ok && codecEq(new Uint8Array(gm.value.bytes), mkCodec(2000, MEDIUM_LEN)) && gm.value.generation === 2,
  `gen=${gm.value?.generation}, len=${gm.value?.bytes?.byteLength}`);

await new Promise((r) => { pending.set("stop", r); worker.postMessage({ type: "stop" }); });
await worker.terminate();

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.4 store: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.4 store: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
