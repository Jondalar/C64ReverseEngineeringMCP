#!/usr/bin/env node
// Spec 816 — sprite-detection precision/recall measurement.
//
// The sprite analyzer scores a 64-byte block additively with generous floors,
// so a block that fails EVERY shape criterion still scores 0.49 against a 0.66
// threshold. Measured before the fix: 87-100 % of all blocks in real PRGs pass.
// This harness turns that into a number the branch can be judged by.
//
// Three corpora, each answering a different question:
//
//   negative  — VICE test programs (cia/drive/lorenz). Pure 6502 test code,
//               no sprite in any of them. EVERY sprite byte here is a false
//               positive. This is the precision number.
//   field     — real game/loader PRGs from samples/ + analysis/tmp. No ground
//               truth; reported as a trend, not a verdict.
//   positive  — two synthesized PRGs with REAL sprite shapes (contiguous
//               figures, padding byte 0) embedded between blocks of real 6502
//               code. This is the recall guard: a precision fix that also
//               stops finding actual sprites is not a fix.
//               - aligned   : the unclaimed region starts on a $40 boundary
//               - unaligned : the region starts at +$18, the sprites still sit
//                             on the $40 grid. Bug 27 (`start & 0x3f`) rejects
//                             every candidate here, so before the scan-phase
//                             fix this file finds NOTHING — silent blindness,
//                             not a false positive.
//
// Usage:
//   node scripts/measure-816-sprite-precision.mjs [--json <out>] [--label <name>]
//   node scripts/measure-816-sprite-precision.mjs --compare <before.json> <after.json>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist/pipeline/cli.cjs");
const WORK = join(ROOT, "analysis/tmp/spec-816");

// ---------------------------------------------------------------- corpora

function walkPrgs(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop();
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".prg") && statSync(path).size >= 2048) out.push(path);
      if (out.length >= limit) break;
    }
  }
  return out.sort();
}

function negativeCorpus() {
  return walkPrgs(join(ROOT, "samples/vice-testprogs"), 24);
}

function fieldCorpus() {
  const paths = [
    join(ROOT, "samples/lnr_boot_02a7_fff7.prg"),
    ...walkPrgs(join(ROOT, "analysis/tmp/crystian_extract"), 6),
    join(ROOT, "analysis/tmp/headless-accolade/newrunf.prg"),
  ];
  return paths.filter((p) => existsSync(p));
}

// ------------------------------------------------- synthetic positive control

// Eight 24x21 shapes drawn as strings. A real sprite is a contiguous figure:
// row n and row n+1 overlap heavily, and the 64th byte is padding.
const SHAPES = [
  // ball
  [
    "........########........",
    ".....##############.....",
    "...##################...",
    "..####################..",
    ".######################.",
    ".######################.",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    ".######################.",
    ".######################.",
    "..####################..",
    "...##################...",
    ".....##############.....",
    "........########........",
    "........................",
  ],
  // ship / arrow
  [
    "...........##...........",
    "..........####..........",
    "..........####..........",
    ".........######.........",
    ".........######.........",
    "........########........",
    "........########........",
    ".......##########.......",
    ".......##########.......",
    "......############......",
    "......############......",
    ".....##############.....",
    ".....##############.....",
    "....################....",
    "....################....",
    "...##################...",
    "..####..########..####..",
    "..###....######....###..",
    "..##......####......##..",
    "...........##...........",
    "........................",
  ],
  // humanoid
  [
    ".........######.........",
    ".........######.........",
    ".........######.........",
    "..........####..........",
    ".....##############.....",
    "....################....",
    "...####..####..####.....",
    "...###...####...###.....",
    "........######..........",
    "........######..........",
    "........######..........",
    "........######..........",
    ".......########.........",
    "......####..####........",
    "......###....###........",
    ".....###......###.......",
    ".....###......###.......",
    "....####......####......",
    "....####......####......",
    "...#####......#####.....",
    "........................",
  ],
  // car
  [
    "........................",
    "........................",
    ".....##############.....",
    "....################....",
    "...##..##########..##...",
    "..###..##########..###..",
    ".####################...",
    "########################",
    "########################",
    "########################",
    "##..################..##",
    "##..################..##",
    "########################",
    "########################",
    ".######################.",
    "..####............####..",
    "..###..............###..",
    "..###..............###..",
    "...##..............##...",
    "........................",
    "........................",
  ],
  // letter A
  [
    "..........####..........",
    ".........######.........",
    "........########........",
    "........##....##........",
    ".......##......##.......",
    ".......##......##.......",
    "......##........##......",
    "......##........##......",
    ".....##..........##.....",
    ".....##..........##.....",
    "....################....",
    "....################....",
    "...##..............##...",
    "...##..............##...",
    "..##................##..",
    "..##................##..",
    ".##..................##.",
    ".##..................##.",
    "##....................##",
    "##....................##",
    "........................",
  ],
  // star
  [
    "...........##...........",
    "..........####..........",
    "..........####..........",
    ".........######.........",
    ".........######.........",
    "########################",
    ".######################.",
    "..####################..",
    "...##################...",
    "....################....",
    ".....##############.....",
    "....################....",
    "....###..######..###....",
    "...###....####....###...",
    "..###......##......###..",
    "..##................##..",
    ".##..................##.",
    "##....................##",
    "........................",
    "........................",
    "........................",
  ],
  // blob
  [
    "........................",
    "......############......",
    "....################....",
    "...##################...",
    "..####################..",
    ".######################.",
    ".######################.",
    "########################",
    "########################",
    "########.####.##########",
    "#######..####..#########",
    "########.####.##########",
    "########################",
    "########################",
    ".######################.",
    ".######################.",
    "..####################..",
    "...##################...",
    ".....##############.....",
    "........########........",
    "........................",
  ],
  // key
  [
    "......########..........",
    "....############........",
    "...####......####.......",
    "..###..........###......",
    "..##............##......",
    "..##....####....##......",
    "..##...######...##......",
    "..##....####....##......",
    "..##............##......",
    "..###..........###......",
    "...####......####.......",
    "....############........",
    "......########..........",
    "........####............",
    "........####............",
    "........######..........",
    "........####............",
    "........######..........",
    "........####............",
    "........####............",
    "........................",
  ],
];

function shapeToSpriteBlock(rows) {
  const block = new Uint8Array(64);
  for (let row = 0; row < 21; row += 1) {
    const line = rows[row] ?? "";
    for (let byteIndex = 0; byteIndex < 3; byteIndex += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        if (line[byteIndex * 8 + bit] === "#") value |= 0x80 >> bit;
      }
      block[row * 3 + byteIndex] = value;
    }
  }
  block[63] = 0; // sprite padding byte
  return block;
}

function realCodeBytes(length) {
  // Real 6502 from the VICE test corpus, so the filler around the sprites has
  // the statistics of code rather than of a random-number generator.
  const donors = walkPrgs(join(ROOT, "samples/vice-testprogs"), 8);
  const chunks = [];
  let total = 0;
  for (const donor of donors) {
    const body = readFileSync(donor).subarray(2);
    chunks.push(body);
    total += body.length;
    if (total >= length) break;
  }
  const out = new Uint8Array(length);
  let cursor = 0;
  let donorIndex = 0;
  while (cursor < length) {
    const chunk = chunks[donorIndex % chunks.length];
    const take = Math.min(chunk.length, length - cursor);
    out.set(chunk.subarray(0, take), cursor);
    cursor += take;
    donorIndex += 1;
  }
  return out;
}

/**
 * `leadBytes` of real 6502, then `padBytes` of filler, then the eight sprite
 * blocks, then more code. The sprites always start on the absolute $40 grid;
 * `padBytes` decides whether the UNCLAIMED REGION around them does too. With
 * padBytes = 0 the region opens on the grid; with padBytes = 24 it opens 24
 * bytes early, which is the case Bug 27 (`start & 0x3f`) discards without a
 * word.
 */
function buildSpritePrg(loadAddress, leadBytes, padBytes, trailBytes) {
  const sprites = SHAPES.map(shapeToSpriteBlock);
  const spriteBytes = new Uint8Array(sprites.length * 64);
  sprites.forEach((block, index) => spriteBytes.set(block, index * 64));

  const spriteStart = loadAddress + leadBytes + padBytes;
  if ((spriteStart & 0x3f) !== 0) {
    throw new Error(`sprite start $${spriteStart.toString(16)} is not $40-aligned — fixture is wrong`);
  }

  const body = new Uint8Array(leadBytes + padBytes + spriteBytes.length + trailBytes);
  body.set(realCodeBytes(leadBytes), 0);
  body.fill(0xea, leadBytes, leadBytes + padBytes); // NOP filler, claimed by nobody
  body.set(spriteBytes, leadBytes + padBytes);
  body.set(realCodeBytes(trailBytes), leadBytes + padBytes + spriteBytes.length);

  const prg = new Uint8Array(body.length + 2);
  prg[0] = loadAddress & 0xff;
  prg[1] = (loadAddress >> 8) & 0xff;
  prg.set(body, 2);
  return { prg, spriteStart, spriteEnd: spriteStart + spriteBytes.length - 1 };
}

/**
 * Spec 816.2 fixture. A real screen at $4400 whose sprite pointers at $47F8
 * name the block at $4800, and sprite data whose padding byte is DELIBERATELY
 * junk. Without the pointer the run-level padding gate throws it away; with
 * the pointer it is direct evidence and survives. That is the whole point of
 * the anchor, isolated.
 */
function buildPointerPrg() {
  const load = 0x4000;
  const screen = 0x4400;
  const spriteStart = 0x4800;
  const size = 0x1000; // $4000-$4FFF
  const body = new Uint8Array(size);

  // LDA #$02 / STA $DD00  → CIA2 bank select, VIC bank base $4000
  // LDA #$10 / STA $D018  → VM = 1, video matrix at bankBase+$0400 = $4400
  // RTS
  body.set([0xa9, 0x02, 0x8d, 0x00, 0xdd, 0xa9, 0x10, 0x8d, 0x18, 0xd0, 0x60], 0);
  body.set(realCodeBytes(screen - load - 11), 11);

  // The video matrix: spaces, then eight pointers to $4800 ( ($4800-$4000)/64 ).
  body.fill(0x20, screen - load, screen - load + 0x3f8);
  const pointer = (spriteStart - load) / 64;
  for (let slot = 0; slot < 8; slot += 1) {
    body[screen - load + 0x3f8 + slot] = pointer;
  }

  const sprites = SHAPES.map(shapeToSpriteBlock);
  sprites.forEach((block, index) => {
    const withJunkPadding = new Uint8Array(block);
    withJunkPadding[63] = 0xff; // hand-packed data reusing the unused byte
    body.set(withJunkPadding, spriteStart - load + index * 64);
  });
  body.set(realCodeBytes(size - (spriteStart - load) - sprites.length * 64), spriteStart - load + sprites.length * 64);

  const prg = new Uint8Array(body.length + 2);
  prg[0] = load & 0xff;
  prg[1] = (load >> 8) & 0xff;
  prg.set(body, 2);
  return { prg, spriteStart, spriteEnd: spriteStart + sprites.length * 64 - 1 };
}

function writePositiveFixtures() {
  mkdirSync(WORK, { recursive: true });
  const specs = [
    { name: "positive_aligned", lead: 1024, pad: 0 },
    { name: "positive_unaligned", lead: 1000, pad: 24 },
  ];
  const fixtures = specs.map(({ name, lead, pad }) => {
    const built = buildSpritePrg(0x2000, lead, pad, 512);
    const path = join(WORK, `${name}.prg`);
    writeFileSync(path, built.prg);
    return { path, name, ...built };
  });

  const pointerFixture = buildPointerPrg();
  const pointerPath = join(WORK, "positive_pointer.prg");
  writeFileSync(pointerPath, pointerFixture.prg);
  fixtures.push({ path: pointerPath, name: "positive_pointer", ...pointerFixture });

  return fixtures;
}

// ---------------------------------------------------------------- measuring

function analyze(prgPath) {
  mkdirSync(WORK, { recursive: true });
  const outJson = join(WORK, `${relative(ROOT, prgPath).replace(/[^a-z0-9]+/gi, "_")}.analysis.json`);
  execFileSync(process.execPath, [CLI, "analyze-prg", prgPath, outJson], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, C64RE_PROJECT_DIR: WORK },
  });
  return JSON.parse(readFileSync(outJson, "utf8"));
}

function spriteStats(report, fileBytes) {
  // Two levels, because they answer different questions. The analyzer's own
  // CANDIDATES are what the scorer believes; the resolved SEGMENTS are what
  // survived overlap resolution against code/charset/text. Noise the resolver
  // happens to bury is still noise — it steers the LLM through
  // `analyzerResults` and it is what a raised threshold would remove.
  const candidates = (report.analyzerResults ?? [])
    .filter((result) => result.analyzerId === "sprite")
    .flatMap((result) => result.candidates ?? []);
  const segments = (report.segments ?? []).filter((segment) => segment.kind === "sprite");

  const sum = (list) => list.reduce((total, item) => total + (item.end - item.start + 1), 0);
  const confidence = (item) => item.confidence ?? item.score?.confidence ?? 0;

  return {
    candidates: candidates.length,
    candidateBytes: sum(candidates),
    segments: segments.length,
    bytes: sum(segments),
    sharePct: fileBytes > 0 ? (100 * sum(segments)) / fileBytes : 0,
    candidateSharePct: fileBytes > 0 ? (100 * sum(candidates)) / fileBytes : 0,
    maxConfidence: candidates.length > 0 ? Math.max(...candidates.map(confidence)) : 0,
    ranges: segments.map((segment) => `$${segment.start.toString(16).toUpperCase()}-$${segment.end.toString(16).toUpperCase()}`),
    candidateRanges: candidates.map((c) => `$${c.start.toString(16).toUpperCase()}-$${c.end.toString(16).toUpperCase()}`),
  };
}

function measureCorpus(name, paths) {
  const files = [];
  for (const path of paths) {
    const fileBytes = statSync(path).size - 2;
    let stats;
    try {
      stats = spriteStats(analyze(path), fileBytes);
    } catch (error) {
      stats = {
        candidates: 0, candidateBytes: 0, segments: 0, bytes: 0, sharePct: 0, candidateSharePct: 0,
        maxConfidence: 0, ranges: [], candidateRanges: [], error: String(error.message ?? error).slice(0, 120),
      };
    }
    files.push({ file: relative(ROOT, path), fileBytes, ...stats });
  }
  const total = (key) => files.reduce((sum, f) => sum + f[key], 0);
  const totalBytes = total("fileBytes");
  return {
    name,
    files,
    totals: {
      files: files.length,
      fileBytes: totalBytes,
      candidates: total("candidates"),
      candidateBytes: total("candidateBytes"),
      candidateSharePct: totalBytes > 0 ? (100 * total("candidateBytes")) / totalBytes : 0,
      spriteBytes: total("bytes"),
      sharePct: totalBytes > 0 ? (100 * total("bytes")) / totalBytes : 0,
      filesWithCandidates: files.filter((f) => f.candidates > 0).length,
      filesWithSprites: files.filter((f) => f.segments > 0).length,
    },
  };
}

function overlapsPlanted(ranges, fixture) {
  return ranges.some((range) => {
    const [start, end] = range.replace(/\$/g, "").split("-").map((value) => parseInt(value, 16));
    return start <= fixture.spriteEnd && end >= fixture.spriteStart;
  });
}

function measurePositives(fixtures) {
  const files = [];
  for (const fixture of fixtures) {
    const fileBytes = statSync(fixture.path).size - 2;
    const stats = spriteStats(analyze(fixture.path), fileBytes);
    const wanted = `$${fixture.spriteStart.toString(16).toUpperCase()}-$${fixture.spriteEnd.toString(16).toUpperCase()}`;
    files.push({
      file: fixture.name,
      wanted,
      found: stats.candidateRanges.length > 0 ? stats.candidateRanges.join(" ") : "-",
      hit: overlapsPlanted(stats.candidateRanges, fixture),
      survived: overlapsPlanted(stats.ranges, fixture),
      ...stats,
    });
  }
  return {
    name: "positive",
    files,
    totals: {
      files: files.length,
      hits: files.filter((f) => f.hit).length,
      survived: files.filter((f) => f.survived).length,
    },
  };
}

// ---------------------------------------------------------------- reporting

function pct(value) {
  return `${value.toFixed(1)} %`;
}

function report(result) {
  const lines = [];
  lines.push(`\n## ${result.label ?? "measurement"}`);
  for (const corpus of result.corpora) {
    lines.push(`\n### ${corpus.name}`);
    if (corpus.name === "positive") {
      for (const f of corpus.files) {
        lines.push(
          `  ${f.hit ? "HIT " : "MISS"} ${f.file.padEnd(20)} wanted ${f.wanted}  found ${f.found}` +
            `${f.hit && !f.survived ? "  (candidate only — lost overlap resolution)" : ""}`,
        );
      }
      lines.push(
        `  → ${corpus.totals.hits}/${corpus.totals.files} planted blocks found by the analyzer, ` +
          `${corpus.totals.survived}/${corpus.totals.files} survived into the report`,
      );
      continue;
    }
    for (const f of corpus.files) {
      const flag = f.candidates > 0 ? "!" : " ";
      lines.push(
        `  ${flag} ${f.file.padEnd(56)} ${String(f.candidates).padStart(3)} cand ${String(f.candidateBytes).padStart(6)} B  ` +
          `→ ${String(f.segments).padStart(2)} seg ${String(f.bytes).padStart(6)} B`,
      );
    }
    const t = corpus.totals;
    lines.push(
      `  → candidates: ${t.filesWithCandidates}/${t.files} files, ${t.candidateBytes} B = ${pct(t.candidateSharePct)} of corpus` +
        `  |  resolved segments: ${t.filesWithSprites}/${t.files} files, ${t.spriteBytes} B = ${pct(t.sharePct)}`,
    );
  }
  return lines.join("\n");
}

function compare(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const lines = [`\n## Comparison — ${before.label} → ${after.label}\n`];
  lines.push("| corpus | metric | before | after |");
  lines.push("|---|---|---|---|");
  for (const [index, corpus] of before.corpora.entries()) {
    const other = after.corpora[index];
    if (corpus.name === "positive") {
      lines.push(`| positive | planted blocks found | ${corpus.totals.hits}/${corpus.totals.files} | ${other.totals.hits}/${other.totals.files} |`);
      lines.push(`| positive | survived into report | ${corpus.totals.survived}/${corpus.totals.files} | ${other.totals.survived}/${other.totals.files} |`);
      continue;
    }
    const short = corpus.name.split(" ")[0];
    lines.push(`| ${short} | files with candidates | ${corpus.totals.filesWithCandidates}/${corpus.totals.files} | ${other.totals.filesWithCandidates}/${other.totals.files} |`);
    lines.push(`| ${short} | candidate bytes | ${corpus.totals.candidateBytes} (${pct(corpus.totals.candidateSharePct)}) | ${other.totals.candidateBytes} (${pct(other.totals.candidateSharePct)}) |`);
    lines.push(`| ${short} | resolved sprite bytes | ${corpus.totals.spriteBytes} (${pct(corpus.totals.sharePct)}) | ${other.totals.spriteBytes} (${pct(other.totals.sharePct)}) |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- entry

function main() {
  const args = process.argv.slice(2);
  const compareIndex = args.indexOf("--compare");
  if (compareIndex >= 0) {
    console.log(compare(args[compareIndex + 1], args[compareIndex + 2]));
    return;
  }
  if (!existsSync(CLI)) {
    console.error(`dist/pipeline/cli.cjs missing — run \`npm run build\` first`);
    process.exit(2);
  }
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : "unlabelled";
  const jsonIndex = args.indexOf("--json");

  const fixtures = writePositiveFixtures();
  const result = {
    label,
    generatedAt: new Date().toISOString(),
    corpora: [
      measureCorpus("negative (VICE test programs — no sprites exist here)", negativeCorpus()),
      measureCorpus("field (real game/loader PRGs — trend only)", fieldCorpus()),
      measurePositives(fixtures),
    ],
  };

  console.log(report(result));
  if (jsonIndex >= 0) {
    const out = resolve(args[jsonIndex + 1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${relative(ROOT, out)}`);
  }
}

main();
