#!/usr/bin/env node
// Spec 824.2 — jump INTO the source line, at bundle + source + unit level (no browser):
//   - ui/src/lib/asm-address-map.ts is a pure address→line mapper, unit-tested here
//     against a fixture listing with every marker the renderer emits (origin, WXXXX
//     labels, SEGMENT header, block comment, multi-byte instructions, .abs, indirect,
//     a .byte run, .word / .fill / .text, a .pseudopc block, a forward zero-page label)
//     and against its 64tass image (same lines → same addresses)
//   - every anchor agrees with the running count (driftAt is empty)
//   - AsmView takes `jumpToAddress`, the Graph card has "Open in source", App wires both,
//     and the bundle carries them
//
// Exit 0 = pass, 1 = fail.   npm run smoke:824-2   (after npm run ui:build)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const hex = (v) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;

console.log("Spec 824.2 — the source-line jump\n");

// ---- the mapper, imported as TypeScript ----
const mapper = await tsImport("../ui/src/lib/asm-address-map.ts", import.meta.url);
const { buildAsmAddressMap, findLineForAddress, linesAtAddress, instructionSize } = mapper;
check(typeof buildAsmAddressMap === "function" && typeof findLineForAddress === "function", "ui/src/lib/asm-address-map.ts exports buildAsmAddressMap + findLineForAddress");

// ---- instruction sizes from operand form (the renderer's spelling) ----
const S = new Map([["zpvar", 0xfb], ["W0820", 0x0820]]);
const sizes = [
  ["rts", undefined, undefined, 1], ["asl", undefined, undefined, 1], ["asl", undefined, "a", 1],
  ["lda", undefined, "#$00", 2], ["lda", undefined, "$FB", 2], ["lda", undefined, "$FB,x", 2], ["ldx", undefined, "$FB,y", 2],
  ["lda", undefined, "$D020", 3], ["lda", undefined, "W0820,x", 3], ["sta", undefined, "$0074", 3],
  ["sta", "abs", "$0074", 3], ["sta", undefined, "@w $0074", 3],
  ["jmp", undefined, "($FFFC)", 3], ["lda", undefined, "($FB),y", 2], ["lda", undefined, "($FB,x)", 2],
  ["beq", undefined, "W0820", 2], ["bne", undefined, "$0840", 2],
  ["lda", undefined, "zpvar", 2], ["dec", undefined, "W0820", 3], ["lda", undefined, "unknown_label", 3],
  ["foo", undefined, "bar", undefined],
];
let sizeFails = 0;
for (const [m, sfx, op, want] of sizes) {
  const got = instructionSize(m, sfx, op, S);
  if (got !== want) { sizeFails += 1; console.log(`        ${m}${sfx ? "." + sfx : ""} ${op ?? ""} → ${got}, want ${want}`); }
}
check(sizeFails === 0, `instructionSize: ${sizes.length} operand forms size as the 6502 does`);

// ---- the fixture listing: every marker the renderer emits, with known addresses ----
const KICK = [
  "//****************************",                                              // 0
  "//  TRXDis ASM",                                                              // 1
  "//****************************",                                              // 2
  "",                                                                            // 3
  "      .cpu _6502",                                                            // 4
  "",                                                                            // 5
  '      .pc = $0801 "code"',                                                    // 6
  "",                                                                            // 7
  "W0801:",                                                                      // 8   $0801
  "      .byte $0B, $08, $0A, $00, $9E, $32, $30, $36, $31, $00, $00, $00 // 12", // 9   $0801-$080C
  "/* ═══════════════════════════",                                              // 10
  " * MAIN — a routine annotation header; not bytes",                            // 11
  " * ═══════════════════════════ */",                                           // 12
  "// SEGMENT $080D-$0822  code  confidence=0.90  analyzers=code",               // 13  anchor
  "W080D: // referenced from W081A",                                             // 14  $080D
  "      lda  #$00                         // A = $00",                          // 15  $080D (2)
  "      sta  $D020                        // Border color",                     // 16  $080F (3)
  "      sta  $FB                          // zp",                               // 17  $0812 (2)
  "      sta.abs $0074                     // exact width",                      // 18  $0814 (3)
  "      jsr  W0820                        // call W0820",                       // 19  $0817 (3)
  "      bne  W080D",                                                            // 20  $081A (2)
  "      jmp  ($FFFC)",                                                          // 21  $081C (3)
  "",                                                                            // 22
  "      nop",                                                                   // 23  $081F (1)
  "W0820: // referenced from W0817",                                             // 24  $0820
  "      lda  ($FB),y                      // indirect indexed",                 // 25  $0820 (2)
  "      rts",                                                                   // 26  $0822 (1)
  "",                                                                            // 27
  "      .pseudopc $C000 {",                                                     // 28  runtime $C000, file $0823
  "WC000:",                                                                      // 29  $C000
  "      inc  $D019                        // ack VIC irq",                      // 30  $C000 (3)
  "      rti",                                                                   // 31  $C003 (1)
  "      }",                                                                     // 32  file address resumes at $0827
  "// SEGMENT $0827-$083A  pointer_table  confidence=0.50  analyzers=resolver",   // 33  anchor
  "W0827:",                                                                      // 34  $0827
  "      .word W080D, $C000",                                                    // 35  $0827 (4)
  "      .fill 8, $EA",                                                          // 36  $082B (8)
  '      .text "HI"',                                                            // 37  $0833 (2)
  "loop:",                                                                       // 38  $0835 (a hand-written label)
  "      lda  zpvar                        // forward zero-page symbol → 2 bytes", // 39  $0835 (2)
  "      dec  loop                         // absolute → 3 bytes",               // 40  $0837 (3)
  "W083A: // referenced from W0838",                                             // 41  $083A
  "      rts",                                                                   // 42  $083A (1)
  "",                                                                            // 43
  ".label zpvar = $FB",                                                          // 44  defined AFTER its use
].join("\n");

// the 64tass image, by the converter's own rules (tass-converter.ts)
const TASS = KICK.split("\n").map((l) => {
  if (/^\s*\.cpu _6502/.test(l)) return '      .cpu "6502"';
  const pc = l.match(/^\s*\.pc\s*=\s*(\$[0-9A-Fa-f]+)\s*".*?"/); if (pc) return `      * = ${pc[1]}`;
  const ps = l.match(/^(\s*)\.pseudopc\s+(\$[0-9A-Fa-f]+)\s*\{\s*$/); if (ps) return `${ps[1]}.logical ${ps[2]}`;
  if (/^\s*\}\s*$/.test(l)) return "      .here";
  const lb = l.match(/^(\s*)\.label\s+(\w+)\s*=\s*(.+)$/); if (lb) return `${lb[1]}${lb[2]} = ${lb[3]}`;
  if (/^\s*\/\*/.test(l) || /^\s*\*\s/.test(l) || /\*\/\s*$/.test(l)) return `; ${l.replace(/^\s*\/?\*\s?/, "").replace(/\*\/\s*$/, "")}`.trimEnd();
  l = l.replace(/^(\s+)([A-Za-z]{3})\.abs\b/, "$1$2 @w");
  return l.replace("//", ";");
}).join("\n");

const expect = [
  // [address, line (0-based), exact, what]
  [0x0801, 8, true, "W0801 label (first line at the origin)"],
  [0x0805, 9, false, "inside the .byte run → the .byte line, inexact"],
  [0x080C, 9, false, "last byte of the .byte run"],
  [0x080D, 14, true, "W080D label after a block comment + SEGMENT anchor"],
  [0x080F, 16, true, "sta $D020 (after a 2-byte lda #)"],
  [0x0812, 17, true, "sta $FB (after a 3-byte abs)"],
  [0x0814, 18, true, "sta.abs $0074 (after a 2-byte zp)"],
  [0x0817, 19, true, "jsr W0820 (after a 3-byte .abs)"],
  [0x081A, 20, true, "bne (after a 3-byte jsr)"],
  [0x081C, 21, true, "jmp ($FFFC) (after a 2-byte branch)"],
  [0x081F, 23, true, "nop (after a 3-byte indirect jmp)"],
  [0x0820, 24, true, "W0820 label"],
  [0x0821, 25, false, "second byte of lda ($FB),y → inexact"],
  [0x0822, 26, true, "rts"],
  [0xC000, 29, true, "WC000 inside .pseudopc"],
  [0xC003, 31, true, "rti inside .pseudopc"],
  [0x0827, 34, true, "W0827: file address resumed after the .pseudopc block"],
  [0x0829, 35, false, "inside the .word table"],
  [0x082B, 36, true, ".fill 8"],
  [0x0830, 36, false, "inside the .fill"],
  [0x0833, 37, true, '.text "HI"'],
  [0x0835, 38, true, "hand-written label `loop:`"],
  [0x0837, 40, true, "dec loop (after a 2-byte lda zpvar — forward zero-page symbol)"],
  [0x083A, 41, true, "W083A label (count survived the forward symbol)"],
];

for (const [dialect, text] of [["kickass", KICK], ["64tass", TASS]]) {
  const map = buildAsmAddressMap(text, dialect);
  check(map.driftAt.length === 0, `${dialect}: every anchor agrees with the running count (drift ${JSON.stringify(map.driftAt)})`);
  let bad = [];
  for (const [addr, line, exact, what] of expect) {
    const hit = findLineForAddress(map, addr);
    if (!hit || hit.line !== line || hit.exact !== exact) bad.push(`${hex(addr)} ${what}: got ${hit ? `line ${hit.line} exact=${hit.exact}` : "undefined"}, want line ${line} exact=${exact}`);
  }
  for (const b of bad) console.log(`        ${b}`);
  check(bad.length === 0, `${dialect}: ${expect.length} addresses land on the right line`);
  check(findLineForAddress(map, 0xD020) === undefined && findLineForAddress(map, 0x0000) === undefined, `${dialect}: an address outside the source is undefined, never a guess`);
  const both = linesAtAddress(map, 0x0820);
  check(both.length === 2 && both[0] === 24 && both[1] === 25, `${dialect}: linesAtAddress($0820) = label + instruction (${JSON.stringify(both)})`);
  check(map.symbols.get("zpvar") === 0xfb && map.symbols.get("loop") === 0x0835 && map.symbols.get("W0820") === 0x0820, `${dialect}: symbols carry .label definitions and label addresses`);
}

// a drift IS reported when the count is wrong (a label claims an address the bytes do not reach)
const drifted = buildAsmAddressMap(["      .pc = $1000 \"code\"", "W1000:", "      lda  #$00", "W1004:", "      rts"].join("\n"));
check(drifted.driftAt.length === 1 && drifted.driftAt[0].expected === 0x1004 && drifted.driftAt[0].actual === 0x1002, "a wrong count is reported as drift at the anchor, and the anchor re-synchronises");

// the real generated fixture, when the ui-smoke project has been rendered (gitignored output)
const fixture = join(ROOT, "fixtures/ui-smoke-project/artifacts/generated/sample_disasm.asm");
if (existsSync(fixture)) {
  const map = buildAsmAddressMap(readFileSync(fixture, "utf8"));
  const labels = map.entries.filter((e) => e.kind === "label").length;
  check(labels >= 4 && map.driftAt.length === 0, `generated sample_disasm.asm: ${labels} WXXXX labels, zero drift`);
} else {
  console.log("  SKIP  fixtures/ui-smoke-project/artifacts/generated/sample_disasm.asm not rendered (gitignored)");
}

// ---- presence: the prop, the action, the wiring ----
const asmView = readFileSync(join(ROOT, "ui/src/components/AsmView.tsx"), "utf8");
check(/jumpToAddress\?: number/.test(asmView) && /asm-row-hit/.test(asmView) && /buildAsmAddressMap/.test(asmView), "AsmView has the jumpToAddress prop, highlights the hit rows and uses the mapper");
check(/is not in this source/.test(asmView), "AsmView says when the address is not in the source");
const panel = readFileSync(join(ROOT, "ui/src/components/graph-panel.tsx"), "utf8");
check(/Open in source/.test(panel) && /sourceJump/.test(panel) && /onJumpToSource/.test(panel), "Graph card has the \"Open in source\" action");
const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");
check(/jumpToAddress=\{asmOverlay\.jumpToAddress\}/.test(app), "App passes jumpToAddress into the AsmView overlay");
check(/sourceJump=\{asmSourcesForOwner\}/.test(app) && /no ASM for owner/.test(app), "App resolves the owner to its ASM artifacts and says when there is none");
check(/_disasm\\\.asm\$\/i\.test\(a\.relativePath\)/.test(app), "the owner's own <stem>_disasm.asm is the first source tab");
check(/handleSelectEntity\(entityId, "listing"\); setActiveTab\("listing"\)/.test(app) && /listingJump=/.test(app), "the listing jump (D5.1) stays as it was");
const css = readFileSync(join(ROOT, "ui/src/index.css"), "utf8");
check(/\.asm-row-hit\s*\{/.test(css), "index.css styles .asm-row-hit");

// ---- bundle ----
const dist = join(ROOT, "ui/dist/assets");
if (!existsSync(dist)) { console.error("ui/dist not built — run npm run ui:build"); process.exit(2); }
const js = readdirSync(dist).filter((f) => /^index-.*\.js$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
const bundledCss = readdirSync(dist).filter((f) => /^index-.*\.css$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
check(js.includes("Open in source") && js.includes("asm-row-hit") && js.includes("jumpToAddress"), "bundle carries the action, the hit class and the prop");
check(js.includes("is not in this source") && js.includes("no ASM for owner"), "bundle carries both \"says so\" messages");
check(/\.asm-row-hit\{/.test(bundledCss), "bundle CSS carries .asm-row-hit");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 824.2 source jump: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
