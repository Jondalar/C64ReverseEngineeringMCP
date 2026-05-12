#!/usr/bin/env node
// Spec 143 — VICE/headless IEC bus-access diff.
//
// Inputs: two JSONL files, both in Spec 142 BusAccessEvent schema.
//   --theirs <path>   VICE-side capture (from vice-iec-capture.mjs)
//   --ours   <path>   Headless-side capture (from bus-trace-motm.mjs)
//
// Output: JSON + Markdown report identifying first divergence.
//   --out-json <path>
//   --out-md   <path>
//
// Diff algorithm:
//   1. Sequence-align by (side, op, addr) tuple. Cycle is tiebreaker
//      only — small skew expected (different cycle reference points).
//   2. At first index where alignment fails OR (side, op, addr)
//      matches but `value` or `iec.{atn,clk,data}` differ, classify:
//        - c64_output_divergence
//        - drive_sample_divergence
//        - cached_port_divergence (line state differs but value matches)
//        - irq_timing_divergence (PC differs at same logical event)
//        - dispatch_divergence (PC region one side never visits)
//   3. Build byte-stream per side from drive $1800 reads in motm
//      receive loop ($07C1 / $042F-$044C). Diff at byte index.
//
// Usage:
//   npm run trace:motm-diff -- --theirs traces/motm_vice.jsonl --ours traces/motm_headless.jsonl

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.theirs || !args.ours) {
  console.error("Usage: vice-iec-diff.mjs --theirs <vice.jsonl> --ours <headless.jsonl> [--out-json <p>] [--out-md <p>]");
  process.exit(2);
}

function loadJsonl(path) {
  if (!existsSync(path)) {
    console.error(`Missing file: ${path}`);
    process.exit(2);
  }
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => {
    const j = JSON.parse(l);
    // Channel events from TraceRegistry wrap as {ts, channel, data}.
    // Direct events (from VICE adapter) should be flat.
    return j.data ? j.data : j;
  });
}

const theirs = loadJsonl(args.theirs);
const ours = loadJsonl(args.ours);

console.error(`Loaded: theirs=${theirs.length} events, ours=${ours.length} events`);

// ---- Diff algorithm ----

// Align by (side, op, addr) sequence. Walk both with two pointers.
// Skew counts: how many extra events one side has at any moment.
function findFirstDivergence(t, o) {
  let i = 0, j = 0;
  while (i < t.length && j < o.length) {
    const a = t[i], b = o[j];
    const sameKey =
      a.side === b.side && a.op === b.op && a.addr === b.addr;

    if (sameKey) {
      const valDiff = a.value !== b.value;
      const iecDiff =
        a.iec?.atn !== b.iec?.atn ||
        a.iec?.clk !== b.iec?.clk ||
        a.iec?.data !== b.iec?.data;
      if (valDiff || iecDiff) {
        return classifyAt(i, j, a, b, t, o);
      }
      i++; j++;
      continue;
    }

    // Misalignment — classify
    return classifyAt(i, j, a, b, t, o);
  }

  if (i < t.length) {
    return {
      type: "trailing_theirs",
      first_idx_theirs: i,
      first_idx_ours: o.length,
      message: `theirs has ${t.length - i} more events after ours ended`,
      their_event: t[i] ?? null,
      our_event: null,
    };
  }
  if (j < o.length) {
    return {
      type: "trailing_ours",
      first_idx_theirs: t.length,
      first_idx_ours: j,
      message: `ours has ${o.length - j} more events after theirs ended`,
      their_event: null,
      our_event: o[j] ?? null,
    };
  }
  return null; // No divergence
}

function classifyAt(i, j, a, b, t, o) {
  const sameKey =
    a?.side === b?.side && a?.op === b?.op && a?.addr === b?.addr;

  if (!sameKey) {
    return {
      type: a?.side !== b?.side ? "dispatch_divergence" : "out_of_order",
      first_idx_theirs: i,
      first_idx_ours: j,
      message: `event-key mismatch at index theirs[${i}], ours[${j}]`,
      their_event: a,
      our_event: b,
    };
  }

  const valDiff = a.value !== b.value;
  const iecDiff =
    a.iec?.atn !== b.iec?.atn ||
    a.iec?.clk !== b.iec?.clk ||
    a.iec?.data !== b.iec?.data;

  let type;
  if (valDiff && iecDiff) {
    type = "value_and_line_state_divergence";
  } else if (valDiff && !iecDiff) {
    if (a.side === "c64") type = "c64_output_divergence";
    else type = "drive_sample_divergence";
  } else if (!valDiff && iecDiff) {
    type = "cached_port_divergence";
  } else {
    type = "unknown";
  }

  return {
    type,
    first_idx_theirs: i,
    first_idx_ours: j,
    message: `value-or-iec mismatch at theirs[${i}] / ours[${j}]: side=${a.side} op=${a.op} addr=$${a.addr.toString(16)} valTheirs=$${a.value.toString(16)} valOurs=$${b.value.toString(16)}`,
    their_event: a,
    our_event: b,
    pc_mismatch: a.pc !== b.pc,
  };
}

// Decode motm 24-bit receive byte stream from drive $1800 reads.
// Heuristic: drive reads $1800 in tight loop ($07C1 BIT $1800 + BEQ).
// Each CLK toggle (0→1 then 1→0) = one bit. After 24 bits, a logical
// receive byte is decoded. We fall back to "sequence of $1800 read
// values" if loop pattern not detected.
function extractReceiveBytes(events) {
  const drive1800Reads = events.filter(
    (e) => e.side === "drive" && e.op === "read" && e.addr === 0x1800
  );
  // For Spec 143 V1 we just expose first 32 unique read-values in
  // chronological order. Real bit-decode = follow-up if needed.
  const values = drive1800Reads.map((e) => e.value);
  return values.slice(0, 32);
}

const div = findFirstDivergence(theirs, ours);
const theirBytes = extractReceiveBytes(theirs);
const ourBytes = extractReceiveBytes(ours);

let firstByteDiff = -1;
const minLen = Math.min(theirBytes.length, ourBytes.length);
for (let k = 0; k < minLen; k++) {
  if (theirBytes[k] !== ourBytes[k]) {
    firstByteDiff = k;
    break;
  }
}

// ---- Report ----

const report = {
  scenario: args.scenario ?? "motm",
  their_events: theirs.length,
  our_events: ours.length,
  divergence: div,
  byte_streams: {
    theirs: theirBytes.map((v) => `0x${v.toString(16).padStart(2, "0")}`),
    ours: ourBytes.map((v) => `0x${v.toString(16).padStart(2, "0")}`),
    first_diff_idx: firstByteDiff,
  },
  trace_paths: {
    theirs: resolve(args.theirs),
    ours: resolve(args.ours),
  },
};

const outJson = args["out-json"]
  ? resolve(args["out-json"])
  : args.theirs.replace(/\.jsonl$/, "_diff.json");
const outMd = args["out-md"]
  ? resolve(args["out-md"])
  : args.theirs.replace(/\.jsonl$/, "_diff.md");

mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(report, null, 2));

const md = renderMarkdown(report);
writeFileSync(outMd, md);

console.error(`Report JSON: ${outJson}`);
console.error(`Report MD:   ${outMd}`);
console.error(``);
console.log(md);

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# VICE/Headless IEC diff — ${r.scenario}`);
  lines.push("");
  lines.push(`- theirs (VICE): ${r.their_events} events`);
  lines.push(`- ours (headless): ${r.our_events} events`);
  lines.push(`- theirs trace: ${r.trace_paths.theirs}`);
  lines.push(`- ours trace: ${r.trace_paths.ours}`);
  lines.push("");
  if (r.divergence === null) {
    lines.push("## Result: TRACES MATCH");
    lines.push("");
    lines.push("No divergence detected within compared events.");
  } else {
    lines.push(`## First divergence: \`${r.divergence.type}\``);
    lines.push("");
    lines.push(`- Index theirs: ${r.divergence.first_idx_theirs}`);
    lines.push(`- Index ours: ${r.divergence.first_idx_ours}`);
    lines.push(`- Detail: ${r.divergence.message}`);
    lines.push("");
    if (r.divergence.their_event) {
      lines.push(`### theirs event`);
      lines.push("```json");
      lines.push(JSON.stringify(r.divergence.their_event, null, 2));
      lines.push("```");
    }
    if (r.divergence.our_event) {
      lines.push(`### ours event`);
      lines.push("```json");
      lines.push(JSON.stringify(r.divergence.our_event, null, 2));
      lines.push("```");
    }
  }
  lines.push("");
  lines.push(`## Byte stream (drive $1800 reads, first 32)`);
  lines.push("");
  lines.push(`- theirs: ${r.byte_streams.theirs.join(" ")}`);
  lines.push(`- ours:   ${r.byte_streams.ours.join(" ")}`);
  lines.push(`- first byte-level diff: ${r.byte_streams.first_diff_idx === -1 ? "(none in window)" : `index ${r.byte_streams.first_diff_idx}`}`);
  return lines.join("\n");
}
