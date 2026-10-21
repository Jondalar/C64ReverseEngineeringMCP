#!/usr/bin/env node
// Issue #140 — a probable-code render must not seed another owner's code.
//
// extract_crt auto-renders every chip; a data chip's probable-code "jsr" lands
// in the graph as a CALLS edge with confidence `heuristic`. Fed to S2 as a
// cross-owner seed, it splits a real instruction of the code that is copied to
// RAM and analysed later as its own owner.
//
// Hermetic: own PRG, own graph.sqlite through the real schema, no runtime.
//
//   $0800  lda $DC01 / sta $D020 / jmp $0800    entry; $0801 is INSIDE the lda
//   $0810  inx / rts                             reached only from another owner
//
//   chip_data  -> $0801  CALLS, heuristic (probable-code render)  must NOT seed
//   loader     -> $0810  CALLS, certain   (confirmed code)        must seed
//
// Exit 0 = pass, 1 = fail.   npm run e2e:140-heuristic-seeds

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const check = (c, m) => { if (c) { pass += 1; console.log(`  PASS  ${m}`); } else { failCount += 1; console.log(`  FAIL  ${m}`); } };

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");

const BASE = 0x0800;
const image = Buffer.alloc(0x20, 0x02); // JAM filler
image.set([0xad, 0x01, 0xdc, 0x8d, 0x20, 0xd0, 0x4c, 0x00, 0x08], 0x00);
image.set([0xe8, 0x60], 0x10);

const dir = mkdtempSync(join(tmpdir(), "c64re-140-"));
const prg = join(dir, "copied.prg");
writeFileSync(prg, Buffer.from([BASE & 0xff, BASE >> 8, ...image]));

mkdirSync(join(dir, "knowledge"), { recursive: true });
const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"));
db.exec(GRAPH_DDL);
const node = db.prepare("INSERT INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?, 'generated', ?, 'ram', ?, NULL, ?, ?, NULL, NULL, '{}', 'static', ?, 'control-flow', '[]')");
node.run("fx:ram/copied:routine:0800", "routine", "copied", "copied", 0x0800, "certain");
node.run("fx:ram/chip_data:routine:8000", "routine", "chip_data", "chip_data", 0x8000, "heuristic");
node.run("fx:ram/loader:routine:e000", "routine", "loader", "loader", 0xe000, "certain");
node.run("fx:ram:addr:0801", "addr", null, null, 0x0801, "inferred");
node.run("fx:ram:addr:0810", "addr", null, null, 0x0810, "inferred");
const edge = db.prepare("INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, 'CALLS', ?, 'generated', ?, 'static', ?, 'control-flow', ?, '{}')");
edge.run("fx:ram/chip_data:routine:8000", "fx:ram:addr:0801", "src:8010", "heuristic", "chip_data");
edge.run("fx:ram/loader:routine:e000", "fx:ram:addr:0810", "src:e003", "certain", "loader");
db.close();

const out = join(dir, "copied.json");
execFileSync(process.execPath, [cli, "analyze-prg", prg, out, "0800", "--no-register"], {
  stdio: "pipe", env: { ...process.env, C64RE_PROJECT_DIR: dir, C64RE_NO_GRAPH_SEEDS: "" },
});
const report = JSON.parse(readFileSync(out, "utf8"));
const seeds = report.codeSeedReport?.seeds ?? [];
const kindAt = (a) => report.segments.find((s) => a >= s.start && a <= s.end)?.kind ?? "(none)";

check(!seeds.some((s) => s.address === 0x0801), "$0801 (heuristic caller only) is not seeded");
check((report.rejectedEntryPoints ?? []).some((r) => r.address === 0x0801 && r.reason === "heuristic_caller"), "$0801 is named as a rejected graph seed: heuristic_caller");
check(seeds.some((s) => s.address === 0x0810 && s.origin === "cross_owner_call"), "$0810 (certain caller) is still seeded");
check(kindAt(0x0800) === "code" && kindAt(0x0810) === "code", "$0800 and $0810 are code");
check((report.strandedByDecodeConflict ?? []).length === 0, "no bytes stranded by a decode conflict");
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failCount ? "RED" : "GREEN"}  140 heuristic seeds: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
