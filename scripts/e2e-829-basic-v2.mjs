#!/usr/bin/env node
// Spec 829 — BASIC V2: the listing, its exact inverse, and the SYS facts.
//
// Hermetic: no ROM, no network, no fixture files. Every program in here is a
// byte array built in this script, so the round trip is proven against BYTES
// and not against the module's own writer — a lister that only agrees with
// itself proves nothing (D3).
//
// Exit 0 = pass, 1 = fail.   npm run e2e:829

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MODULE_PATH = join(ROOT, "dist/pipeline/lib/basic-v2.cjs");
if (!existsSync(MODULE_PATH)) {
  console.error("dist/pipeline/lib/basic-v2.cjs missing — run `npm run build` first");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const {
  BASIC_V2_TOKENS,
  BASIC_V2_PI,
  BASIC_V2_LOAD_ADDRESS,
  PETSCII_CONTROL_NAMES,
  keywordForToken,
  walkBasicProgram,
  detokenize,
  tokenize,
  extractBasicFacts,
  analyzeBasicProgram,
  isBasicProgram,
  stripPrgHeader,
  toPrg,
} = require(MODULE_PATH);

let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 829 — BASIC V2 detokenize / tokenize / facts\n");

// ---------------------------------------------------------------- helpers (test-local, independent of the module)

const BASIC = BASIC_V2_LOAD_ADDRESS; // $0801

/** Lay out line records the way BASIC stores them. Deliberately not the module's writer. */
function layout(loadAddress, lines) {
  const out = [];
  let addr = loadAddress;
  for (const line of lines) {
    const next = addr + 4 + line.bytes.length + 1;
    out.push(next & 0xff, (next >> 8) & 0xff, line.number & 0xff, (line.number >> 8) & 0xff, ...line.bytes, 0x00);
    addr = next;
  }
  out.push(0x00, 0x00);
  return Uint8Array.from(out);
}

const same = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);
const hex = (a) => [...a].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

function roundTrip(label, image, loadAddress = BASIC) {
  let text;
  try {
    text = detokenize(image, loadAddress);
  } catch (err) {
    fail(`${label}: detokenize threw — ${err.message}`);
    return undefined;
  }
  const back = tokenize(text, loadAddress);
  check(same(back, image), `round trip byte-identical: ${label}`);
  if (!same(back, image)) {
    console.log(`        listing: ${JSON.stringify(text)}`);
    console.log(`        in : ${hex(image)}`);
    console.log(`        out: ${hex(back)}`);
    return text;
  }
  const again = detokenize(back, loadAddress);
  check(again === text, `round trip text-identical: ${label}`);
  return text;
}

// ---------------------------------------------------------------- D1 the token table

check(BASIC_V2_TOKENS.length === 76, `the token table has 76 entries (${BASIC_V2_TOKENS.length})`);
const contiguous = BASIC_V2_TOKENS.every((t, i) => t.token === 0x80 + i);
check(contiguous, "the token bytes run $80..$CB with no gaps");
check(BASIC_V2_TOKENS[BASIC_V2_TOKENS.length - 1].token === 0xcb, "the last token byte is $CB");
const keywords = BASIC_V2_TOKENS.map((t) => t.keyword);
check(new Set(keywords).size === keywords.length, "no duplicate keyword in the table");
check(keywordForToken(0x80) === "END", "$80 is END — the first string in the ROM keyword table at $A09E");
check(keywordForToken(0xcb) === "GO", "$CB is GO — the last one");
check(BASIC_V2_PI.token === 0xff && BASIC_V2_PI.keyword === "π", "$FF is π, carried beside the table the way the ROM handles it");
check(keywordForToken(0xcc) === undefined && keywordForToken(0x7f) === undefined, "nothing outside $80..$CB is a keyword");

// Order is the ROM's, and first-match-wins depends on it.
check(
  keywordForToken(0x84) === "INPUT#" && keywordForToken(0x85) === "INPUT",
  "INPUT# ($84) precedes INPUT ($85) — first match in table order has to win",
);
check(keywordForToken(0x98) === "PRINT#" && keywordForToken(0x99) === "PRINT", "PRINT# ($98) precedes PRINT ($99)");
check(keywordForToken(0x89) === "GOTO" && keywordForToken(0xcb) === "GO", "GOTO ($89) precedes GO ($CB)");
check(
  keywordForToken(0xaa) === "+" && keywordForToken(0xb2) === "=" && keywordForToken(0xae) === "^",
  "the operators are keywords: + is $AA, = is $B2, ^ is $AE",
);

// The book cross-check of D1, run as an assertion so a future edit cannot lose one.
const BOOK_APPENDIX_A = [
  "ABS", "AND", "ASC", "CHR$", "CLOSE", "CLR", "CMD", "CONT", "DATA", "DIM", "END", "EXP", "FOR",
  "GET", "GOSUB", "GOTO", "INPUT", "INT", "LEN", "LET", "LIST", "LOAD", "NEW", "NEXT", "NOT", "ON",
  "OPEN", "OR", "PEEK", "POS", "PRINT", "READ", "REM", "RESTORE", "RETURN", "RND", "RUN", "SAVE",
  "SGN", "SIN", "SQR", "STOP", "STR$", "SYS", "USR", "VAL", "VERIFY", "WAIT",
];
const BOOK_OMITS = ["POKE", "LEFT$", "MID$", "FRE", "DEF", "TAB(", "SPC("];
const missingFromBook = BOOK_APPENDIX_A.filter((k) => !keywords.includes(k));
check(missingFromBook.length === 0, `every keyword the book's Appendix A names is in the table (${BOOK_APPENDIX_A.length} checked)`);
if (missingFromBook.length) console.log(`        missing: ${missingFromBook.join(", ")}`);
const missingOmitted = BOOK_OMITS.filter((k) => !keywords.includes(k));
check(missingOmitted.length === 0, `and the seven the book OMITS are there too: ${BOOK_OMITS.join(" ")}`);
if (missingOmitted.length) console.log(`        missing: ${missingOmitted.join(", ")}`);

// ---------------------------------------------------------------- D2/D3 round trip on real shapes

// A one-line SYS stub, written out byte by byte — the classic `10 SYS 2064`.
const STUB = Uint8Array.from([
  0x0c, 0x08,             // next line pointer -> $080C
  0x0a, 0x00,             // line 10
  0x9e,                   // SYS
  0x20,                   // ' '
  0x32, 0x30, 0x36, 0x34, // "2064"
  0x00,                   // end of line
  0x00, 0x00,             // end of program
]);
check(same(layout(BASIC, [{ number: 10, bytes: [0x9e, 0x20, 0x32, 0x30, 0x36, 0x34] }]), STUB), "the test's own layout helper agrees with the hand-written stub bytes");
check(detokenize(STUB, BASIC) === "10 SYS 2064", "the stub lists as `10 SYS 2064`");
roundTrip("one-line SYS stub", STUB);

// A multi-line program: strings, REM, DATA, control codes, quotes inside strings,
// token-valued bytes inside a string, an unknown token, line numbers above 63999.
const PROGRAM_LINES = [
  { number: 10, bytes: [0x99, 0x20, 0x22, 0x93, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x22] },          // PRINT "{CLR}HELLO"
  { number: 20, bytes: [0x8f, 0x20, 0x12, 0x4e, 0x4f, 0x54, 0x45] },                            // REM {RVS ON}NOTE
  { number: 30, bytes: [0x83, 0x20, 0x31, 0x2c, 0x32, 0x2c, 0x33, 0x3a, 0x99, 0x22, 0x41, 0x22] }, // DATA 1,2,3:PRINT"A"
  { number: 40, bytes: [0x99, 0x20, 0x22, 0x41, 0x22, 0x42, 0x24, 0x22, 0x43, 0x22] },          // PRINT "A"B$"C"
  { number: 50, bytes: [0x99, 0x22, 0x11, 0x12, 0x58, 0x92, 0x22] },                            // PRINT"{DOWN}{RVS ON}X{RVS OFF}"
  { number: 60, bytes: [0x92, 0x20, 0x35, 0x33, 0x32, 0x38, 0x30, 0x2c, 0x30, 0x2c, 0x30] },    // WAIT 53280,0,0
  { number: 70, bytes: [0x99, 0x20, 0xcf] },                                                    // PRINT {$CF}
  { number: 64000, bytes: [0x9e, 0x20, 0x32, 0xac, 0x34, 0x30, 0x39, 0x36] },                   // SYS 2*4096
  { number: 64999, bytes: [0x93, 0x20, 0x22, 0x4e, 0x41, 0x4d, 0x45, 0x22, 0x2c, 0x38, 0x2c, 0x31] }, // LOAD "NAME",8,1
];
const PROGRAM = layout(BASIC, PROGRAM_LINES);
const listing = roundTrip("multi-line program (strings, REM, DATA, control codes, quotes, line > 63999)", PROGRAM);
const listed = (listing ?? "").split("\n");

check(listed[0] === '10 PRINT "{CLR}HELLO"', "the string's $93 lists as {CLR}, not as the LOAD keyword");
check(listed[1] === "20 REM {RVS ON}NOTE", "a control code inside a REM gets its name too (D5)");
check(listed[2] === '30 DATA 1,2,3:PRINT"A"', "a colon returns to token territory after DATA");
check(listed[3] === '40 PRINT "A"B$"C"', "quotes inside a string line: each `\"` toggles, nothing else changes");
check(listed[4] === '50 PRINT"{DOWN}{RVS ON}X{RVS OFF}"', "$11/$12/$92 inside a string are control codes, not UP/RVS-ON-as-WAIT");
check(listed[5] === "60 WAIT 53280,0,0", "…and the very same $92 OUTSIDE a string is the WAIT keyword — the quote handling is the whole test");
check(listed[6] === "70 PRINT {$CF}", "an unknown token byte renders {$CF} rather than being guessed at (non-goal 1)");
check(listed[7] === "64000 SYS 2*4096", "a line number above 63999 survives");
check(listed[8] === '64999 LOAD "NAME",8,1', "the LOAD line lists intact");

// A line whose bytes no ROM would have produced: plain PETSCII where a token belongs.
// The lister has to escape rather than emit text that tokenises back differently.
const CRAFTED = layout(BASIC, [{ number: 10, bytes: [0x99, 0x20, 0x4f, 0x4e, 0x20, 0x2b, 0x20, 0x3f] }]);
roundTrip("hand-crafted bytes: untokenised ON / + / ? outside a string", CRAFTED);

// π, and a line with an empty body.
const PI_LINE = layout(BASIC, [
  { number: 10, bytes: [] },
  { number: 20, bytes: [0x99, 0x20, 0xff] },
  { number: 30, bytes: [0x99, 0x22, 0xff, 0x22] },
]);
roundTrip("empty line body, π as a token, π inside a string", PI_LINE);
check(detokenize(PI_LINE, BASIC).split("\n")[1] === "20 PRINT π", "$FF lists as π outside a string");
check(detokenize(PI_LINE, BASIC).split("\n")[2] === '30 PRINT"{PI}"', "…and as {PI} inside one, so the text stays ASCII and reversible");

// ---------------------------------------------------------------- D5 every named control code round-trips

let namesOk = 0;
let namesBad = [];
for (const [byte, name] of PETSCII_CONTROL_NAMES) {
  const image = layout(BASIC, [{ number: 10, bytes: [0x99, 0x22, byte, 0x22] }]);
  const text = detokenize(image, BASIC);
  const back = tokenize(text, BASIC);
  if (text === `10 PRINT"{${name}}"` && same(back, image)) namesOk += 1;
  else namesBad.push(`$${byte.toString(16).toUpperCase().padStart(2, "0")} ${name} -> ${JSON.stringify(text)}`);
}
check(namesBad.length === 0, `all ${PETSCII_CONTROL_NAMES.size} control/colour codes render by name and tokenise back (${namesOk} checked)`);
if (namesBad.length) console.log(`        ${namesBad.join("\n        ")}`);

// ---------------------------------------------------------------- D2 the chain walk rejects, with an offset

function rejects(label, image, expectedOffset, reasonMatch) {
  const res = walkBasicProgram(image, BASIC);
  if (res.ok) { fail(`${label}: walked clean, but it should have been rejected`); return; }
  const offsetOk = res.offset === expectedOffset;
  const reasonOk = reasonMatch.test(res.reason);
  check(offsetOk && reasonOk, `${label} — rejected at offset ${res.offset}: ${res.reason}`);
  if (!offsetOk) console.log(`        expected offset ${expectedOffset}`);
  if (!reasonOk) console.log(`        expected reason to match ${reasonMatch}`);
}

rejects("truncated record (pointer, then half a line number)", Uint8Array.from([0x0c, 0x08, 0x0a]), 2, /truncated|line number/i);
rejects("pointer that goes backwards", Uint8Array.from([0x00, 0x07, 0x0a, 0x00, 0x9e, 0x00, 0x00, 0x00]), 0, /does not advance/i);
rejects("pointer that does not move at all", Uint8Array.from([0x01, 0x08, 0x0a, 0x00, 0x9e, 0x00, 0x00, 0x00]), 0, /does not advance/i);
rejects("pointer outside the image", Uint8Array.from([0x00, 0x90, 0x0a, 0x00, 0x9e, 0x00, 0x00, 0x00]), 0, /outside the image/i);
rejects(
  "no $00 where the pointer says the line ends",
  Uint8Array.from([0x0c, 0x08, 0x0a, 0x00, 0x9e, 0x20, 0x32, 0x30, 0x36, 0x34, 0x41, 0x00, 0x00]),
  10,
  /terminator/i,
);
rejects(
  "chain that never reaches the $0000 end marker",
  Uint8Array.from([0x0c, 0x08, 0x0a, 0x00, 0x9e, 0x20, 0x32, 0x30, 0x36, 0x34, 0x00]),
  11,
  /\$0000/,
);
rejects("empty program (first pointer already $0000)", Uint8Array.from([0x00, 0x00]), 0, /empty/i);

// A machine-code PRG that merely starts at $0801. This is issue #11: today it
// would be disassembled as 6502 and produce confident nonsense.
const ML = Uint8Array.from([
  0xa9, 0x00,       // LDA #$00
  0x8d, 0x20, 0xd0, // STA $D020
  0xa2, 0xff,       // LDX #$FF
  0x9a,             // TXS
  0x4c, 0x01, 0x08, // JMP $0801
]);
const mlWalk = walkBasicProgram(ML, BASIC);
check(mlWalk.ok === false, "a machine-code PRG at $0801 is NOT claimed as BASIC");
check(mlWalk.ok === false && mlWalk.offset === 0, `…and it says where: offset ${mlWalk.ok ? "-" : mlWalk.offset}`);
check(isBasicProgram(ML, BASIC) === false, "isBasicProgram agrees");
check(analyzeBasicProgram(ML, BASIC).ok === false, "analyzeBasicProgram refuses it whole — no half listing (D2)");
let threw = false;
try { detokenize(ML, BASIC); } catch { threw = true; }
check(threw, "detokenize throws rather than rendering half a program");

// ---------------------------------------------------------------- D4 the SYS/USR/LOAD facts

function factsFor(bytes, number = 10) {
  const image = layout(BASIC, [{ number, bytes }]);
  const walk = walkBasicProgram(image, BASIC);
  if (!walk.ok) { fail(`fixture did not walk: ${walk.reason}`); return { image, facts: [] }; }
  return { image, facts: extractBasicFacts(walk.lines) };
}

const F1 = factsFor([0x9e, 0x20, 0x32, 0x30, 0x36, 0x34]).facts;                     // SYS 2064
const F2 = factsFor([0x9e, 0x28, 0x32, 0x30, 0x36, 0x34, 0x29]).facts;               // SYS(2064)
const F3 = factsFor([0x9e, 0x20, 0x32, 0x30, 0x36, 0x34, 0x3a, 0x99]).facts;         // SYS 2064:PRINT
const F4 = factsFor([0x20, 0x20, 0x20, 0x9e, 0x20, 0x32, 0x30, 0x36, 0x34]).facts;   // "   SYS 2064"
const F5 = factsFor([0x9e, 0x20, 0x32, 0xac, 0x34, 0x30, 0x39, 0x36]).facts;         // SYS 2*4096
const F6 = factsFor([
  0x9e, 0x20, 0xc2, 0x28, 0x34, 0x33, 0x29, 0xaa, 0x32, 0x35, 0x36, 0xac, 0xc2, 0x28, 0x34, 0x34, 0x29,
]).facts;                                                                             // SYS PEEK(43)+256*PEEK(44)
const F7 = factsFor([0x93, 0x20, 0x22, 0x4e, 0x41, 0x4d, 0x45, 0x22, 0x2c, 0x38, 0x2c, 0x31]).facts; // LOAD "NAME",8,1
const F8 = factsFor([0x41, 0xb2, 0xb7, 0x28, 0x30, 0x29]).facts;                     // A=USR(0)

check(F1.length === 1 && F1[0].kind === "sys" && F1[0].value === 2064 && F1[0].confidence === "certain", "`SYS 2064` -> certain 2064");
check(F2.length === 1 && F2[0].value === 2064 && F2[0].confidence === "certain", "`SYS(2064)` -> certain 2064 (missed entirely today)");
check(F3.length === 1 && F3[0].value === 2064 && F3[0].confidence === "certain", "`SYS 2064:PRINT` -> certain 2064, the colon ends the argument");
check(F4.length === 1 && F4[0].value === 2064 && F4[0].confidence === "certain", "leading spaces -> certain 2064");
check(F5.length === 1 && F5[0].value === 8192 && F5[0].confidence === "inferred", "`SYS 2*4096` -> folded to 8192, inferred");
check(
  F6.length === 1 && F6[0].confidence === "unresolved" && F6[0].value === undefined,
  "`SYS PEEK(43)+256*PEEK(44)` -> unresolved, no invented value",
);
check(F6.length === 1 && F6[0].expression === "PEEK(43)+256*PEEK(44)", "…and the expression is carried, never silently dropped");
check(
  F7.length === 1 && F7[0].kind === "load" && F7[0].fileName === "NAME" && F7[0].device === 8 && F7[0].secondary === 1,
  '`LOAD "NAME",8,1` -> file name NAME, device 8, secondary 1 — the lead into the disk side',
);
check(F8.length === 1 && F8[0].kind === "usr", "a USR argument is extracted too");
check(F1[0].lineNumber === 10 && F7[0].lineNumber === 10, "every fact names its BASIC line");

// `site` — the absolute address of the token byte. Computed here from the bytes
// the test built, never taken from the implementation.
const sysStubImage = layout(BASIC, [{ number: 10, bytes: [0x9e, 0x20, 0x32, 0x30, 0x36, 0x34] }]);
const expectedSite = BASIC + sysStubImage.indexOf(0x9e);
check(expectedSite === 0x0805, `the $9E byte of the stub sits at $${expectedSite.toString(16).toUpperCase()} (independently computed)`);
check(F1[0].site === expectedSite, "the fact's site is the address of the $9E byte itself — what a control-flow edge joins on");
check(F1[0].offset === expectedSite - BASIC, "…and offset is the same thing relative to the load address");

// Two SYS calls in one program -> two facts with different sites.
const TWO_SYS = layout(BASIC, [
  { number: 10, bytes: [0x9e, 0x20, 0x32, 0x30, 0x36, 0x34] },
  { number: 20, bytes: [0x9e, 0x20, 0x34, 0x30, 0x39, 0x36] },
]);
const twoWalk = walkBasicProgram(TWO_SYS, BASIC);
const twoFacts = twoWalk.ok ? extractBasicFacts(twoWalk.lines) : [];
check(twoFacts.length === 2, "two SYS calls produce two facts");
check(twoFacts.length === 2 && twoFacts[0].site !== twoFacts[1].site, `…with different sites ($${twoFacts[0]?.site?.toString(16).toUpperCase()} and $${twoFacts[1]?.site?.toString(16).toUpperCase()})`);
const secondSiteExpected = BASIC + TWO_SYS.indexOf(0x9e, TWO_SYS.indexOf(0x9e) + 1);
check(twoFacts.length === 2 && twoFacts[1].site === secondSiteExpected, "…and the second site is the second $9E, computed independently");
check(twoFacts.length === 2 && twoFacts[0].value === 2064 && twoFacts[1].value === 4096, "…each with its own target");

// A SYS inside a string or a REM is not a call.
const NOT_CALLS = layout(BASIC, [
  { number: 10, bytes: [0x99, 0x20, 0x22, 0x9e, 0x20, 0x32, 0x30, 0x36, 0x34, 0x22] }, // PRINT "{YEL} 2064"
  { number: 20, bytes: [0x8f, 0x20, 0x9e] },                                           // REM ...
]);
const notWalk = walkBasicProgram(NOT_CALLS, BASIC);
check(notWalk.ok && extractBasicFacts(notWalk.lines).length === 0, "a $9E inside a string or a REM is a character, not a SYS");

// ---------------------------------------------------------------- BASIC followed by machine code

// `10 SYS 2080`, then real 6502 at $0820. The BASIC region must not swallow it.
const BASIC_PART = layout(BASIC, [{ number: 10, bytes: [0x9e, 0x20, 0x32, 0x30, 0x38, 0x30] }]);
const ML_AT_0820 = [0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60]; // LDA #$00 / STA $D020 / RTS
const padding = new Array(0x0820 - BASIC - BASIC_PART.length).fill(0x00);
const MIXED = Uint8Array.from([...BASIC_PART, ...padding, ...ML_AT_0820]);
check(BASIC + BASIC_PART.length + padding.length === 0x0820, "the fixture really does place machine code at $0820");

const mixedWalk = walkBasicProgram(MIXED, BASIC);
check(mixedWalk.ok === true, "the mixed image walks as BASIC");
check(mixedWalk.ok && mixedWalk.endAddress < 0x0820, `the BASIC region ends at $${mixedWalk.ok ? mixedWalk.endAddress.toString(16).toUpperCase() : "?"}, below the machine code at $0820`);
check(mixedWalk.ok && mixedWalk.endAddress === 0x080c, "endAddress is the address of the final $0000 pointer");
check(mixedWalk.ok && mixedWalk.programRange.start === BASIC && mixedWalk.programRange.end === 0x080d, "programRange covers exactly the BASIC region, terminator included");
const mixedFacts = mixedWalk.ok ? extractBasicFacts(mixedWalk.lines) : [];
check(mixedFacts.length === 1 && mixedFacts[0].value === 2080, "the SYS target is 2080 — the address the machine code lives at");
check(mixedFacts.length === 1 && mixedFacts[0].site === BASIC + MIXED.indexOf(0x9e), "the fact's site is the $9E byte's own address, computed from the fixture");
check(
  mixedFacts.length === 1 && mixedFacts[0].value > mixedWalk.endAddress,
  "the SYS target lies past the end of the BASIC region, which is what makes it an edge into machine code",
);
check(detokenize(MIXED, BASIC) === "10 SYS 2080", "the trailing machine code does not leak into the listing");

// ---------------------------------------------------------------- the analysis door

const stubAnalysis = analyzeBasicProgram(STUB, BASIC);
check(stubAnalysis.ok === true && stubAnalysis.isStub === true, "a two-line launcher is a stub (basic_stub, D6)");
check(stubAnalysis.ok === true && stubAnalysis.listing === "10 SYS 2064", "the analysis carries the listing");
check(stubAnalysis.ok === true && stubAnalysis.facts.length === 1, "…and the facts");
const programAnalysis = analyzeBasicProgram(PROGRAM, BASIC);
check(programAnalysis.ok === true && programAnalysis.isStub === false, "a nine-line program is NOT a stub (basic, D6)");
check(programAnalysis.ok === true && programAnalysis.ascendingLineNumbers === true, "the line numbers ascend, and the walk says so");

// PRG header helpers, since the tools are handed .prg files.
const prg = toPrg(BASIC, STUB);
const split = stripPrgHeader(prg);
check(split.loadAddress === BASIC && same(split.body, STUB), "stripPrgHeader / toPrg are inverses");
check(detokenize(split.body, split.loadAddress) === "10 SYS 2064", "a .prg round-trips through the header helpers into a listing");

// ---------------------------------------------------------------- text -> bytes -> text

const SOURCE = [
  "10 PRINT \"{CLR}{WHT}HELLO\"",
  "20 FOR I=0 TO 255:POKE 1024+I,I:NEXT",
  "30 REM {RVS ON}TRX{RVS OFF}",
  "40 IF A$<>\"\" THEN GOSUB 100",
  "50 SYS 2*4096",
].join("\n");
const built = tokenize(SOURCE, BASIC);
check(detokenize(built, BASIC) === SOURCE, "text -> bytes -> text is identical for canonical listing text");
const builtWalk = walkBasicProgram(built, BASIC);
check(builtWalk.ok === true && builtWalk.lines.length === 5, "the bytes the tokeniser writes walk back as five line records");
check(builtWalk.ok && builtWalk.lines[1].bytes[0] === 0x81, "`FOR` really is stored as the $81 token, not as letters");
check(builtWalk.ok && builtWalk.lines[0].bytes.includes(0x93) && builtWalk.lines[0].bytes.includes(0x05), "{CLR} and {WHT} really are stored as $93 and $05");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 829: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
