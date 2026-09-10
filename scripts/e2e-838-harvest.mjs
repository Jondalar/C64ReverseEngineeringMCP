#!/usr/bin/env node
// Spec 838 D2 — a harvest may not invent bytes (issue #17).
//
// THE DEFECT. `sandbox_depack` and the sandbox harvest returned a CONTIGUOUS RAM
// window with no signal for which bytes the routine actually WROTE. A multi-block
// depacker writes DISJOINT runs, so between them the caller got whatever the
// machine happened to hold — power-on pattern, KERNAL RAM-test leftovers, screen
// RAM, or bytes the caller itself had loaded — and nothing distinguished that from
// real payload. The reporter lost significant time to it on a 3-disk game with a
// custom backward-LZ packer.
//
// THE RULE, and it is Spec 832 D4 with different bytes: tolerant is not the same
// as inventing. An unreadable thing yields NO bytes rather than plausible ones. So
// only the bytes a run STORED are payload; a byte it never stored is a HOLE, and a
// hole is `null` — not a zero, not the residue that was lying there.
//
// This gate asserts the RULE, not the reported instance. It runs a tiny 6502
// routine that writes two DISJOINT runs and leaves a gap, with the gap PRE-FILLED
// with recognisable non-zero residue ($DE) that the routine never touches. Then:
//
//   * the two runs are reported, as runs, with their bytes;
//   * the gap is not presented as payload anywhere a caller reads bytes;
//   * $DE never appears as data — not in the window, not in the span, not in a
//     PRG the tool writes;
//   * a single contiguous write still comes back as exactly ONE run.
//
// It also proves the residue was really there (via the opt-in `observed` view), so
// a green result cannot come from a machine that merely happened to be zeroed.
//
// Hermetic: no project, no fixtures on disk, no network. The LIVE half needs a
// built `trx64cli` in the sibling TRX64 checkout — this repo does not build it, so
// that half SKIPS LOUDLY when it is absent, never silently.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:838-harvest
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passCount = 0;
let failCount = 0;
const ok = (m, d = "") => { passCount += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 838 D2 — a harvest may not invent bytes (issue #17)\n");

const dist = join(ROOT, "dist/server.js");
if (!existsSync(dist)) {
  console.log("  FAIL  dist/server.js is built (run npm run build:mcp)");
  console.log("\nRED  Spec 838 harvest: 0 pass, 1 fail.");
  process.exit(1);
}
const load = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { runSandboxRealCore } = await load("dist/sandbox/index.js");
const { genericSandboxDepack } = await load("dist/sandbox/sandbox-depack-generic.js");
const { resolveTrx64Cli } = await load("dist/sandbox/trx64cli.js");
const { registerSandboxTools } = await load("dist/server-tools/sandbox.js");
const { registerSandboxDepackTool } = await load("dist/server-tools/sandbox-depack.js");

// ── A tool harness. Capture (name, description, shape, handler) off the same
//    register* call the real server makes, so the door under test is the door
//    that ships — no stdio, no daemon, no project on disk. ───────────────────
const scratch = mkdtempSync(join(tmpdir(), "c64re-838-"));
const tools = new Map();
const fakeServer = {
  tool(name, description, shape, handler) {
    tools.set(name, { name, description, shape, handler });
    return { update() {}, remove() {}, enable() {}, disable() {} };
  },
};
const ctx = {
  projectDir: () => scratch,
  toolsDir: () => scratch,
  readTextFile: (p) => readFileSync(p, "utf8"),
  cliResultToContent: (r) => ({ content: [{ type: "text", text: r.stderr || r.stdout }] }),
  tryRegisterKnowledgeArtifacts: async () => ({}),
};
registerSandboxTools(fakeServer, ctx);
registerSandboxDepackTool(fakeServer, ctx);
const callTool = async (name, args) => {
  const t = tools.get(name);
  const res = await t.handler(args, {});
  return res.content.map((c) => c.text).join("\n");
};

// ── The fixtures. Three routines, each a handful of bytes. ──────────────────

// TWO DISJOINT RUNS: fill $4000-$4007 with $AA, then $4020-$4027 with $BB.
// Everything between is left exactly as it was found.
//   LDA #$AA / LDX #$00 / STA $4000,X / INX / CPX #$08 / BNE -8
//   LDA #$BB / LDX #$00 / STA $4020,X / INX / CPX #$08 / BNE -8 / RTS
const TWO_RUNS = [
  0xa9, 0xaa, 0xa2, 0x00, 0x9d, 0x00, 0x40, 0xe8, 0xe0, 0x08, 0xd0, 0xf8,
  0xa9, 0xbb, 0xa2, 0x00, 0x9d, 0x20, 0x40, 0xe8, 0xe0, 0x08, 0xd0, 0xf8,
  0x60,
];
// ONE CONTIGUOUS RUN: fill $4000-$400F with $CC.
const ONE_RUN = [0xa9, 0xcc, 0xa2, 0x00, 0x9d, 0x00, 0x40, 0xe8, 0xe0, 0x10, 0xd0, 0xf8, 0x60];

// The residue. $DE is not a byte either routine ever stores, so ANY $DE that
// comes back as data is the defect. Loading it is not writing it: a `--load` is
// the caller placing bytes in the machine, not the CPU storing them, so the write
// set must not claim them — which is exactly the case that used to be invisible.
const RESIDUE = 0xde;
const RESIDUE_LO = 0x4008;
const RESIDUE_HI = 0x402f;
const residueHex = "de".repeat(RESIDUE_HI - RESIDUE_LO + 1);

const RUN_A = { lo: 0x4000, hi: 0x4007, value: 0xaa };
const RUN_B = { lo: 0x4020, hi: 0x4027, value: 0xbb };
const WINDOW = { start: 0x4000, end: 0x402f };
// $4008-$401f (24) + $4028-$402f (8): every address in the window the routine
// never stored to.
const EXPECTED_HOLES = 32;

// ── A. The contract, with or without a machine ──────────────────────────────
console.log("A. the doors say what they return");
{
  const run = tools.get("sandbox_6502_run");
  const depack = tools.get("sandbox_depack");
  check(run !== undefined && depack !== undefined, "both sandbox doors are registered");

  // A caller holding an OLD harvest has no way to know it may be contaminated
  // unless the tool says so. The spec declines a doctrine note as the FIX; it is
  // still owed as a warning.
  for (const [label, d] of [["sandbox_6502_run", run.description], ["sandbox_depack", depack.description]]) {
    check(/\bSTORED\b|\bstored\b/.test(d), `${label} says only stored bytes are payload`);
    check(/re-run anything you kept/i.test(d), `${label} warns that an OLD harvest may be contaminated`);
    // The product-surface rules this repo already enforces must survive the edit.
    check(!/\bSpec\s+\d/i.test(d), `${label} description carries no Spec NNN citation`);
    check(/\bUse [a-z]/i.test(d) && /Not for|\(use [a-z_]+|use [a-z_]+ instead/i.test(d),
      `${label} keeps its Use-trigger + alternative pointer`);
  }

  // Spec 835 — every parameter says what it takes.
  const undescribed = Object.entries(run.shape)
    .filter(([, v]) => !(v?._def?.description ?? v?.description))
    .map(([k]) => k);
  check(undescribed.length === 0, "every sandbox_6502_run parameter has a .describe()", undescribed.join(",") || "none");
  check("include_observed" in run.shape,
    "the raw window is reachable, but only by asking for it by name (include_observed)");
}

// ── B. The live half ────────────────────────────────────────────────────────
const cli = resolveTrx64Cli();
if (!existsSync(cli)) {
  console.log("\nB. the live half");
  console.log(`  SKIPPED — no trx64cli at ${cli}. Build it in the sibling TRX64 checkout ` +
    `(cargo build --release --bin trx64cli) or set C64RE_TRX64CLI_BIN.`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${failCount ? "RED " : "GREEN"}  Spec 838 harvest: ${passCount} pass, ${failCount} fail (live half skipped).`);
  process.exit(failCount ? 1 : 0);
}

const twoRunOpts = {
  loads: [
    { bytes: TWO_RUNS, address: 0xc000 },
    // Pre-fill the gap with residue the routine never touches.
    { bytes: Array.from({ length: RESIDUE_HI - RESIDUE_LO + 1 }, () => RESIDUE), address: RESIDUE_LO },
  ],
  initialPc: 0xc000,
  returnMemoryRanges: [WINDOW],
  maxSteps: 100_000,
};

console.log("\nB. two disjoint runs, a gap, and recognisable residue in the gap");
const r = runSandboxRealCore(twoRunOpts);
check(r.stopReason === "sentinel_rts", "the routine ran to its RTS", r.stopReason);

// B1 — the runs are reported, as runs.
const runs = r.writtenRuns.filter((x) => x.lo >= WINDOW.start && x.hi <= WINDOW.end);
check(runs.length === 2, "two disjoint written runs are reported", `${r.writtenRuns.length} run(s) total`);
check(runs[0]?.lo === RUN_A.lo && runs[0]?.hi === RUN_A.hi, "run 1 is $4000-$4007",
  runs[0] ? `$${runs[0].lo.toString(16)}-$${runs[0].hi.toString(16)}` : "missing");
check(runs[1]?.lo === RUN_B.lo && runs[1]?.hi === RUN_B.hi, "run 2 is $4020-$4027",
  runs[1] ? `$${runs[1].lo.toString(16)}-$${runs[1].hi.toString(16)}` : "missing");
check(runs[0]?.bytes.length === 8 && runs[0].bytes.every((b) => b === RUN_A.value),
  "run 1 carries its OWN bytes ($AA x8)");
check(runs[1]?.bytes.length === 8 && runs[1].bytes.every((b) => b === RUN_B.value),
  "run 2 carries its OWN bytes ($BB x8)");
check(r.writes.length === 16, "16 addresses were written — the gap is not among them", `${r.writes.length}`);

// B2 — the residue really was there. Without this the gate could pass on a
// machine that merely happened to hold zeroes, and would prove nothing.
const snap = r.memorySnapshots[0];
check(snap.observed.includes(RESIDUE), "the gap really did hold $DE at stop (observed)",
  `${snap.observed.filter((b) => b === RESIDUE).length} residue bytes`);

// B3 — and it is not payload. This is the defect, stated as an assertion.
check(!snap.bytes.includes(RESIDUE), "$DE NEVER appears in the window's byte view");
check(snap.unwritten === EXPECTED_HOLES, "every un-written address in the window is counted as a hole",
  `${snap.unwritten} of ${EXPECTED_HOLES}`);
const holesAreNull = snap.bytes.every((b, i) => {
  const a = WINDOW.start + i;
  const written = (a >= RUN_A.lo && a <= RUN_A.hi) || (a >= RUN_B.lo && a <= RUN_B.hi);
  return written ? typeof b === "number" : b === null;
});
check(holesAreNull, "a hole is `null` and a written byte is a number — exactly, address by address");
check(snap.bytes.filter((b) => b === null).length === EXPECTED_HOLES,
  "…and `null` is the ONLY hole marker (no zero stand-in)");

// B4 — the span is a bounding box, and says so rather than filling itself in.
check(r.writtenSpan.start === RUN_A.lo && r.writtenSpan.end === RUN_B.hi, "the span bounds both runs");
check(!r.writtenSpan.bytes.includes(RESIDUE), "the span never carries residue");
check(r.writtenSpan.bytes.filter((b) => b === null).length === 0x18,
  "the span's 24 un-written bytes are holes, not the zeroes it used to fabricate",
  `${r.writtenSpan.bytes.filter((b) => b === null).length}`);

// ── C. a single contiguous write is still ONE run ───────────────────────────
console.log("\nC. one contiguous write is still one run");
const one = runSandboxRealCore({
  loads: [
    { bytes: ONE_RUN, address: 0xc000 },
    { bytes: Array.from({ length: 16 }, () => RESIDUE), address: 0x4010 },
  ],
  initialPc: 0xc000,
  returnMemoryRanges: [{ start: 0x4000, end: 0x400f }],
  maxSteps: 100_000,
});
check(one.writtenRuns.length === 1, "exactly one run — the change did not fragment a contiguous write",
  `${one.writtenRuns.length}`);
check(one.writtenRuns[0]?.lo === 0x4000 && one.writtenRuns[0]?.hi === 0x400f, "…covering $4000-$400F");
check(one.memorySnapshots[0].unwritten === 0, "…with no holes in a window that is entirely written");
check(one.memorySnapshots[0].bytes.every((b) => b === 0xcc), "…and all 16 bytes come back as data, not null");
check(one.writtenSpan.bytes.every((b) => b === 0xcc), "…and the span equals the run");

// ── D. the door a caller actually reads ─────────────────────────────────────
console.log("\nD. sandbox_6502_run says it out loud");
const hexArgs = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
const doorArgs = {
  loads: [
    { hex_bytes: hexArgs(TWO_RUNS), address: "c000" },
    { hex_bytes: residueHex, address: RESIDUE_LO.toString(16) },
  ],
  initial_pc: "c000",
  return_memory_ranges: [{ start: "4000", end: "402f" }],
  max_steps: 100000,
};
const text = await callTool("sandbox_6502_run", doorArgs);
check(/Written runs: 2 — \$4000-\$4007 \(8 bytes\), \$4020-\$4027 \(8 bytes\)/.test(text),
  "the runs are named in the output, before anything else about bytes");
const memLine = text.split("\n").find((l) => l.startsWith("Memory $4000")) ?? "";
check(/never written by this run/.test(memLine), "the memory line says how much of the window is not payload");
check(memLine.includes("--"), "…and renders each un-written byte as `--`, which is not hex");
check(!/\bDE\b/.test(memLine), "…and never prints the residue as a byte");
check(/AA AA AA AA AA AA AA AA -- --/.test(memLine), "…so a run ends and a hole begins, visibly");
check(/NEVER WRITTEN/.test(text), "the span line warns that it crosses a gap");
check(!/observed RAM/.test(text), "the raw window is NOT printed unless asked for");

const observedText = await callTool("sandbox_6502_run", { ...doorArgs, include_observed: true });
const obsLine = observedText.split("\n").find((l) => l.includes("observed RAM")) ?? "";
check(obsLine.includes("DE"), "include_observed does show the residue — by name, on its own line, labelled");
check(/NOT this run's output/.test(obsLine), "…labelled as what it is");

// ── E. what the tool WRITES TO DISK ─────────────────────────────────────────
console.log("\nE. no invented byte reaches a file");
const outText = await callTool("sandbox_6502_run", { ...doorArgs, output_path: "out/two.prg" });
const fileA = join(scratch, "out", "two-$4000.prg");
const fileB = join(scratch, "out", "two-$4020.prg");
check(existsSync(fileA) && existsSync(fileB), "a gapped write set produces ONE FILE PER RUN, not one spanning file");
check(!existsSync(join(scratch, "out", "two.prg")),
  "…and no single file claiming the whole span, because the span was never written");
const bufA = existsSync(fileA) ? readFileSync(fileA) : Buffer.alloc(0);
const bufB = existsSync(fileB) ? readFileSync(fileB) : Buffer.alloc(0);
check(bufA.length === 2 + 8 && bufA[0] === 0x00 && bufA[1] === 0x40 && bufA.subarray(2).every((b) => b === 0xaa),
  "run 1's PRG is its load address + its 8 bytes, nothing more", `${bufA.length} bytes`);
check(bufB.length === 2 + 8 && bufB[0] === 0x20 && bufB[1] === 0x40 && bufB.subarray(2).every((b) => b === 0xbb),
  "run 2's PRG is its load address + its 8 bytes, nothing more", `${bufB.length} bytes`);
check(!bufA.includes(RESIDUE) && !bufB.includes(RESIDUE), "neither file contains one byte of residue");
check(!bufA.subarray(2).includes(0x00) && !bufB.subarray(2).includes(0x00),
  "…and neither contains a fabricated zero where the gap used to be filled in");
check(/one per written run/.test(outText), "the output explains why there are two files");

const oneOut = await callTool("sandbox_6502_run", {
  loads: [
    { hex_bytes: hexArgs(ONE_RUN), address: "c000" },
    { hex_bytes: "de".repeat(16), address: "4010" },
  ],
  initial_pc: "c000",
  max_steps: 100000,
  output_path: "out/one.prg",
});
const oneFile = join(scratch, "out", "one.prg");
check(existsSync(oneFile), "a single contiguous run still writes ONE file at the exact path asked for");
const oneBuf = existsSync(oneFile) ? readFileSync(oneFile) : Buffer.alloc(0);
check(oneBuf.length === 2 + 16 && oneBuf.subarray(2).every((b) => b === 0xcc),
  "…holding exactly the run", `${oneBuf.length} bytes`);
check(!oneBuf.includes(RESIDUE), "…and no residue from beyond its end");
check(/Written runs: 1/.test(oneOut), "…and the output still names the run");

// ── F. sandbox_depack — the reporter's multi-block case ─────────────────────
console.log("\nF. sandbox_depack names the runs it did NOT return");
// A resident routine that copies 4 source bytes to $5000 AND to $5010 — the
// smallest honest model of a multi-block depacker: two disjoint destination runs
// from one entry.
//   LDY #$00 / LDA ($52),Y / STA $5000,Y / INY / CPY #$04 / BNE -10
//   LDY #$00 / LDA ($52),Y / STA $5010,Y / INY / CPY #$04 / BNE -10 / RTS
const TWO_BLOCK_DEPACKER = [
  0xa0, 0x00, 0xb1, 0x52, 0x99, 0x00, 0x50, 0xc8, 0xc0, 0x04, 0xd0, 0xf6,
  0xa0, 0x00, 0xb1, 0x52, 0x99, 0x10, 0x50, 0xc8, 0xc0, 0x04, 0xd0, 0xf6,
  0x60,
];
const dep = genericSandboxDepack({
  packed: Uint8Array.from([0x01, 0x02, 0x03, 0x04]),
  residentLoader: Uint8Array.from(TWO_BLOCK_DEPACKER),
  residentLoadAddress: 0xc000,
  entryPc: 0xc000,
  maxSteps: 100_000,
});
const has = (lo, hi) => dep.writtenRuns.some((x) => x.lo === lo && x.hi === hi);
check(has(0x5000, 0x5003) && has(0x5010, 0x5013),
  "BOTH destination runs are reported, not only the one returned",
  dep.writtenRuns.map((x) => `$${x.lo.toString(16)}-$${x.hi.toString(16)}`).join(","));
check(dep.writtenRuns.some((x) => x.lo === dep.returnedRun.lo && x.hi === dep.returnedRun.hi),
  "returnedRun identifies WHICH run came back");
check(dep.unpacked.length === dep.returnedRun.hi - dep.returnedRun.lo + 1,
  "the unpacked bytes are exactly that run — never a span across the gap",
  `${dep.unpacked.length} bytes`);
check(Array.from(dep.unpacked).every((b) => b >= 0x01 && b <= 0x04),
  "…and hold only depacked bytes, no residue from between the runs");

writeFileSync(join(scratch, "packed.bin"), Buffer.from([0x01, 0x02, 0x03, 0x04]));
writeFileSync(join(scratch, "resident.bin"), Buffer.from(TWO_BLOCK_DEPACKER));
const depText = await callTool("sandbox_depack", {
  input_path: "packed.bin",
  resident_loader_path: "resident.bin",
  resident_load_address: "c000",
  entry_pc: "c000",
  output_path: "out/depacked.prg",
  max_steps: 100000,
});
check(/NOT in that file/.test(depText), "the door tells the caller a second run exists and is not in the file");
check(/never written by this depacker/.test(depText),
  "…and that the addresses between the runs are not payload");
check(/\$5010-\$5013/.test(depText), "…naming the run it did not return");

// ── G. the escape hatch is still a refusal, not an invention ────────────────
console.log("\nG. a write set too scattered to file is written as nothing");
// 65 single-byte runs: $4000, $4002 … $4080. One file each is not an output, and
// one file over the span would be 64 bytes the routine never stored. So: neither.
//   LDA #$01 / LDX #$00 / STA $4000,X / INX / INX / CPX #$82 / BNE -9 / RTS
const SCATTER = [0xa9, 0x01, 0xa2, 0x00, 0x9d, 0x00, 0x40, 0xe8, 0xe8, 0xe0, 0x82, 0xd0, 0xf7, 0x60];
const scatterText = await callTool("sandbox_6502_run", {
  loads: [{ hex_bytes: hexArgs(SCATTER), address: "c000" }],
  initial_pc: "c000",
  max_steps: 100000,
  output_path: "out/scatter.prg",
});
check(/Written runs: 65/.test(scatterText), "65 disjoint single-byte runs are all reported");
check(/, … \+53 more/.test(scatterText), "…the printed list is capped, and says how many it did not print");
check(/Wrote NO PRG/.test(scatterText), "no file is written rather than 65 fragments or one invented span");
check(!existsSync(join(scratch, "out", "scatter.prg")), "…and nothing landed at the requested path");
check(/return_writes_start/.test(scatterText), "…and the refusal says how to ask for the part that is wanted");

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failCount ? "RED " : "GREEN"}  Spec 838 harvest: ${passCount} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
