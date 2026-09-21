#!/usr/bin/env node
// BUG-060 defect 1 — a `code` segment over bytes that END MID-INSTRUCTION.
//
// A payload whose last byte is an opcode that wants operand bytes the image does
// not hold is ordinary: a block carved out of a bigger file stops where the
// carve stopped, not where an instruction does. `decodeInstruction` already
// refuses to invent the missing bytes — it degrades such an opcode to a 1-byte
// `.byte` fact. The renderer then took that fact through the INSTRUCTION path,
// where `operandTextFromFact` has nothing to say for mode `impl`, and
// `renderMnemonicAsm` emitted the mnemonic alone:
//
//       .byte                             // probable code
//
// `.byte` with no value assembles to NOTHING. The byte disappears, the rebuild
// comes out one byte short, and the listing carries
// `WARNING: rebuild diverges … at body offset 0x…` with no hint that the tail
// is where it went. The caller's only remedies were to guess a data-tail length
// or to drop the `code` classification of the whole body — and dropping it is
// what costs the coverage the classification was for.
//
// What this gate holds the renderer to:
//
//   D1a  no `.byte` line is ever emitted without a value — the defect's shape,
//        provable without an assembler.
//   D1b  the code ends at the last instruction that FITS, and the listing SAYS
//        so, naming the boundary and the bytes that follow it.
//   D1c  the classification survives: the body is still rendered as a `code`
//        segment, with its instructions, not demoted to one data blob.
//   D1d  the rebuild is byte-identical. Needs KickAssembler; SKIPS LOUDLY
//        without a jar, the way e2e:830 / e2e:832 / e2e:865 do.
//
// Three tail shapes, because the truncation can cut an instruction anywhere:
// a 3-byte opcode as the last byte, a 3-byte opcode with one operand byte, and
// a 2-byte opcode as the last byte. A fourth case is the control: the same
// bytes with the tail complete must stay byte-identical too.
//
// Hermetic: synthetic bytes, the bundled analyzer and renderer, no project,
// no ROMs, no runtime.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:bug060-code-tail

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `\n          ${detail}` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_ASSEMBLER = existsSync(KICKASS);

console.log("BUG-060 defect 1 — a code segment whose bytes end mid-instruction\n");

const LOAD = 0x4300;
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

// The body every case shares: a small routine the analyser can walk from $4300,
// then four NOPs, then the tail under test.
const TRUNK = [
  0xa9, 0x00,        // 4300  lda #$00
  0x8d, 0x20, 0xd0,  // 4302  sta $d020
  0x20, 0x0d, 0x43,  // 4305  jsr $430D
  0x60,              // 4308  rts
  0xea, 0xea, 0xea, 0xea, // 4309  nop nop nop nop
  0x60,              // 430D  rts
];

const CASES = [
  { name: "a 3-byte opcode as the LAST byte", tail: [0xad], lostBytes: 1 },
  { name: "a 3-byte opcode with one operand byte only", tail: [0xad, 0x12], lostBytes: 1 },
  { name: "a 2-byte opcode as the LAST byte", tail: [0xa9], lostBytes: 1 },
  { name: "CONTROL: the same tail, complete", tail: [0xad, 0x12, 0x43], lostBytes: 0 },
];

// Render one case: analyse the bytes, annotate the WHOLE body as one `code`
// segment (what a caller who has understood the block writes down), render.
function render(tail) {
  const body = [...TRUNK, ...tail];
  const last = LOAD + body.length - 1;
  const dir = mkdtempSync(join(tmpdir(), "c64re-bug060-tail-"));
  const raw = join(dir, "core_4300.bin");
  writeFileSync(raw, Buffer.from(body));

  const analysisPath = join(dir, "core_4300_analysis.json");
  execFileSync(process.execPath, [cli, "analyze-prg", raw, analysisPath, "4300",
    "--load-address", "$4300", "--no-register"], { stdio: "pipe" });

  const annPath = join(dir, "core_4300_annotations.json");
  writeFileSync(annPath, JSON.stringify({
    segments: [{ start: hex4(LOAD), end: hex4(last), kind: "code", label: "core" }],
    labels: [], routines: [],
  }, null, 2));

  const asmPath = join(dir, "core_4300.asm");
  const stdout = execFileSync(process.execPath, [cli, "disasm-raw", raw, asmPath,
    "--load-address", "$4300", "--analysis", analysisPath, "--annotations", annPath,
    "--no-register"], { stdio: "pipe" }).toString();

  return { dir, body, last, asmPath, asm: readFileSync(asmPath, "utf8"), stdout };
}

// Assemble and compare against the bytes the listing was rendered from.
function rebuild(dir, asmPath, body) {
  const outPrg = join(dir, "rebuild.prg");
  let out = "";
  try {
    out = execFileSync("java", ["-jar", KICKASS, asmPath, "-o", outPrg], { stdio: "pipe" }).toString();
  } catch (e) {
    return { ok: false, detail: `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /rror/.test(l)).slice(0, 2).join(" / ") };
  }
  if (!existsSync(outPrg)) return { ok: false, detail: `${out.slice(0, 200)}` };
  const built = readFileSync(outPrg).subarray(2);
  const orig = Buffer.from(body);
  let diff;
  for (let i = 0; i < Math.min(built.length, orig.length); i += 1) {
    if (built[i] !== orig[i]) { diff = i; break; }
  }
  if (diff === undefined && built.length !== orig.length) diff = Math.min(built.length, orig.length);
  return diff === undefined
    ? { ok: true, detail: `${orig.length} bytes` }
    : { ok: false, detail: `diverges at body offset 0x${diff.toString(16).toUpperCase()} — built ${built.length} bytes, the block holds ${orig.length}` };
}

for (const c of CASES) {
  console.log(`\n── ${c.name}`);
  const r = render(c.tail);
  // the body of the listing: strip the comments, they carry `$`-prefixed prose
  const code = r.asm.split("\n").map((l) => l.split("//")[0]).join("\n");

  // D1a — the exact defect shape: `.byte` with no value assembles to nothing.
  const bodyless = code.split("\n").filter((l) => /^\s*\.byte\s*$/.test(l));
  check(bodyless.length === 0,
    "D1a no `.byte` is emitted without a value",
    bodyless.length === 0 ? "" : `${bodyless.length} bodyless .byte line(s) — each one is a byte the rebuild loses`);

  if (c.lostBytes > 0) {
    // D1b — the boundary is DERIVED and stated: the last instruction that fits
    // is named, and so are the bytes that follow it.
    const note = r.asm.split("\n").find((l) => /code ends at \$[0-9A-F]{4}/i.test(l));
    check(note !== undefined,
      "D1b the listing says where the code ended and why",
      note ? `“${note.trim()}”` : "no line names the boundary — a caller reading the listing cannot tell the tail from a bug");
    if (note) {
      check(/\$430D/.test(note),
        "D1b the boundary named is the last instruction that FITS ($430D, the rts)",
        `“${note.trim()}”`);
      check(new RegExp(`\\$${hex4(LOAD + TRUNK.length)}`).test(note),
        `D1b …and the first byte that could not be decoded ($${hex4(LOAD + TRUNK.length)}) is named too`,
        `“${note.trim()}”`);
    }
    // …and the bytes it could not decode are in the listing, as data.
    const tailBytes = c.tail.map((b) => `$${b.toString(16).toUpperCase().padStart(2, "0")}`);
    check(tailBytes.every((t) => new RegExp(`\\.byte[^\\n]*\\${t}\\b`).test(code)),
      `D1b the undecodable tail is emitted as data (${tailBytes.join(", ")})`);
  }

  // D1c — the classification survives: this is still a code segment with code in it.
  check(/^\s*lda\s+#\$00/m.test(code) && /^\s*sta(\.abs)?\s+\$D020/mi.test(code),
    "D1c the body is still rendered as code — the caller does not have to drop the segment to get a rebuild");

  // D1d — the proof.
  if (!HAVE_ASSEMBLER) {
    skip("D1d byte-identical rebuild", `KickAssembler not found at ${KICKASS} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
  } else {
    const v = rebuild(r.dir, r.asmPath, r.body);
    check(v.ok, "D1d the listing rebuilds byte-identical", v.detail);
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  BUG-060 defect 1: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount ? 1 : 0);
