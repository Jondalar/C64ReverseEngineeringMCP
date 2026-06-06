#!/usr/bin/env node
// Spec 758 — static code-discovery completeness. Hermetic fixtures prove the two
// seed-recovery levers find code that flow-only descent cannot reach.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/pipeline/analysis/code-discovery.cjs"))) { console.error("build:pipeline first"); process.exit(2); }
const { discoverCode } = await import("../dist/pipeline/analysis/code-discovery.cjs");

console.log("Spec 758 — static code-discovery (seed recovery)\n");

const START = 0x1000;
const mk = (bytes) => {
  const buf = Buffer.alloc(0x400, 0x60); // pad with RTS so seeds land on a valid op
  for (const [addr, ...b] of bytes) for (let i = 0; i < b.length; i++) buf[addr - START + i] = b[i];
  return buf;
};
const run = (buf) => discoverCode({
  binaryName: "fixture", buffer: buf,
  mapping: { format: "raw", loadAddress: START, startAddress: START, endAddress: START + buf.length - 1, fileOffset: 0, fileSize: buf.length },
  entryPoints: [{ address: START, source: "manual", reason: "test entry" }],
});
const reached = (res, addr) => res.instructions.some((i) => i.address === addr);

// §3.2 self-mod: lda#lo/sta J+1, lda#hi/sta J+2, J: jmp $0000 → target $1234.
{
  const buf = mk([
    [0x1000, 0xa9, 0x34],              // LDA #$34
    [0x1002, 0x8d, 0x0b, 0x10],        // STA $100B (J+1)
    [0x1005, 0xa9, 0x12],              // LDA #$12
    [0x1007, 0x8d, 0x0c, 0x10],        // STA $100C (J+2)
    [0x100a, 0x4c, 0x00, 0x00],        // J: JMP $0000  (patched → $1234)
    [0x1234, 0xea, 0x60],              // NOP ; RTS at the target
  ]);
  const res = run(buf);
  ok("1 self-mod jmp/jsr operand target is discovered without a trace seed", reached(res, 0x1234), "$1234");
  // and the recursive-descent reached the body bytes
  ok("1b the patched target body is disassembled (NOP@$1234)", res.instructions.some((i) => i.address === 0x1234 && i.mnemonic === "nop"));
}

// §3.1 single indirect: jmp ($1020), pointer at $1020 = $1234.
{
  const buf = mk([
    [0x1000, 0x6c, 0x20, 0x10],        // JMP ($1020)
    [0x1020, 0x34, 0x12],              // pointer → $1234
    [0x1234, 0xea, 0x60],              // NOP ; RTS
  ]);
  const res = run(buf);
  ok("2 indirect jmp ($abs) target is discovered without a trace seed", reached(res, 0x1234), "$1234");
}

// Control: a plain flow-only program still works + no spurious seeds.
{
  const buf = mk([
    [0x1000, 0x20, 0x10, 0x10],        // JSR $1010
    [0x1003, 0x60],                    // RTS
    [0x1010, 0xa9, 0x01],              // LDA #$01
    [0x1012, 0x60],                    // RTS
  ]);
  const res = run(buf);
  ok("3 plain flow descent still reaches a jsr target", reached(res, 0x1010));
}

// §4 — known-routine coherence (Spec 759 map). An island that calls 3 known
// routines but has NO inbound reference is recovered ONLY when the project index
// is present (rebuild-safe: standalone PRGs have no index → no change).
{
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const proj = mkdtempSync(join(tmpdir(), "c64re-758s4-"));
  mkdirSync(join(proj, "knowledge", ".cache"), { recursive: true });
  wf(join(proj, "knowledge", ".cache", "address-index.json"), JSON.stringify({ builtMs: 9e15, entries: [
    { owner: "eng", start: 0x2000, end: 0x2000, kind: "code", label: "r1" },
    { owner: "eng", start: 0x2003, end: 0x2003, kind: "code", label: "r2" },
    { owner: "eng", start: 0x2006, end: 0x2006, kind: "code", label: "r3" },
  ] }));
  // PRG load $1000: entry RTS at $1000; an unreachable island at $1100 calling 3
  // known routines + RTS; the known routines (RTS) at $2000/$2003/$2006.
  const buf = Buffer.alloc(2 + 0x1010, 0x60);
  buf.writeUInt16LE(0x1000, 0);
  const put = (addr, ...b) => { for (let i = 0; i < b.length; i++) buf[2 + (addr - 0x1000) + i] = b[i]; };
  // jsr r1/r2/r3/r1/r2 ; rts  (≥5 instr so it clears the minimum-island bar)
  put(0x1100, 0x20, 0x00, 0x20, 0x20, 0x03, 0x20, 0x20, 0x06, 0x20, 0x20, 0x00, 0x20, 0x20, 0x03, 0x20, 0x60);
  const prgPath = join(proj, "mod.prg");
  wf(prgPath, buf);
  const cli = join(ROOT, "dist/pipeline/cli.cjs");
  const analyze = (withIndex) => {
    const out = join(proj, withIndex ? "with.json" : "without.json");
    execFileSync("node", [cli, "analyze-prg", prgPath, out], { env: withIndex ? { ...process.env, C64RE_PROJECT_DIR: proj } : { ...process.env, C64RE_PROJECT_DIR: "" }, stdio: "ignore" });
    const a = JSON.parse(rf(out, "utf8"));
    return (a.probableCodeAnalysis?.codeCandidates || []).some((s) => 0x1100 >= s.start && 0x1100 <= s.end);
  };
  ok("4 island calling 3 known routines is NOT recovered without the project index", analyze(false) === false);
  ok("4b same island IS recovered with the index (known-routine coherence)", analyze(true) === true);
}

console.log(`\nSpec 758 code-discovery: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
