#!/usr/bin/env node
// Spec 218 — IEC line-state diff via replay.
//
// HL stores have actual `line_change` bus_events from the runtime.
// VICE stores only have CPU-derived bus reads/writes (no live IEC
// state tracking). To diff line-state evolution between the two,
// replay both stores' c64 $DD00 writes + drive $1800 writes through
// the same IecBusCore JS implementation, capturing the resulting
// (atn, clk, data) line state after each store. That gives a
// deterministic per-store line-state timeline.
//
// Diff: walk both timelines in lock-step ordered by master_clock,
// find the first event whose (master_clock, line_state) pair differs.
//
// Usage:
//   node scripts/trace-store-iec-line-diff.mjs \
//     --vice <vice.duckdb> --headless <hl.duckdb> \
//     [--align-anchor ab_entry] \
//     [--limit 200] \
//     [--out report.md]

import { resolve as resolvePath, basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const viceDb = args.vice ? resolvePath(args.vice) : null;
const hlDb = args.headless ? resolvePath(args.headless) : null;
if (!viceDb || !existsSync(viceDb) || !hlDb || !existsSync(hlDb)) {
  console.error("usage: trace-store-iec-line-diff.mjs --vice <duckdb> --headless <duckdb>");
  process.exit(2);
}
const alignAnchor = typeof args["align-anchor"] === "string" ? args["align-anchor"] : "ab_entry";
const limit = Number(args.limit ?? 200);
const repoRoot = resolvePath(import.meta.dirname, "..");
const outPath = args.out
  ? resolvePath(args.out)
  : (() => {
      const dir = join(dirname(hlDb), "..", "..", "..", "analysis", "runtime", `motm-iec-line-diff-${new Date().toISOString().slice(0, 10)}`);
      mkdirSync(dir, { recursive: true });
      return join(dir, `iec-line-diff.md`);
    })();

console.log(`trace-store-iec-line-diff (Spec 218)`);
console.log(`  vice          : ${viceDb}`);
console.log(`  headless      : ${hlDb}`);
console.log(`  align         : ${alignAnchor}`);
console.log(`  limit         : ${limit}`);
console.log(`  out           : ${outPath}`);

// Use IecBusCore for replay.
const { IecBusCore } = await import(`${repoRoot}/dist/runtime/headless/iec/iec-bus-core.js`);

const duck = await import("@duckdb/node-api");
const inst = await duck.DuckDBInstance.create(":memory:");
const conn = await inst.connect();
await conn.run(`ATTACH '${viceDb}' AS vice (READ_ONLY)`);
await conn.run(`ATTACH '${hlDb}' AS hl (READ_ONLY)`);

async function rows(sql) { return (await conn.runAndReadAll(sql)).getRows(); }
function asBig(v) { return v === null || v === undefined ? null : (typeof v === "bigint" ? v : BigInt(v)); }
function fmtHex(n, w = 4) { if (n === null || n === undefined) return "-"; const v = typeof n === "bigint" ? Number(n) : n; return "$" + v.toString(16).padStart(w, "0"); }

// ---------- Replay both stores' writes through IecBusCore ----------
async function loadWrites(catalog) {
  // c64 $DD00 writes + drive $1800 writes, merged by master_clock.
  const sql = `
    SELECT master_clock, 'c64' AS actor, value
    FROM ${catalog}.bus_events
    WHERE addr=56576 AND kind='write' AND cpu='c64'
    UNION ALL
    SELECT master_clock, 'drive8' AS actor, value
    FROM ${catalog}.bus_events
    WHERE addr=6144 AND kind='write' AND cpu='drive8'
    ORDER BY master_clock ASC
  `;
  const r = await rows(sql);
  return r.map(([mc, actor, val]) => ({
    mc: asBig(mc),
    actor,
    value: Number(val),
  }));
}

function replay(writes) {
  const core = new IecBusCore();
  const states = [];
  let lastCpuPort = -1;
  let lastDrvBus8 = -1;
  let lastCpuBus = -1;
  for (const w of writes) {
    if (w.actor === "c64") {
      const inverted = (~w.value) & 0xff;
      core.c64_store_dd00(inverted);
    } else {
      core.drive_store_pb(w.value & 0xff, 8);
    }
    const cp = core.cpu_port;
    const db = core.drv_bus[8] ?? 0xff;
    const cb = core.cpu_bus;
    if (cp !== lastCpuPort || db !== lastDrvBus8 || cb !== lastCpuBus) {
      states.push({
        mc: w.mc, actor: w.actor, value: w.value,
        cpu_port: cp, drv_bus_8: db, cpu_bus: cb,
        // c64-visible line state — what c64 reads on $DD00:
        atn: (cb & 0x10) !== 0,
        clk: (cp & 0x40) !== 0,
        data: (cp & 0x80) !== 0,
      });
      lastCpuPort = cp; lastDrvBus8 = db; lastCpuBus = cb;
    }
  }
  return states;
}

console.log(`replaying VICE writes ...`);
const viceWrites = await loadWrites("vice");
console.log(`  vice writes: ${viceWrites.length}`);
const viceStates = replay(viceWrites);
console.log(`  vice line-state changes: ${viceStates.length}`);

console.log(`replaying HL writes ...`);
const hlWrites = await loadWrites("hl");
console.log(`  hl writes: ${hlWrites.length}`);
const hlStates = replay(hlWrites);
console.log(`  hl line-state changes: ${hlStates.length}`);

// ---------- Align by ab_entry ----------
async function firstAnchorMC(catalog, name) {
  const r = await rows(`
    SELECT MIN(i.master_clock) FROM ${catalog}.anchors a
    JOIN ${catalog}.instructions i ON i.run_id=a.run_id AND i.cpu=a.cpu AND i.seq=a.seq
    WHERE a.name='${name}'
  `);
  return asBig(r[0]?.[0]);
}
const viceAb = await firstAnchorMC("vice", alignAnchor);
const hlAb = await firstAnchorMC("hl", alignAnchor);
if (viceAb === null || hlAb === null) {
  console.error(`anchor ${alignAnchor} not found in both stores`);
  process.exit(2);
}

// Filter line-state changes to post-ab_entry, compute relative master_clock.
const viceRel = viceStates
  .filter(s => s.mc >= viceAb)
  .map(s => ({ ...s, rel: s.mc - viceAb }));
const hlRel = hlStates
  .filter(s => s.mc >= hlAb)
  .map(s => ({ ...s, rel: s.mc - hlAb }));

console.log(`  vice post-${alignAnchor}: ${viceRel.length}`);
console.log(`  hl   post-${alignAnchor}: ${hlRel.length}`);

// ---------- Walk in lock-step by index ----------
const lines = [];
lines.push(`# IEC line-state diff (replay through IecBusCore)`);
lines.push(``);
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(``);
lines.push(`- VICE store:     \`${basename(dirname(viceDb))}\``);
lines.push(`- Headless store: \`${basename(dirname(hlDb))}\``);
lines.push(`- Align anchor:   ${alignAnchor}`);
lines.push(`- Replay model:   IecBusCore (Spec 140 v3 — VICE 1:1 port)`);
lines.push(``);
lines.push(`Replay process: feed each c64 $DD00 write and drive $1800 write through a fresh IecBusCore in master_clock order. Record each (cpu_port, drv_bus[8], cpu_bus) change. If both stores produce identical line-state timelines, the bug is NOT in IecBusCore — it is in scheduling, ordering, or downstream effects.`)
lines.push(``);

lines.push(`## §1 line-state event counts`);
lines.push(``);
lines.push(`| | vice | hl | delta |`);
lines.push(`|---|---:|---:|---:|`);
lines.push(`| writes (input)         | ${viceWrites.length} | ${hlWrites.length} | ${hlWrites.length - viceWrites.length} |`);
lines.push(`| line-state changes     | ${viceStates.length} | ${hlStates.length} | ${hlStates.length - viceStates.length} |`);
lines.push(`| post-${alignAnchor}    | ${viceRel.length}    | ${hlRel.length}    | ${hlRel.length - viceRel.length} |`);
lines.push(``);

lines.push(`## §2 first ${limit} line-state changes side-by-side`);
lines.push(``);
lines.push(`| i | vice_rel | vice_actor | vice_val | vice_cpuport | vice_drvbus8 | hl_rel | hl_actor | hl_val | hl_cpuport | hl_drvbus8 | Δrel | match |`);
lines.push(`|---:|---:|---|---|---|---|---:|---|---|---|---|---:|---|`);
const N = Math.min(viceRel.length, hlRel.length, limit);
let firstStateDiff = -1;
let firstClockDiff = -1;
for (let i = 0; i < N; i++) {
  const v = viceRel[i];
  const h = hlRel[i];
  const dRel = h.rel - v.rel;
  const stateMatch = (v.cpu_port === h.cpu_port && v.drv_bus_8 === h.drv_bus_8);
  const actorMatch = v.actor === h.actor;
  const valueMatch = v.value === h.value;
  if (!stateMatch && firstStateDiff < 0) firstStateDiff = i;
  if (Math.abs(Number(dRel)) > 8 && firstClockDiff < 0) firstClockDiff = i;
  const matchTag = (stateMatch && actorMatch && valueMatch) ? "✓" : `✗${!stateMatch?"S":""}${!actorMatch?"A":""}${!valueMatch?"V":""}`;
  // Print first 30 + window around first diffs
  const inEarly = i < 30;
  const inDiffWindow = (firstStateDiff >= 0 && Math.abs(i - firstStateDiff) < 5) || (firstClockDiff >= 0 && Math.abs(i - firstClockDiff) < 5);
  if (inEarly || inDiffWindow) {
    lines.push(`| ${i} | ${v.rel} | ${v.actor} | ${fmtHex(v.value, 2)} | ${fmtHex(v.cpu_port, 2)} | ${fmtHex(v.drv_bus_8, 2)} | ${h.rel} | ${h.actor} | ${fmtHex(h.value, 2)} | ${fmtHex(h.cpu_port, 2)} | ${fmtHex(h.drv_bus_8, 2)} | ${dRel >= 0n ? "+" : ""}${dRel} | ${matchTag} |`);
  }
}
lines.push(``);

if (firstStateDiff >= 0) {
  const v = viceRel[firstStateDiff];
  const h = hlRel[firstStateDiff];
  lines.push(`### First STATE divergence at index ${firstStateDiff}`);
  lines.push(``);
  lines.push(`- VICE: rel=${v.rel} actor=${v.actor} value=${fmtHex(v.value, 2)}  cpu_port=${fmtHex(v.cpu_port, 2)} drv_bus8=${fmtHex(v.drv_bus_8, 2)} cpu_bus=${fmtHex(v.cpu_bus, 2)}`);
  lines.push(`- HL:   rel=${h.rel} actor=${h.actor} value=${fmtHex(h.value, 2)}  cpu_port=${fmtHex(h.cpu_port, 2)} drv_bus8=${fmtHex(h.drv_bus_8, 2)} cpu_bus=${fmtHex(h.cpu_bus, 2)}`);
  lines.push(``);
  lines.push(`Same IecBusCore replay model produced different line state from this point. Therefore the off-by-one is NOT in the line-resolution math — it is in the upstream sequence of writes (different actors, values, or ordering).`);
} else {
  lines.push(`No STATE divergence within first ${N} events. Replay through IecBusCore yields IDENTICAL line state. Conclusion: line-resolution math is bit-exact between stores. The drift must come from elsewhere — most likely from drive-side instruction-level state that affects WHEN drive writes happen, OR from the scheduler interleaving order at the same master_clock tick.`);
}
lines.push(``);

if (firstClockDiff >= 0) {
  const v = viceRel[firstClockDiff];
  const h = hlRel[firstClockDiff];
  lines.push(`### First CLOCK divergence at index ${firstClockDiff} (|Δrel|>8)`);
  lines.push(``);
  lines.push(`- VICE rel=${v.rel}, HL rel=${h.rel}, delta=${h.rel - v.rel}`);
  lines.push(``);
}

writeFileSync(outPath, lines.join("\n") + "\n");
console.log(``);
console.log(`report -> ${outPath}`);
inst.closeSync();
