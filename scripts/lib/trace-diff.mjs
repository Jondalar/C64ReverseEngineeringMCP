// Spec 205-B c1 — trace JSONL reader + first-divergence library.
//
// Two input formats supported:
//
// 1) Legacy snapshot-tuple JSONL (VICE trace.jsonl + headless-trace.jsonl):
//      { ts, c64Pc, drvPc, c64A, drvA, z90, dd00, drvPb }
//    Periodic snapshot every N cycles. Compare field-by-field at the
//    closest matching ts on each side.
//
// 2) Kernel TraceEvent JSONL (Spec 205-A bus_access / cpu / iec / ...):
//      { ts, channel, data: {...} }
//    Per-channel event stream. Compare per (channel, kind) at matching
//    ts windows. Emit divergence on first mismatched data record.
//
// `loadJsonl` reads a path, returns array of parsed records (skipping
// blank lines). `firstDivergence` walks two sorted streams and reports
// first cycle where they disagree along the requested fields.
//
// Tolerance: snapshot streams sample on different cadences (VICE binmon
// ~50k cycles, headless deterministic). `tolerance` (cycles) lets the
// matcher slide ±tolerance to find a same-clock partner before declaring
// divergence.

import { readFileSync, existsSync } from "node:fs";

export function loadJsonl(path) {
  if (!existsSync(path)) throw new Error(`trace JSONL missing: ${path}`);
  const raw = readFileSync(path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

/**
 * Detect format by sniffing first record.
 *   "snapshot" → has c64Pc field.
 *   "channel"  → has channel + data fields.
 */
export function detectFormat(records) {
  if (records.length === 0) return "empty";
  const first = records[0];
  if (typeof first.channel === "string" && typeof first.data === "object") {
    return "channel";
  }
  if (typeof first.c64Pc === "number" || typeof first.drvPc === "number") {
    return "snapshot";
  }
  return "unknown";
}

/**
 * Find first ts where snapshot tuples diverge on `fields` (default:
 * c64Pc + drvPc + dd00 + drvPb). `tolerance` cycles allows offset
 * matching when streams sample on slightly different cadences.
 *
 * Algorithm: for each vice record, find the closest-ts ours record;
 * if abs(delta) ≤ tolerance, compare fields. Skip vice records with
 * no in-tolerance match. First mismatch wins.
 */
export function firstSnapshotDivergence(viceList, ourList, opts = {}) {
  const fields = opts.fields ?? ["c64Pc", "drvPc", "dd00", "drvPb"];
  const tolerance = opts.tolerance ?? 100_000;
  if (viceList.length === 0 || ourList.length === 0) {
    return { kind: "empty-input", viceLen: viceList.length, ourLen: ourList.length };
  }
  // Precondition: both streams sorted by ts. We track a low-water
  // index into ourList so the walker remains O(n).
  let j = 0;
  for (let i = 0; i < viceList.length; i++) {
    const v = viceList[i];
    // Advance j past any ours record clearly before the tolerance window.
    while (j + 1 < ourList.length && ourList[j + 1].ts <= v.ts) j++;
    // Pick the closer of ourList[j] and ourList[j+1] (if it exists).
    let pick = j;
    if (j + 1 < ourList.length) {
      const dCur = Math.abs(ourList[j].ts - v.ts);
      const dNext = Math.abs(ourList[j + 1].ts - v.ts);
      if (dNext < dCur) pick = j + 1;
    }
    const o = ourList[pick];
    if (Math.abs(o.ts - v.ts) > tolerance) continue;
    for (const f of fields) {
      const vv = v[f];
      const ov = o[f];
      if (vv !== ov) {
        return {
          kind: "snapshot-divergence",
          ts: v.ts,
          ourTs: o.ts,
          field: f,
          vice: vv,
          ours: ov,
          context: { vice: v, ours: o },
        };
      }
    }
  }
  return { kind: "no-divergence", samples: viceList.length };
}

/**
 * Find first divergence on per-channel event streams. Streams are
 * grouped by channel name; within a channel events are ordered by ts.
 * Divergence = different count up to a given ts, or different data
 * payload at matching seq index.
 */
export function firstChannelDivergence(viceList, ourList, opts = {}) {
  const channel = opts.channel;
  if (!channel) throw new Error("opts.channel required for channel-format diff");
  const v = viceList.filter((r) => r.channel === channel);
  const o = ourList.filter((r) => r.channel === channel);
  const fields = opts.fields; // optional whitelist of data fields to compare
  if (v.length === 0 || o.length === 0) {
    return { kind: "empty-channel", channel, viceLen: v.length, ourLen: o.length };
  }
  const n = Math.min(v.length, o.length);
  for (let i = 0; i < n; i++) {
    const vd = v[i].data ?? {};
    const od = o[i].data ?? {};
    const keys = fields ?? Object.keys(vd);
    for (const k of keys) {
      if (vd[k] !== od[k]) {
        return {
          kind: "channel-divergence",
          channel,
          index: i,
          field: k,
          ts: v[i].ts,
          ourTs: o[i].ts,
          vice: vd[k],
          ours: od[k],
          context: { vice: v[i], ours: o[i] },
        };
      }
    }
  }
  if (v.length !== o.length) {
    return {
      kind: "channel-length-mismatch",
      channel,
      viceLen: v.length,
      ourLen: o.length,
    };
  }
  return { kind: "no-divergence", channel, samples: n };
}
