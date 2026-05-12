#!/usr/bin/env node
// Spec 205-B c2 — first-divergence diff CLI.
//
// Compares VICE trace.jsonl against headless-trace.jsonl (or any two
// kernel-channel JSONL artifacts) and reports the first cycle where
// they disagree. Designed for motm/MM root-cause work per handover
// "Next Session Entry Points → C".
//
// Usage:
//   node scripts/diff-trace.mjs --vice <path> --ours <path>
//                                [--format snapshot|channel]
//                                [--channel bus_access]
//                                [--tolerance 100000]
//                                [--fields c64Pc,drvPc,dd00,drvPb]
//                                [--context 5]
//
// Examples:
//   # Default snapshot-tuple diff for motm:
//   node scripts/diff-trace.mjs \
//       --vice samples/traces/v2-baseline/motm/trace.jsonl \
//       --ours samples/traces/v2-baseline/motm/headless-trace.jsonl
//
//   # Per-channel kernel diff (run two sessions, dump bus_access JSONL):
//   node scripts/diff-trace.mjs --format channel --channel bus_access \
//       --vice baseline.jsonl --ours run.jsonl

import {
  loadJsonl,
  detectFormat,
  firstSnapshotDivergence,
  firstChannelDivergence,
} from "./lib/trace-diff.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = v;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.vice || !args.ours) {
  console.error("usage: diff-trace.mjs --vice <path> --ours <path> [--format snapshot|channel] [--channel <name>] [--tolerance <cycles>] [--fields a,b,c]");
  process.exit(2);
}

const vice = loadJsonl(args.vice);
const ours = loadJsonl(args.ours);
const format = args.format ?? detectFormat(vice);

console.log(`vice : ${args.vice} (${vice.length} records, format = ${detectFormat(vice)})`);
console.log(`ours : ${args.ours} (${ours.length} records, format = ${detectFormat(ours)})`);
console.log(`mode : ${format}`);

let result;
if (format === "snapshot") {
  const tolerance = args.tolerance ? Number(args.tolerance) : undefined;
  const fields = args.fields ? String(args.fields).split(",").map((s) => s.trim()) : undefined;
  result = firstSnapshotDivergence(vice, ours, { tolerance, fields });
} else if (format === "channel") {
  const channel = args.channel;
  if (!channel) {
    console.error("--channel required for channel-format diff");
    process.exit(2);
  }
  const fields = args.fields ? String(args.fields).split(",").map((s) => s.trim()) : undefined;
  result = firstChannelDivergence(vice, ours, { channel, fields });
} else {
  console.error(`unknown format: ${format}`);
  process.exit(2);
}

console.log("---");
if (result.kind === "no-divergence") {
  console.log(`OK no divergence (${result.samples ?? 0} samples on ${result.channel ?? "snapshot"} stream)`);
  process.exit(0);
}

if (result.kind === "snapshot-divergence") {
  console.log(`DIVERGENCE  ts=${result.ts}  ourTs=${result.ourTs}  field=${result.field}`);
  console.log(`  vice : ${formatVal(result.vice)}`);
  console.log(`  ours : ${formatVal(result.ours)}`);
  console.log(`  context vice : ${JSON.stringify(result.context.vice)}`);
  console.log(`  context ours : ${JSON.stringify(result.context.ours)}`);
} else if (result.kind === "channel-divergence") {
  console.log(`DIVERGENCE  channel=${result.channel}  index=${result.index}  ts=${result.ts}  ourTs=${result.ourTs}`);
  console.log(`  field=${result.field}`);
  console.log(`  vice : ${formatVal(result.vice)}`);
  console.log(`  ours : ${formatVal(result.ours)}`);
  console.log(`  context vice : ${JSON.stringify(result.context.vice)}`);
  console.log(`  context ours : ${JSON.stringify(result.context.ours)}`);
} else if (result.kind === "channel-length-mismatch") {
  console.log(`LENGTH MISMATCH on channel ${result.channel}: vice=${result.viceLen} ours=${result.ourLen}`);
} else if (result.kind === "empty-channel") {
  console.log(`EMPTY CHANNEL ${result.channel}: vice=${result.viceLen} ours=${result.ourLen}`);
} else if (result.kind === "empty-input") {
  console.log(`EMPTY INPUT: viceLen=${result.viceLen} ourLen=${result.ourLen}`);
} else {
  console.log(`unexpected result: ${JSON.stringify(result)}`);
}
process.exit(1);

function formatVal(v) {
  if (typeof v === "number") {
    if (v >= 0 && v <= 0xffff) return `${v} ($${v.toString(16).padStart(4, "0")})`;
    return String(v);
  }
  return JSON.stringify(v);
}
