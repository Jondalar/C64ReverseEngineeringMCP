#!/usr/bin/env node
// Spec 877 D5 — the listing carries equates for the addresses it references.
//
// The measured defect: labels for $F2A3 and its kind sit in the project graph while the
// `.asm` prints the bare address, so a session greps the rendered text for the address
// instead of the name (103 shell reads of one listing against 5 `disasm` calls).
//
// The fixture is built through the product's own doors — project_init, agent_onboard,
// analyze_prg, disasm_prg — with TWO payloads, because the whole point is a name that
// belongs to a DIFFERENT payload than the one being rendered:
//
//   engine.prg  $C000  a routine `engine_clear_bg`, plus labels for $F2A3 (`game_state`),
//                      $0400 (`set_border`, colliding on purpose) and $F800 (`never_touched`)
//   main.prg    $1000  jsr $C000 / sta $0400 / lda $F2A3 / jsr $1010 / jmp $1000
//
// Part 2 calls the renderer directly against a graph mutated behind its back, because a
// name over the project's limit and a name that is not an assembler identifier cannot be
// stored through the doors — the doors refuse them — and the renderer still has to cope.
//
//   node scripts/e2e-877-equates.mjs          (needs `npm run build`)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startMcp } from "./lib/fixture-804.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let pass = 0;
let skipped = 0;
const failures = [];
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1;
  else failures.push(`${msg}${detail ? `  (${detail})` : ""}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${!cond && detail ? `  (${detail})` : ""}`);
};
const skip = (msg) => { skipped += 1; console.log(`  SKIP  ${msg}`); };

// The byte-identity half needs the assembler; without it the check is skipped, never
// passed — the same rule e2e:832-annotations follows.
const JAR = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const canRebuild = existsSync(JAR);

const ENGINE = { load: 0xc000, bytes: [0xa9, 0x00, 0x8d, 0x21, 0xd0, 0x60] };
const MAIN = {
  load: 0x1000,
  bytes: [
    0x20, 0x00, 0xc0, //  $1000  jsr $C000     — another payload's routine
    0x8d, 0x00, 0x04, //  $1003  sta $0400     — a name that collides with this listing's own
    0xad, 0xa3, 0xf2, //  $1006  lda $F2A3     — game state in RAM this payload writes to
    0x20, 0x10, 0x10, //  $1009  jsr $1010     — inside the image: already a label
    0x4c, 0x00, 0x10, //  $100C  jmp $1000
    0xea, //              $100F  filler
    0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60, // $1010  lda #$01 / sta $D020 / rts
  ],
};
// stored at $3000, runs at $C100 — its own label lives at an address OUTSIDE the mapping,
// so the equate writer must not define a second `reloc_entry` on top of the body's.
const RELOC = { load: 0x3000, bytes: [0xa9, 0x05, 0x8d, 0x00, 0x04, 0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x4c, 0x00, 0xc1, 0xea, 0xea, 0x60] };
const prgBytes = (p) => Buffer.from([p.load & 0xff, p.load >> 8, ...p.bytes]);

console.log("Spec 877 D5 — equates for the names the graph holds outside the image\n");

const dir = mkdtempSync(join(tmpdir(), "c64re-877-"));
const pay = join(dir, "payloads");
let disasmAnswer = "";
let relocAnswer = "";

const mcp = startMcp(ROOT, { C64RE_PROJECT_DIR: dir, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_AUTOSTART: "0" });
try {
  await mcp.init();
  await mcp.tool("project_init", { project_dir: dir, name: "Spec 877 D5 fixture" });
  await mcp.tool("agent_onboard", { project_dir: dir });
  mkdirSync(pay, { recursive: true });
  writeFileSync(join(pay, "engine.prg"), prgBytes(ENGINE));
  writeFileSync(join(pay, "main.prg"), prgBytes(MAIN));
  writeFileSync(join(pay, "reloc.prg"), prgBytes(RELOC));
  writeFileSync(join(pay, "engine_annotations.json"), JSON.stringify({
    routines: [{ address: "C000", name: "engine_clear_bg", comment: "the engine API main calls" }],
    labels: [
      { address: "F2A3", label: "game_state", comment: "game state main writes to" },
      { address: "0400", label: "set_border", comment: "collides with main's own label on purpose" },
      { address: "F800", label: "never_touched", comment: "no listing references this" },
      { address: "0001", label: "cpu_port", comment: "main only ever loads #$01 as a VALUE" },
    ],
  }, null, 2));
  writeFileSync(join(pay, "reloc_annotations.json"), JSON.stringify({
    routines: [{ address: "C100", name: "reloc_entry", comment: "runs relocated" }],
  }, null, 2));
  writeFileSync(join(pay, "main_annotations.json"), JSON.stringify({
    routines: [
      { address: "1000", name: "main_loop", comment: "fixture" },
      { address: "1010", name: "set_border", comment: "fixture" },
    ],
  }, null, 2));

  for (const name of ["engine", "main", "reloc", "main"]) {
    const analysis = join(pay, `${name}_analysis.json`);
    const a = await mcp.tool("analyze_prg", { project_dir: dir, prg_path: join(pay, `${name}.prg`), output_json: analysis });
    if (a.isError) throw new Error(`analyze_prg ${name}: ${a.text.slice(0, 400)}`);
    const args = { project_dir: dir, prg_path: join(pay, `${name}.prg`), analysis_json: analysis };
    if (name === "reloc") args.relocations = [{ fileStart: "$3000", fileEnd: "$300F", runtimeAddr: "$C100" }];
    const d = await mcp.tool("disasm_prg", args);
    if (d.isError) throw new Error(`disasm_prg ${name}: ${d.text.slice(0, 600)}`);
    if (name === "main") disasmAnswer = d.text;
    if (name === "reloc") relocAnswer = d.text;
  }
} finally {
  mcp.close();
}

const asm = readFileSync(join(pay, "main_disasm.asm"), "utf8");
const tas = readFileSync(join(pay, "main_disasm.tas"), "utf8");

console.log("[the graph holds the names]");
const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"));
const named = db.prepare("SELECT address, name FROM nodes WHERE name IS NOT NULL AND name <> '' AND owner = 'engine'").all();
const holds = (addr, name) => named.some((r) => r.address === addr && r.name === name);
check(holds(0xc000, "engine_clear_bg"), "graph: $C000 is engine_clear_bg");
check(holds(0xf2a3, "game_state"), "graph: $F2A3 is game_state");
check(holds(0x0400, "set_border"), "graph: $0400 is set_border (the collision)");
check(holds(0xf800, "never_touched"), "graph: $F800 is never_touched (referenced by nothing)");

console.log("\n[the listing carries the equate — KickAssembler]");
check(/^\s*\.label\s+engine_clear_bg\s*=\s*\$C000\b/mu.test(asm),
  "$C000 — another payload's routine — is equated by name", firstLineWith(asm, "C000"));
check(/^\s*\.label\s+game_state\s*=\s*\$F2A3\b/mu.test(asm),
  "$F2A3 — game state in RAM — is equated by name", firstLineWith(asm, "F2A3"));

console.log("\n[the listing carries the equate — 64tass]");
check(/^\s*engine_clear_bg\s*=\s*\$C000\b/mu.test(tas), "64tass spells it `engine_clear_bg = $C000`", firstLineWith(tas, "C000"));
check(/^\s*game_state\s*=\s*\$F2A3\b/mu.test(tas), "64tass spells it `game_state = $F2A3`", firstLineWith(tas, "F2A3"));
check(!/^\s*\w+\s*=\s*\$[0-9A-F]+.*\/\//mu.test(tas), "no KickAssembler `//` comment survives into the 64tass equates",
  firstLineWith(tas, "= $C000"));

console.log("\n[only what this listing references, and only from outside it]");
check(!/never_touched/u.test(asm), "a name nothing in this listing touches is not emitted");
check(!/\.label\s+main_loop\s*=/u.test(asm), "an address INSIDE the image keeps its label and gets no equate");
check(!/\.label\s+set_border\s*=\s*\$0400/u.test(asm), "the colliding name does not silently win");
check(!/cpu_port/u.test(asm), "`lda #$01` is a VALUE, not a reference to $0001");
check(/\$0400/u.test(asm) && /set_border/u.test(asm) && /(?:^|\n)\s*(?:\/\/|;).*\$0400.*set_border/u.test(asm),
  "the collision is said out loud, naming the address and the name", firstLineWith(asm, "$0400 "));

console.log("\n[the bytes do not change]");
const reloc = readFileSync(join(pay, "reloc_disasm.asm"), "utf8");
if (!canRebuild) {
  skip(`byte-identical rebuild: KickAssembler not found at ${JAR} (set C64RE_KICKASS_JAR) — skipped, not passed`);
} else {
  check(/byte-identical/u.test(disasmAnswer) && !/differs|not byte-identical/u.test(disasmAnswer),
    "disasm_prg still verifies the rebuild byte-identical", oneLineWith(disasmAnswer, "byte-identical"));
  check(/rebuild verified byte-identical/u.test(asm), "the listing header stamps the byte-identical rebuild");
  check(/byte-identical/u.test(relocAnswer) && !/differs|not byte-identical/u.test(relocAnswer),
    "the relocated listing still rebuilds byte-identical", oneLineWith(relocAnswer, "byte-identical"));
}
check(/\.pseudopc\s+\$C100/u.test(reloc), "the relocated listing runs its body at $C100");
check(/^\s*reloc_entry\s*:/mu.test(reloc), "…and defines reloc_entry inside the block");
check(!/\.label\s+reloc_entry\s*=/u.test(reloc),
  "…and no equate defines that name a second time — a duplicate symbol stops the rebuild", firstLineWith(reloc, ".label reloc_entry"));

// ── part 2: what the doors refuse but a graph can still hold ────────────────
console.log("\n[a name the doors would refuse]");
const LONG = "an_absurdly_long_state_name_here"; // 32 > the 20 project_init stamps
db.prepare("UPDATE nodes SET name = ? WHERE name = 'game_state'").run(LONG);
db.prepare("UPDATE nodes SET name = ? WHERE name = 'engine_clear_bg'").run("lda");
db.close();

const { disassemblePrgToKickAsm } = require(join(ROOT, "dist/pipeline/lib/prg-disasm.cjs"));
process.env.C64RE_PROJECT_DIR = dir;
const out2 = join(pay, "main_probe.asm");
disassemblePrgToKickAsm(join(pay, "main.prg"), out2, {
  analysisPath: join(pay, "main_analysis.json"),
  annotationsPath: join(pay, "main_annotations.json"),
});
const probe = readFileSync(out2, "utf8");
check(!new RegExp(`\\.label\\s+${LONG}\\s*=`, "u").test(probe), "a name over the project's limit is not emitted");
check(new RegExp(`(?:\\/\\/|;).*${LONG}`, "u").test(probe) && /limit/u.test(probe),
  "and the listing says why, naming the name", firstLineWith(probe, LONG));
check(!/^\s*\.label\s+lda\s*=/mu.test(probe), "a name that is a 6502 mnemonic is not emitted");
check(/(?:\/\/|;).*\blda\b.*\$C000|(?:\/\/|;).*\$C000.*\blda\b/u.test(probe),
  "and the listing says why", firstLineWith(probe, "$C000"));

function firstLineWith(text, needle) {
  const line = text.split("\n").find((l) => l.includes(needle));
  return line ? line.trim().slice(0, 120) : `no line contains ${needle}`;
}
function oneLineWith(text, needle) {
  return firstLineWith(text, needle);
}

console.log(`\nSpec 877 D5 equates: ${pass} passed, ${failures.length} failed, ${skipped} skipped`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`\nfixture kept at ${dir}`);
  process.exit(1);
}
