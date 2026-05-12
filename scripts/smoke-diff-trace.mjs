#!/usr/bin/env node
// Spec 205-B c3 — diff-trace library smoke.
//
// Synthetic JSONL fixtures: identical → no divergence; mutated →
// reports first divergence at expected ts/field.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadJsonl,
  detectFormat,
  firstSnapshotDivergence,
  firstChannelDivergence,
} from "./lib/trace-diff.mjs";

const tmp = join(tmpdir(), `c64re-difftrace-smoke-${process.pid}`);
mkdirSync(tmp, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

console.log("diff-trace smoke — Spec 205-B acceptance");

// Snapshot tuple stream: 5 records on each side.
const baseRecords = [
  { ts: 100, c64Pc: 0xa000, drvPc: 0xeaea, c64A: 1, drvA: 1, z90: 0, dd00: 0xff, drvPb: 0 },
  { ts: 200, c64Pc: 0xa001, drvPc: 0xeaeb, c64A: 2, drvA: 2, z90: 0, dd00: 0xff, drvPb: 0 },
  { ts: 300, c64Pc: 0xa002, drvPc: 0xeaec, c64A: 3, drvA: 3, z90: 0, dd00: 0xff, drvPb: 0 },
  { ts: 400, c64Pc: 0xa003, drvPc: 0xeaed, c64A: 4, drvA: 4, z90: 0, dd00: 0xff, drvPb: 0 },
  { ts: 500, c64Pc: 0xa004, drvPc: 0xeaee, c64A: 5, drvA: 5, z90: 0, dd00: 0xff, drvPb: 0 },
];

const vicePath = join(tmp, "vice.jsonl");
const oursPath = join(tmp, "ours.jsonl");

writeFileSync(vicePath, baseRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

check("loadJsonl + detectFormat snapshot", () => {
  const list = loadJsonl(vicePath);
  if (list.length !== 5) throw new Error(`length = ${list.length}`);
  if (detectFormat(list) !== "snapshot") throw new Error("format != snapshot");
});

check("identical streams: no divergence", () => {
  writeFileSync(oursPath, baseRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const v = loadJsonl(vicePath);
  const o = loadJsonl(oursPath);
  const r = firstSnapshotDivergence(v, o);
  if (r.kind !== "no-divergence") throw new Error(`kind = ${r.kind}`);
});

check("mutated c64Pc at ts=300: divergence reported with correct field+values", () => {
  const mutated = baseRecords.map((r, i) => i === 2 ? { ...r, c64Pc: 0xb000 } : r);
  writeFileSync(oursPath, mutated.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const v = loadJsonl(vicePath);
  const o = loadJsonl(oursPath);
  const r = firstSnapshotDivergence(v, o);
  if (r.kind !== "snapshot-divergence") throw new Error(`kind = ${r.kind}`);
  if (r.ts !== 300) throw new Error(`ts = ${r.ts}, want 300`);
  if (r.field !== "c64Pc") throw new Error(`field = ${r.field}`);
  if (r.vice !== 0xa002) throw new Error(`vice = ${r.vice}`);
  if (r.ours !== 0xb000) throw new Error(`ours = ${r.ours}`);
});

check("mutated drvPb at ts=400: divergence reported", () => {
  const mutated = baseRecords.map((r, i) => i === 3 ? { ...r, drvPb: 0xff } : r);
  writeFileSync(oursPath, mutated.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = firstSnapshotDivergence(loadJsonl(vicePath), loadJsonl(oursPath));
  if (r.kind !== "snapshot-divergence") throw new Error(`kind = ${r.kind}`);
  if (r.ts !== 400) throw new Error(`ts = ${r.ts}, want 400`);
  if (r.field !== "drvPb") throw new Error(`field = ${r.field}`);
});

check("tolerance window slides ts match (small drift)", () => {
  // ours drifts by +5 cycles per record (deterministic skew). With
  // tolerance 50 the matcher pairs each record with itself.
  const offset = baseRecords.map((r) => ({ ...r, ts: r.ts + 5 }));
  writeFileSync(oursPath, offset.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = firstSnapshotDivergence(loadJsonl(vicePath), loadJsonl(oursPath), { tolerance: 50 });
  if (r.kind !== "no-divergence") throw new Error(`kind = ${r.kind} (expected match within tolerance)`);
});

// Channel-format streams.
const baseEvents = [
  { ts: 1000, channel: "bus_access", data: { side: "c64", op: "write", addr: 0xdd00, value: 0x37, seq: 0 } },
  { ts: 1010, channel: "bus_access", data: { side: "c64", op: "read",  addr: 0xdd00, value: 0xff, seq: 1 } },
  { ts: 1020, channel: "bus_access", data: { side: "drive", op: "write", addr: 0x1800, value: 0x04, seq: 2 } },
];
writeFileSync(vicePath, baseEvents.map((r) => JSON.stringify(r)).join("\n") + "\n");

check("channel format: identical streams = no divergence", () => {
  writeFileSync(oursPath, baseEvents.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = firstChannelDivergence(loadJsonl(vicePath), loadJsonl(oursPath), { channel: "bus_access" });
  if (r.kind !== "no-divergence") throw new Error(`kind = ${r.kind}`);
});

check("channel format: mutated value at index 1 reported", () => {
  const mutated = baseEvents.map((e, i) => i === 1 ? { ...e, data: { ...e.data, value: 0xaa } } : e);
  writeFileSync(oursPath, mutated.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = firstChannelDivergence(loadJsonl(vicePath), loadJsonl(oursPath), { channel: "bus_access" });
  if (r.kind !== "channel-divergence") throw new Error(`kind = ${r.kind}`);
  if (r.index !== 1) throw new Error(`index = ${r.index}`);
  if (r.field !== "value") throw new Error(`field = ${r.field}`);
  if (r.vice !== 0xff) throw new Error(`vice = ${r.vice}`);
  if (r.ours !== 0xaa) throw new Error(`ours = ${r.ours}`);
});

check("channel format: length mismatch reported when no value differs", () => {
  writeFileSync(oursPath, baseEvents.slice(0, 2).map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = firstChannelDivergence(loadJsonl(vicePath), loadJsonl(oursPath), { channel: "bus_access" });
  if (r.kind !== "channel-length-mismatch") throw new Error(`kind = ${r.kind}`);
  if (r.viceLen !== 3 || r.ourLen !== 2) {
    throw new Error(`lens = ${r.viceLen}/${r.ourLen}`);
  }
});

rmSync(tmp, { recursive: true, force: true });

console.log("---");
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
