#!/usr/bin/env node
// Sprint 93.2 — instruction-level swimlane diff between headless trace
// and a VICE runtime-trace.jsonl. Finds the first instruction where the
// two diverge.
//
// Usage:
//   node scripts/swimlane-diff.mjs --headless /tmp/headless.jsonl \
//                                  --vice /path/to/vice/runtime-trace.jsonl \
//                                  [--align-pc 0xfce2] [--max 200000]

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const k = a.slice(2); const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true;
    else { o[k] = v; i++; }
  }
  return o;
}

function parseHex(s) {
  if (typeof s !== "string") return Number(s);
  return parseInt(s.replace(/^[$0x]+/i, ""), 16);
}

async function* readJsonl(path) {
  const fh = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: fh, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip */ }
  }
  rl.close();
  fh.destroy();
}

// Normalize headless format to {n, cyc, pc, a, x, y, sp, p, op, mn}.
function normHeadless(rec) {
  if (typeof rec.pc !== "number") return null;
  return {
    cyc: rec.cyc, pc: rec.pc, a: rec.a, x: rec.x, y: rec.y,
    sp: rec.sp, p: rec.p & 0xcf, op: rec.op, mn: rec.mn ?? "",
  };
}

// Normalize VICE runtime-trace instruction event.
function normVice(ev) {
  if (ev.kind !== "instruction") return null;
  const r = ev.registers ?? {};
  if (typeof ev.pc !== "number") return null;
  const op = (ev.instructionBytes ?? [])[0] ?? 0;
  return {
    cyc: Number(ev.clock),
    pc: ev.pc,
    a: r.A ?? 0, x: r.X ?? 0, y: r.Y ?? 0,
    sp: r.SP ?? 0, p: (r.FL ?? 0) & 0xcf, op,
    mn: "",
  };
}

const args = parseArgs(process.argv.slice(2));
const hPath = args.headless;
const vPath = args.vice;
const mode = args.mode ?? "instr";
const alignPc = args["align-pc"] ? parseHex(args["align-pc"]) : 0xfce2;
const maxCmp = Number(args.max ?? 200_000);
const outPath = args.out;
if (!hPath || !vPath) {
  console.error("Usage: --headless <path> --vice <path> [--mode=instr|eof] [--align-pc 0xfce2] [--max N] [--out <md>]");
  process.exit(2);
}

if (mode === "eof") {
  await runEofMode();
  process.exit(0);
}

console.error(`Aligning at PC=$${alignPc.toString(16)} ...`);

// Load both into arrays — both files can be large; we'll stream into
// arrays with normalization + cap to keep memory reasonable.
async function loadCap(path, normalize, cap, alignPc) {
  const out = [];
  let aligned = false;
  for await (const obj of readJsonl(path)) {
    const r = normalize(obj);
    if (!r) continue;
    if (!aligned) {
      if (r.pc === alignPc) aligned = true;
      else continue;
    }
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

const t0 = Date.now();
const [hRows, vRows] = await Promise.all([
  loadCap(hPath, normHeadless, maxCmp, alignPc),
  loadCap(vPath, normVice, maxCmp, alignPc),
]);
console.error(`Loaded headless=${hRows.length} vice=${vRows.length} (${Date.now() - t0}ms)`);

if (hRows.length === 0 || vRows.length === 0) {
  console.error(`Could not align at PC=$${alignPc.toString(16)} in one of the traces.`);
  process.exit(3);
}

const N = Math.min(hRows.length, vRows.length);
const SETTLE_ROWS = 8; // skip register diffs in first N rows (pre-TXS init)
const checkRegs = !args["pc-only"];
let firstDiff = -1;
let firstReason = "";
for (let i = 0; i < N; i++) {
  const h = hRows[i], v = vRows[i];
  if (h.pc !== v.pc) { firstDiff = i; firstReason = "PC"; break; }
  if (h.op !== v.op) { firstDiff = i; firstReason = "opcode"; break; }
  if (checkRegs && i >= SETTLE_ROWS) {
    if (h.a !== v.a) { firstDiff = i; firstReason = `A (${h.a.toString(16)} vs ${v.a.toString(16)})`; break; }
    if (h.x !== v.x) { firstDiff = i; firstReason = `X (${h.x.toString(16)} vs ${v.x.toString(16)})`; break; }
    if (h.y !== v.y) { firstDiff = i; firstReason = `Y (${h.y.toString(16)} vs ${v.y.toString(16)})`; break; }
    if (h.sp !== v.sp) { firstDiff = i; firstReason = `SP (${h.sp.toString(16)} vs ${v.sp.toString(16)})`; break; }
    if ((h.p & 0xcf) !== (v.p & 0xcf)) { firstDiff = i; firstReason = `P (${(h.p&0xcf).toString(16)} vs ${(v.p&0xcf).toString(16)})`; break; }
  }
}

const fmt = (r) => `cyc=${r.cyc} PC=$${r.pc.toString(16).padStart(4,"0")} A=${r.a.toString(16).padStart(2,"0")} X=${r.x.toString(16).padStart(2,"0")} Y=${r.y.toString(16).padStart(2,"0")} SP=${r.sp.toString(16).padStart(2,"0")} P=${(r.p&0xcf).toString(16).padStart(2,"0")} op=${r.op.toString(16).padStart(2,"0")} ${r.mn}`;

if (firstDiff < 0) {
  console.log(`OK — no divergence in first ${N} aligned instructions.`);
  process.exit(0);
}

console.log(`DIVERGENCE at row ${firstDiff} (after ${firstDiff} matched instructions). Reason: ${firstReason}`);
console.log("");
console.log("Last 5 matching:");
for (let i = Math.max(0, firstDiff - 5); i < firstDiff; i++) {
  console.log(`  H ${fmt(hRows[i])}`);
  console.log(`  V ${fmt(vRows[i])}`);
}
console.log("");
console.log("Diverging row:");
console.log(`  H ${fmt(hRows[firstDiff])}`);
console.log(`  V ${fmt(vRows[firstDiff])}`);
console.log("");
console.log("Next 4 (each side independently):");
for (let i = firstDiff + 1; i < Math.min(N, firstDiff + 5); i++) {
  console.log(`  H ${fmt(hRows[i])}`);
  console.log(`  V ${fmt(vRows[i])}`);
}
process.exit(1);

// ---------------------------------------------------------------------------
// EOF mode (Spec 095 M0.2e). Aligns headless + VICE EOF JSONL on EOI rising
// edge, walks per-channel, names the first divergence per channel, writes a
// markdown report.
// ---------------------------------------------------------------------------
async function runEofMode() {
  const hAll = [];
  for await (const obj of readJsonl(hPath)) hAll.push(obj);
  const vAll = [];
  for await (const obj of readJsonl(vPath)) vAll.push(obj);

  const headlessTrace = parseEofTrace(hAll, "headless");
  const viceTrace    = parseEofTrace(vAll, "vice");

  if (!headlessTrace.eoiC64Cyc) {
    console.error("headless trace has no first_eoi moment");
    process.exit(3);
  }
  if (!viceTrace.eoiC64Cyc) {
    console.error("vice trace has no first_eoi moment");
    process.exit(3);
  }

  const channels = ["c64Pc", "drvPc", "iecAtn", "iecClk", "iecData", "z90", "zA5"];
  const summary = {};
  for (const ch of channels) summary[ch] = { samples: 0, mismatches: 0, firstDivCyc: -1, firstHV: null };

  // Walk by relative-cycle alignment.
  let i = 0, j = 0;
  while (i < headlessTrace.samples.length && j < viceTrace.samples.length) {
    const h = headlessTrace.samples[i];
    const v = viceTrace.samples[j];
    const hRel = h.c64Cyc - headlessTrace.eoiC64Cyc;
    const vRel = v.c64Cyc - viceTrace.eoiC64Cyc;
    // Step the side that's behind in relative cycles.
    if (hRel < vRel - 4) { i++; continue; }
    if (vRel < hRel - 4) { j++; continue; }
    for (const ch of channels) {
      const hv = readChannel(h, ch);
      const vv = readChannel(v, ch);
      summary[ch].samples++;
      if (hv !== vv) {
        summary[ch].mismatches++;
        if (summary[ch].firstDivCyc < 0) {
          summary[ch].firstDivCyc = hRel;
          summary[ch].firstHV = { headless: hv, vice: vv, hC64Cyc: h.c64Cyc, vC64Cyc: v.c64Cyc };
        }
      }
    }
    i++; j++;
  }

  const md = renderEofReport({ hPath, vPath, headlessTrace, viceTrace, summary });
  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, md);
    console.error(`wrote ${outPath}`);
  } else {
    console.log(md);
  }
}

function parseEofTrace(rows, expectSource) {
  const samples = [];
  let eoiC64Cyc;
  let header;
  const moments = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.kind === "eof-header" || r.type === "header") {
      header = r;
      continue;
    }
    if (r.type === "summary" || r.kind === "summary") continue;
    if (r.type === "fine") continue;
    if (r.kind === "eof-moment" || r.type === "moment") {
      moments.push(r);
      if (r.name === "first_eoi") eoiC64Cyc = r.c64Cyc;
      continue;
    }
    if (r.kind === "eof-sample" || r.type === "coarse") {
      const c64Cyc = r.c64Cyc ?? r.c64Cyc;
      const drvCyc = r.driveCyc ?? r.drvCyc ?? c64Cyc;
      // Headless coarse exposes raw fields; VICE eof-sample exposes channels.
      const c64Pc = r.c64Pc ?? r.channels?.c64Pc ?? 0;
      const drvPc = r.drvPc ?? r.channels?.drivePc ?? 0;
      const iec = r.iec ?? r.channels?.iec ?? { atn: 0, clk: 0, data: 0 };
      const ram = r.ram ?? null;
      const zp = r.channels?.zp ?? null;
      const z90 = ram?.z90 ?? zp?.["90"] ?? 0;
      const zA5 = ram?.zA5 ?? zp?.["a5"] ?? 0;
      samples.push({ c64Cyc, drvCyc, c64Pc, drvPc, iec, z90, zA5 });
    }
  }
  // Fallback for headless: derive eoiC64Cyc from summary.moments.
  if (eoiC64Cyc === undefined) {
    for (const r of rows) {
      if ((r?.type === "summary" || r?.kind === "summary") && Array.isArray(r.moments)) {
        const m = r.moments.find((x) => x.name === "first_eoi");
        if (m) { eoiC64Cyc = m.c64Cyc; break; }
      }
    }
  }
  void expectSource;
  return { samples, moments, eoiC64Cyc, header };
}

function readChannel(s, ch) {
  switch (ch) {
    case "c64Pc": return s.c64Pc;
    case "drvPc": return s.drvPc;
    case "iecAtn": return s.iec.atn ? 1 : 0;
    case "iecClk": return s.iec.clk ? 1 : 0;
    case "iecData": return s.iec.data ? 1 : 0;
    case "z90": return s.z90;
    case "zA5": return s.zA5;
    default: return 0;
  }
}

function pickSuspect(summary) {
  // Order matters: first divergence in this priority list names the
  // suspect subsystem.
  const order = [
    { ch: "drvPc",   subsystem: "drive ROM TALK" },
    { ch: "iecClk",  subsystem: "IEC edge timing (CLK)" },
    { ch: "iecData", subsystem: "IEC edge timing (DATA)" },
    { ch: "iecAtn",  subsystem: "ATN ACK" },
    { ch: "c64Pc",   subsystem: "C64 KERNAL ACPTR retry" },
    { ch: "z90",     subsystem: "C64 KERNAL status byte" },
    { ch: "zA5",     subsystem: "C64 KERNAL EOI counter" },
  ];
  let earliest = null;
  for (const o of order) {
    const s = summary[o.ch];
    if (s.mismatches === 0) continue;
    if (!earliest || s.firstDivCyc < earliest.firstDivCyc) {
      earliest = { ...o, firstDivCyc: s.firstDivCyc, firstHV: s.firstHV };
    }
  }
  return earliest;
}

function renderEofReport({ hPath, vPath, headlessTrace, viceTrace, summary }) {
  const lines = [];
  lines.push(`# EOF Trace Diff Report`);
  lines.push("");
  lines.push(`- headless trace: \`${hPath}\``);
  lines.push(`- vice trace: \`${vPath}\``);
  lines.push(`- alignment cycle (EOI rising edge):`);
  lines.push(`  - headless c64Cyc=\`${headlessTrace.eoiC64Cyc}\``);
  lines.push(`  - vice c64Cyc=\`${viceTrace.eoiC64Cyc}\``);
  lines.push("");
  lines.push(`## Per-channel summary`);
  lines.push("");
  lines.push(`| channel | samples | mismatches | first divergence (rel cyc) |`);
  lines.push(`|---------|--------:|-----------:|---------------------------:|`);
  for (const ch of Object.keys(summary)) {
    const s = summary[ch];
    const div = s.firstDivCyc >= 0 ? String(s.firstDivCyc) : "(none)";
    lines.push(`| ${ch} | ${s.samples} | ${s.mismatches} | ${div} |`);
  }
  lines.push("");
  lines.push(`## First divergence detail`);
  lines.push("");
  for (const ch of Object.keys(summary)) {
    const s = summary[ch];
    if (s.firstDivCyc < 0) continue;
    const hv = s.firstHV;
    lines.push(`- **${ch}** at relCyc=${s.firstDivCyc}: headless=${formatVal(hv.headless)} vice=${formatVal(hv.vice)} (h.c64Cyc=${hv.hC64Cyc}, v.c64Cyc=${hv.vC64Cyc})`);
  }
  lines.push("");
  const suspect = pickSuspect(summary);
  if (suspect) {
    lines.push(`## Suspect subsystem`);
    lines.push("");
    lines.push(`**${suspect.subsystem}** — earliest channel divergence is on \`${suspect.ch}\` at relCyc=${suspect.firstDivCyc}.`);
  } else {
    lines.push(`## Suspect subsystem`);
    lines.push("");
    lines.push(`No divergence within sampled window — both sides agree across all channels.`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatVal(v) {
  if (typeof v !== "number") return String(v);
  return `$${v.toString(16)}`;
}
