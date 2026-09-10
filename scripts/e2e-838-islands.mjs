#!/usr/bin/env node
// Spec 838 D3 — code entered only from another overlay (issue #16).
//
// Hermetic. Builds its own 6502 PRGs and its own `knowledge/graph.sqlite` from
// the real schema, runs the bundled analyzer + renderer on them, and reads the
// analysis JSON and the listing. No project, no ROMs, no runtime.
//
// The rules it asserts, not the reported instance:
//
//   D3a  an `entry_points` address the scan refuses is NAMED, never dropped in
//        silence — inside an instruction, out of range, already covered.
//   D3b  an address the GRAPH knows is code (a human `routine`, a CALLS /
//        JUMPS_TO from another owner, a Spec 826 RESOLVES_TO alias) is seeded;
//        an address Spec 826 assigns to a DIFFERENT owner is not.
//   D3b' seeds ADD. The `code` byte total never shrinks when a seed is added —
//        the measured failure mode, because a new confirmed run shortens the
//        unclaimed window a probable-code island needs for its terminator.
//   D3c  a promoted region SAYS which seed reached it, and the whole listing
//        still rebuilds byte-identical.
//
// The byte-identity half runs KickAssembler when it is on this machine and
// SKIPS LOUDLY when it is not.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:838-islands

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const skip = (m) => console.log(`  SKIP  ${m}`);
const hex = (a) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");

console.log("Spec 838 D3 — code entered only from another overlay\n");

// ---------------------------------------------------------------- helpers
const analyze = (prg, out, { entries = [], projectDir, noSeeds = false } = {}) => {
  const args = [cli, "analyze-prg", prg, out, ...(entries.length ? [entries.join(",")] : []), "--no-register"];
  execFileSync(process.execPath, args, {
    stdio: "pipe",
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir ?? "", C64RE_NO_GRAPH_SEEDS: noSeeds ? "1" : "" },
  });
  return JSON.parse(readFileSync(out, "utf8"));
};
const render = (prg, analysisPath, asmPath) => {
  execFileSync(process.execPath, [cli, "disasm-prg", prg, asmPath, "", analysisPath, "--no-register"], { stdio: "pipe" });
  return readFileSync(asmPath, "utf8");
};
const kindAt = (report, address) => {
  for (const s of report.segments) if (address >= s.start && address <= s.end) return s.kind;
  return "(none)";
};
const codeBytes = (report) => report.segments.filter((s) => s.kind === "code" || s.kind === "basic_stub").reduce((n, s) => n + s.length, 0);
const rejection = (report, address) => (report.rejectedEntryPoints ?? []).find((r) => r.address === address);

// A graph with exactly the rows this fixture needs, written through the REAL
// schema so the gate cannot drift away from what the store produces.
const writeGraph = (projectDir, { nodes, edges }) => {
  mkdirSync(join(projectDir, "knowledge"), { recursive: true });
  const db = new DatabaseSync(join(projectDir, "knowledge", "graph.sqlite"));
  db.exec(GRAPH_DDL);
  const n = db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,NULL,?,?,?,?,'{}',?,?,?,'[]')");
  for (const r of nodes) n.run(r.id, r.layer, r.kind, r.space, r.owner ?? null, r.owner ?? null, r.address, r.endAddress ?? null, r.name ?? null, r.origin ?? "static", r.confidence ?? "inferred", r.producer ?? "819");
  const e = db.prepare("INSERT OR REPLACE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,'generated',?,'static','inferred',?,?,'{}')");
  for (const r of edges) e.run(r.from, r.type, r.to, r.key ?? "", r.producer ?? "819", r.owner ?? null);
  db.close();
};

// =========================================================================
// Fixture 1 — a resident payload whose routines are entered from elsewhere.
//
//   $C000  lda #$01 / sta $D020 / rts        the only thing descent can reach
//   $C010  lda #$02 / sta $D021 / jsr $C020 / rts   called from overlay_a
//   $C020  inx / rts                          reached only THROUGH $C010
//   $C030  ldy #$00 / sty $D018 / rts         a human `routine` node
//   $C038  ldy #$05 / sty $D016 / rts         a Spec 826 RESOLVES_TO alias
//   $C040  64 bytes of text — genuinely data; $C050 inside it is claimed by
//          a DIFFERENT owner in the graph and must NOT be promoted
//   filler is $02 (JAM) so no linear probe can start in it
// =========================================================================
const F1 = 0xc000;
const image = Buffer.alloc(0x80, 0x02);
const put = (addr, ...b) => { for (let i = 0; i < b.length; i += 1) image[addr - F1 + i] = b[i]; };
put(0xc000, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60);
put(0xc010, 0xa9, 0x02, 0x8d, 0x21, 0xd0, 0x20, 0x20, 0xc0, 0x60);
put(0xc020, 0xe8, 0x60);
put(0xc030, 0xa0, 0x00, 0x8c, 0x18, 0xd0, 0x60);
put(0xc038, 0xa0, 0x05, 0x8c, 0x16, 0xd0, 0x60);
for (let i = 0; i < 0x40; i += 1) image[0x40 + i] = 0x41 + (i % 26); // "ABCD..." — plainly data

const dir1 = mkdtempSync(join(tmpdir(), "c64re-838-resident-"));
const prg1 = join(dir1, "resident.prg");
writeFileSync(prg1, Buffer.from([F1 & 0xff, F1 >> 8, ...image]));

const proj = mkdtempSync(join(tmpdir(), "c64re-838-proj-"));
writeGraph(proj, {
  nodes: [
    // this owner's own rows — how the reader learns which space it lives in
    { id: "fixture:ram/resident:routine:c000", layer: "generated", kind: "routine", space: "ram", owner: "resident", address: 0xc000, endAddress: 0xc005, name: "Wc000" },
    { id: "fixture:ram/resident:routine:c038", layer: "generated", kind: "routine", space: "ram", owner: "resident", address: 0xc038, endAddress: 0xc03d, name: "Wc038" },
    // a human said there is a routine at $C030
    { id: "fixture:ram/resident:routine:c030", layer: "human", kind: "routine", space: "ram", owner: "resident", address: 0xc030, endAddress: 0xc035, name: "hud_setup", origin: "user", confidence: "user_asserted", producer: "annotations" },
    // the other overlay, and the ownerless addresses it reaches into this image
    { id: "fixture:ram/overlay_a:routine:8000", layer: "generated", kind: "routine", space: "ram", owner: "overlay_a", address: 0x8000, endAddress: 0x8010, name: "W8000" },
    { id: "fixture:ram:addr:c010", layer: "generated", kind: "addr", space: "ram", address: 0xc010 },
    { id: "fixture:ram:addr:c038", layer: "generated", kind: "addr", space: "ram", address: 0xc038 },
    // an address inside MY data that Spec 826 says belongs to overlay_b
    { id: "fixture:ram:addr:c050", layer: "generated", kind: "addr", space: "ram", address: 0xc050 },
    { id: "fixture:ram/overlay_b:routine:c050", layer: "generated", kind: "routine", space: "ram", owner: "overlay_b", address: 0xc050, endAddress: 0xc05f, name: "Wc050" },
  ],
  edges: [
    { from: "fixture:ram/overlay_a:routine:8000", type: "CALLS", to: "fixture:ram:addr:c010", key: "src:8003", owner: "overlay_a" },
    { from: "fixture:ram/overlay_a:routine:8000", type: "CALLS", to: "fixture:ram:addr:c050", key: "src:8006", owner: "overlay_a" },
    { from: "fixture:ram:addr:c038", type: "RESOLVES_TO", to: "fixture:ram/resident:routine:c038", producer: "826r" },
    { from: "fixture:ram:addr:c050", type: "RESOLVES_TO", to: "fixture:ram/overlay_b:routine:c050", producer: "826r" },
  ],
});

const off = analyze(prg1, join(dir1, "off.json"), { projectDir: proj, noSeeds: true });
const on = analyze(prg1, join(dir1, "on.json"), { projectDir: proj });

console.log("D3b — the graph crosses the overlay boundary the disassembler cannot\n");
check(kindAt(off, 0xc010) !== "code", `${hex(0xc010)} is NOT code without the graph — descent inside this image can never reach it (that IS the defect)`);
check(kindAt(off, 0xc030) !== "code", `${hex(0xc030)} is NOT code without the graph`);
check(kindAt(on, 0xc010) === "code", `${hex(0xc010)} becomes code from a CALLS edge belonging to another owner`);
check(kindAt(on, 0xc020) === "code", `${hex(0xc020)} — only reachable THROUGH the seeded routine — comes with it`);
check(kindAt(on, 0xc030) === "code", `${hex(0xc030)} becomes code from a human \`routine\` node`);
check(kindAt(on, 0xc038) === "code", `${hex(0xc038)} becomes code from a Spec 826 RESOLVES_TO alias`);

const seedReport = on.codeSeedReport ?? {};
const seedAt = (a) => (seedReport.seeds ?? []).find((s) => s.address === a);
check(seedReport.status === "ok" && seedReport.owner === "resident", `the seed pass names its owner and its status (${seedReport.status}/${seedReport.owner})`);
check(seedAt(0xc010)?.origin === "cross_owner_call", `${hex(0xc010)} is recorded as cross_owner_call`);
check(seedAt(0xc030)?.origin === "human_routine", `${hex(0xc030)} is recorded as human_routine`);
check(seedAt(0xc038)?.origin === "resolved_alias", `${hex(0xc038)} is recorded as resolved_alias`);
check((seedAt(0xc010)?.detail ?? "").includes("overlay_a"), "…and the cross-owner seed names the owner that calls it");

console.log("\nD3b — the one subtraction, and it is the graph's own answer, not a guess\n");
check(kindAt(on, 0xc050) !== "code", `${hex(0xc050)} stays data: Spec 826 resolves it to overlay_b's routine, so it is not this image's code`);
check(seedAt(0xc050) === undefined, "…it is not in the seed list");
check(rejection(on, 0xc050)?.reason === "owned_by_other", "…and the refusal is recorded, with the reason (not dropped in silence)");

console.log("\nData stays data\n");
for (const a of [0xc060, 0xc070, 0xc07f]) {
  check(kindAt(off, a) !== "code" && kindAt(on, a) !== "code", `${hex(a)} in the text block is not code, with seeds off OR on (${kindAt(off, a)} / ${kindAt(on, a)})`);
}
check(kindAt(off, 0xc040) === kindAt(on, 0xc040), `the data block's classification is unchanged by seeding (${kindAt(on, 0xc040)})`);

console.log("\nD3b' — seeds ADD; the code total never shrinks\n");
check(codeBytes(on) >= codeBytes(off), `code bytes ${codeBytes(off)} → ${codeBytes(on)} with seeds (must never shrink)`);
check(codeBytes(on) > codeBytes(off), `…and here it grows by ${codeBytes(on) - codeBytes(off)} bytes`);

console.log("\nD3c — the listing says WHICH seed reached the region\n");
const asmOn = render(prg1, join(dir1, "on.json"), join(dir1, "on.asm"));
const seededSegment = asmOn.split("\n").filter((l) => /graph named a seed|graph seed/.test(l));
check(seededSegment.some((l) => l.includes("cross_owner_call") && l.includes("overlay_a")), "a promoted segment names the cross-owner seed and its caller");
check(seededSegment.some((l) => l.includes("human_routine")), "…and the human-routine seed");
check(/Code seeds \(Spec 838 D3\)/.test(asmOn), "the listing header carries the seed ledger");
check(/overlay_b/.test(asmOn), "…including the address the graph handed to a different owner");

console.log("\nDoctrine rule 1 — an absent graph is a NAMED reason, never a silent zero\n");
const nowhere = analyze(prg1, join(dir1, "nograph.json"), { projectDir: mkdtempSync(join(tmpdir(), "c64re-838-empty-")) });
check(nowhere.codeSeedReport?.status === "absent", "with no graph the seed pass reports `absent`");
check(/graph\.sqlite/.test(nowhere.codeSeedReport?.reason ?? ""), "…and the reason names the file it looked for");
const asmNone = render(prg1, join(dir1, "nograph.json"), join(dir1, "nograph.asm"));
check(/graph seeds: none —/.test(asmNone), "…and the listing says so instead of pretending there was nothing to find");

// =========================================================================
// D3a — an entry point the scan refuses is named.
// =========================================================================
console.log("\nD3a — an `entry_points` address is never dropped in silence\n");
const entriesRun = analyze(prg1, join(dir1, "entries.json"), {
  projectDir: proj,
  noSeeds: true,
  // $C001 is INSIDE `lda #$01` at $C000; $C002 is a real instruction start;
  // $0801 is not in this image at all.
  entries: ["c000", "c001", "c002", "0801"],
});
const insideOne = rejection(entriesRun, 0xc001);
check(insideOne?.reason === "inside_instruction", `${hex(0xc001)} lands inside an instruction and is REPORTED, not dropped`);
check((insideOne?.detail ?? "").includes(hex(0xc000)), "…and the report names the instruction that already claimed those bytes");
check((insideOne?.detail ?? "").toLowerCase().includes("seed"), "…and the seed that decoded it, so the human can see which decode to distrust");
check(rejection(entriesRun, 0x0801)?.reason === "out_of_range", `${hex(0x0801)} is outside the image and is REPORTED`);
check(rejection(entriesRun, 0xc002)?.reason === "already_code", `${hex(0xc002)} was already an instruction start — recorded as satisfied, not as a loss`);
const asmEntries = render(prg1, join(dir1, "entries.json"), join(dir1, "entries.asm"));
check(/entry points NOT seeded: 2\b/.test(asmEntries), "the listing header states how many supplied entry points were refused");
check(new RegExp(`${hex(0xc001).replace("$", "\\$")}\\s+\\[user/inside_instruction\\]`).test(asmEntries), "…and lists the refused address with its reason");
check(/entry points already covered: 1/.test(asmEntries), "…and counts the satisfied ones separately");

// =========================================================================
// The same conflict one level down: a byte no decode owns because the walk that
// wanted it lost the race to a seed. This is the only way a seed can still cost
// a byte, so it has to be said rather than left to be found.
//
//   $C000  jsr $C010 / rts
//   $C004  `lda $A901` — three bytes, the third of which is $C006
//   $C006  lda #$01 / rts        <- supplied as an entry point, seeds first
//   $C010  jmp $C004             <- brings a walk to $C004 only AFTER that
// =========================================================================
console.log("\nD3a — and the same conflict one byte down\n");
const F3 = 0xc000;
const img3 = Buffer.alloc(0x20, 0x02);
const put3 = (addr, ...b) => { for (let i = 0; i < b.length; i += 1) img3[addr - F3 + i] = b[i]; };
put3(0xc000, 0x20, 0x10, 0xc0, 0x60);
put3(0xc004, 0xad, 0x01);      // `lda $A901` — its high byte IS $C006's opcode
put3(0xc006, 0xa9, 0x01, 0x60);
put3(0xc010, 0x4c, 0x04, 0xc0);
const dir3 = mkdtempSync(join(tmpdir(), "c64re-838-conflict-"));
const prg3 = join(dir3, "conflict.prg");
writeFileSync(prg3, Buffer.from([F3 & 0xff, F3 >> 8, ...img3]));
const conflict = analyze(prg3, join(dir3, "conflict.json"), { entries: ["c000", "c006"], noSeeds: true });
const stranded = conflict.strandedByDecodeConflict ?? [];
check(stranded.some((s) => s.address === 0xc004 && s.blockedBy === 0xc006), `${hex(0xc004)} is reported as stranded, naming the instruction at ${hex(0xc006)} that took the bytes`);
check(kindAt(conflict, 0xc006) === "code", `…while the seeded address ${hex(0xc006)} itself is code`);
const asmConflict = render(prg3, join(dir3, "conflict.json"), join(dir3, "conflict.asm"));
check(/bytes stranded by a decode conflict: 1/.test(asmConflict), "the listing header states the stranded byte instead of leaving it to be discovered");

// =========================================================================
// Fixture 2 — the measured failure mode: adding ONE entry point used to move
// bytes OUT of `code`, because the new confirmed run shortened the unclaimed
// window a probable-code island needs to find its terminator in.
//
//   $C000  lda #$00 / sta $D020 / rts        the trusted entry
//   $C100  a 12-instruction island, referenced by a `jsr $C100` that lives in
//          DATA (so the byte scan sees the reference but descent never
//          follows it), ending in `rts` at $C119
//   the added entry point is $C114, an instruction start INSIDE that island
//
// The island touches SID rather than VIC on purpose: `sta $D0xx` puts a literal
// $D0 (BNE) in the byte stream, and Spec 047's island-demote counts those as
// branches into data. That is a different pass with its own gate; this fixture
// is about the ISLAND WINDOW, so it stays out of its way.
// =========================================================================
console.log("\nD3b' — the regression: one added entry point must not cost a single byte of code\n");
const F2 = 0xc000;
const img2 = Buffer.alloc(0x200, 0x02);
const put2 = (addr, ...b) => { for (let i = 0; i < b.length; i += 1) img2[addr - F2 + i] = b[i]; };
put2(0xc000, 0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60);
put2(0xc100,
  0xa9, 0x07,             // lda #$07
  0x8d, 0x18, 0xd4,       // sta $D418
  0xa9, 0x00,             // lda #$00
  0x8d, 0x04, 0xd4,       // sta $D404
  0xa2, 0x08,             // ldx #$08
  0xca,                   // dex
  0xd0, 0xfd,             // bne *-1
  0xa9, 0x03,             // lda #$03
  0x8d, 0x05, 0xd4,       // sta $D405
  0xa0, 0x00,             // ldy #$00     <- $C114, the entry point that is added
  0x8c, 0x06, 0xd4,       // sty $D406
  0x60,                   // rts          <- $C119
);
put2(0xc180, 0x20, 0x00, 0xc1); // `jsr $C100` sitting in data — an inbound reference nothing executes

const dir2 = mkdtempSync(join(tmpdir(), "c64re-838-island-"));
const prg2 = join(dir2, "island.prg");
writeFileSync(prg2, Buffer.from([F2 & 0xff, F2 >> 8, ...img2]));

const noEntry = analyze(prg2, join(dir2, "one.json"), { entries: ["c000"], noSeeds: true });
const withEntry = analyze(prg2, join(dir2, "two.json"), { entries: ["c000", "c114"], noSeeds: true });
check(kindAt(noEntry, 0xc100) === "code", `${hex(0xc100)} is code with one entry point (a probable-code island, terminator at ${hex(0xc119)})`);
check(kindAt(withEntry, 0xc114) === "code", `${hex(0xc114)} is code with the entry point added — that part always worked`);
check(kindAt(withEntry, 0xc100) === "code", `${hex(0xc100)} is STILL code: the island fell into confirmed code instead of running out of room`);
check(kindAt(withEntry, 0xc108) === "code", `…and so is the middle of it (${hex(0xc108)})`);
check(codeBytes(withEntry) >= codeBytes(noEntry), `code bytes ${codeBytes(noEntry)} → ${codeBytes(withEntry)} when an entry point is ADDED (must never shrink)`);

// =========================================================================
// D3c — byte identity. Nothing above is worth anything if the listing no
// longer rebuilds into the same bytes.
// =========================================================================
console.log("\nD3c — every listing rebuilds byte-identical\n");
const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
if (!existsSync(jar)) {
  skip(`byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
} else {
  const asmTwo = join(dir2, "two.asm");
  render(prg2, join(dir2, "two.json"), asmTwo);
  for (const [what, srcAsm, srcPrg] of [
    ["the graph-seeded resident payload", join(dir1, "on.asm"), prg1],
    ["the same payload with refused entry points", join(dir1, "entries.asm"), prg1],
    ["the payload with a stranded byte", join(dir3, "conflict.asm"), prg3],
    ["the island payload with the added entry point", asmTwo, prg2],
  ]) {
    const outPrg = `${srcAsm}.rebuilt`;
    let assembled = true;
    let output = "";
    try {
      output = execFileSync("java", ["-jar", jar, srcAsm, "-o", outPrg], { stdio: "pipe" }).toString();
    } catch (e) {
      assembled = false;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check(assembled, `KickAssembler accepts ${what}${assembled ? "" : `:\n${output.split("\n").filter((l) => /Error/.test(l)).slice(0, 4).join("\n")}`}`);
    if (!assembled) continue;
    const before = readFileSync(srcPrg);
    const after = readFileSync(outPrg);
    check(before.equals(after), `${what} rebuilds byte-identical (${before.length} bytes${before.length === after.length ? "" : `, got ${after.length}`})`);
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 838 D3 islands: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
