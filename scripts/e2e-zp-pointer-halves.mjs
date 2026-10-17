#!/usr/bin/env node
// Issue #83 — an immediate becomes `#<label` / `#>label` only when it really builds a pointer.
//
// The renderer guessed a pointer from two immediates stored to adjacent zero-page cells whose
// combined value hits a label. A constant that merely equals a label's low byte (and a high
// byte that equals its high byte) was turned into a label half, so the listing still rebuilt
// byte-identical but stopped being relocatable. The pointer BUILT BY THESE STORES must be
// dereferenced - (zp),y / (zp,x) / jmp ($00xx) - on a path from the stores, before either cell
// is overwritten: in the same routine or in a callee. A cell that is a pointer in some OTHER
// routine (an engine's shared pointer pool) proves nothing about this setup.
//
//   a  lda #<tbl / sta $fb / lda #>tbl / sta $fc / lda ($fb),y   -> label halves
//   b  the same constants stored to $fd/$fe, never dereferenced      -> literals
//   c  a lone lo half, no hi half                                   -> literal
//   d  a vector built in zero page and used by jmp ($00xx)          -> label halves
//   e  shared pool: $f3 is (zp),y elsewhere; this setup's callee reads $f3/$f4 as plain
//      operands (lda $f3 / adc $f4)                                 -> literals
//   f  a setup followed by jsr to a callee that does lda ($f5),y    -> label halves
//   g  setup, the cell is overwritten, only then a deref            -> literals
//   h  two setups with a call between: the high half of one and the low half of the next must
//      not pair up, however the cell is used                        -> literals
//   i  a setup followed by jsr to a routine outside the image: unknown flow -> literals
//   j  the same pair, the setup routine returns and its caller derefs    -> label halves
//   k  the callee is in ANOTHER file of the project and does lda ($d0),y -> label halves
//   l  the callee is in another file and reads the cells as plain operands -> literals
//   m  two files are resident at the callee address and disagree          -> literals, and the
//      listing says "callee $D020 ambiguous: 2 residents"
//   o  the other file's routine saves the cells on the stack, uses them, restores them, then derefs -> label halves
//   p  the other file's routine reaches its deref after three nested calls that leave the cells alone -> label halves
//   q  the other file's routine saves the cells into patch operands (self-modifying) and restores them from there -> label halves
//   n  two files resident at the callee address that agree (both deref)   -> label halves
//
// Hermetic: a temp project and synthetic bytes. The rebuild check needs KickAssembler and is
// skipped loudly without a jar, the way e2e:disasm-family is.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:zp-pointer-halves

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_ASSEMBLER = existsSync(KICKASS);

const proj = mkdtempSync(join(tmpdir(), "c64re-zp-halves-"));
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pend = new Map();
let nid = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    let m;
    try { m = JSON.parse(ln); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nid++;
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// $C040 is the table (a label: the code reads it). Its low byte is $40, its high byte $C0.
const BODY = Buffer.alloc(0x1a0, 0xea);
Buffer.from([
  // a  $C000 — a real pointer setup, dereferenced
  0xa9, 0x40, 0x85, 0xfb, 0xa9, 0xc0, 0x85, 0xfc, 0xa0, 0x00, 0xb1, 0xfb, 0xad, 0x40, 0xc0, 0x60,
]).copy(BODY, 0x00);
Buffer.from([
  // b  $C010 — the same two constants into $FD/$FE, nothing dereferences them
  0xa9, 0x40, 0x85, 0xfd, 0xa9, 0xc0, 0x85, 0xfe, 0x60,
]).copy(BODY, 0x10);
Buffer.from([
  // c  $C020 — a lone low half
  0xa9, 0x40, 0x85, 0xf7, 0x60,
]).copy(BODY, 0x20);
Buffer.from([
  // d  $C030 — a vector built in $F9/$FA and jumped through: jmp ($00f9)
  0xa9, 0x40, 0x85, 0xf9, 0xa9, 0xc0, 0x85, 0xfa, 0x6c, 0xf9, 0x00,
]).copy(BODY, 0x30);
Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]).copy(BODY, 0x40);
const put = (at, bytes) => Buffer.from(bytes).copy(BODY, at);
// e  $C050 - setup, jsr to $C060 which only reads $f3/$f4 as plain operands; $C070 is the pool
//    routine that uses ($f3),y
put(0x50, [0xa9, 0x40, 0x85, 0xf3, 0xa9, 0xc0, 0x85, 0xf4, 0x20, 0x60, 0xc0, 0x60]);
put(0x60, [0xa5, 0xf3, 0x18, 0x65, 0xf4, 0x60]);
put(0x70, [0xa0, 0x00, 0xb1, 0xf3, 0x60]);
// f  $C080 - setup, jsr to $C090 which does lda ($f5),y
put(0x80, [0xa9, 0x40, 0x85, 0xf5, 0xa9, 0xc0, 0x85, 0xf6, 0x20, 0x90, 0xc0, 0x60]);
put(0x90, [0xa0, 0x00, 0xb1, 0xf5, 0x60]);
// g  $C0A0 - setup into $e0/$e1, then $e0 is overwritten, then lda ($e0),y
put(0xa0, [0xa9, 0x40, 0x85, 0xe0, 0xa9, 0xc0, 0x85, 0xe1, 0xa9, 0x01, 0x85, 0xe0, 0xa0, 0x00, 0xb1, 0xe0, 0x60]);
// h  $C0C0 - setup ($c013), jsr, setup ($0140); the high half of the first ($c0) and the low half
//    of the second ($40) would read as $c040; the callee $C0E0 derefs ($e2),y
put(0xc0, [0xa2, 0x13, 0xa0, 0xc0, 0x86, 0xe2, 0x84, 0xe3, 0x20, 0xe0, 0xc0,
           0xa2, 0x40, 0xa0, 0x01, 0x86, 0xe2, 0x84, 0xe3, 0x20, 0xe0, 0xc0, 0x60]);
put(0xe0, [0xa0, 0x00, 0xb1, 0xe2, 0x60]);
// i  $C0F0 - setup into $e4/$e5, jsr $1000 (outside the image)
put(0xf0, [0xa9, 0x40, 0x85, 0xe4, 0xa9, 0xc0, 0x85, 0xe5, 0x20, 0x00, 0x10, 0x60]);
// j  $C100 - a helper that sets $e6/$e7 and returns; $C110 calls it and then derefs ($e6),y
put(0x100, [0xa9, 0x40, 0x85, 0xe6, 0xa9, 0xc0, 0x85, 0xe7, 0x60]);
put(0x110, [0x20, 0x00, 0xc1, 0xa0, 0x00, 0xb1, 0xe6, 0x60]);
// k l m n  $C130.. - setups whose jsr goes into other files of the project
const setupCall = (at, cell, target) => put(at, [0xa9, 0x40, 0x85, cell, 0xa9, 0xc0, 0x85, cell + 1, 0x20, target & 0xff, target >> 8, 0x60]);
setupCall(0x130, 0xd0, 0x9000);
setupCall(0x140, 0xd2, 0x9010);
setupCall(0x150, 0xd4, 0xd020);
setupCall(0x160, 0xd6, 0xd030);
setupCall(0x170, 0xd8, 0x9020);
setupCall(0x180, 0xda, 0x9040);
setupCall(0x190, 0xdc, 0x90a0);
const otherFile = (loadAddress, routines) => {
  const body = Buffer.alloc(0xe0, 0xea);
  for (const [at, bytes] of routines) Buffer.from(bytes).copy(body, at);
  return Buffer.concat([Buffer.from([loadAddress & 0xff, loadAddress >> 8]), body]);
};
// C @ $9000 (the only resident there): $9000 derefs ($d0),y, $9010 reads $d2/$d3 as plain operands
const FILE_C = otherFile(0x9000, [[0x00, [0xa0, 0x00, 0xb1, 0xd0, 0x60]], [0x10, [0xa5, 0xd2, 0x18, 0x65, 0xd3, 0x60]],
  // borrows $d8/$d9 for its own use, puts the caller's values back, then derefs ($d8),y
  // calls a helper that calls a helper that calls a helper (none touches $da/$db), then derefs ($da),y
  // saves $dc/$dd into the operands of two later `lda #imm` (self-modifying), borrows the cells, then
  // restores them with those `lda #imm` / `sta` pairs and derefs ($dc),y
  [0xa0, [0xa5, 0xdc, 0x8d, 0xba, 0x90, 0xa5, 0xdd, 0x8d, 0xbe, 0x90, 0xa9, 0x00, 0x85, 0xdc, 0x85, 0xdd]],
  [0xb9, [0xa9, 0x00, 0x85, 0xdc, 0xa9, 0x00, 0x85, 0xdd, 0xa0, 0x00, 0xb1, 0xdc, 0x60]],
  [0x40, [0x20, 0x60, 0x90, 0xa0, 0x00, 0xb1, 0xda, 0x60]], [0x60, [0x20, 0x70, 0x90, 0x60]], [0x70, [0x20, 0x80, 0x90, 0x60]], [0x80, [0x60]],
  [0x20, [0xa5, 0xd8, 0x48, 0xa5, 0xd9, 0x48, 0xa9, 0x00, 0x85, 0xd8, 0x85, 0xd9, 0x68, 0x85, 0xd9, 0x68, 0x85, 0xd8, 0xa0, 0x00, 0xb1, 0xd8, 0x60]]]);
// B and B2 @ $D000, both resident: $D020 differs (B derefs ($d4),y, B2 reads $d4 plain), $D030 agrees
const FILE_B = otherFile(0xd000, [[0x20, [0xa0, 0x00, 0xb1, 0xd4, 0x60]], [0x30, [0xa0, 0x00, 0xb1, 0xd6, 0x60]]]);
const FILE_B2 = otherFile(0xd000, [[0x20, [0xa5, 0xd4, 0x60]], [0x30, [0xa0, 0x00, 0xb1, 0xd6, 0x60]]]);

const prg = Buffer.concat([Buffer.from([0x00, 0xc0]), BODY]);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-zp-pointer-halves", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { preferred_assembler: "kickass", name: "zp-halves" });
  await call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts"), { recursive: true });
  writeFileSync(join(proj, "artifacts", "halves.prg"), prg);
  for (const [name, bytes, entries] of [["callee_c", FILE_C, ["9000", "9010", "9020", "9040", "9060", "9070", "9080", "90A0"]], ["callee_b", FILE_B, ["D020", "D030"]], ["callee_b2", FILE_B2, ["D020", "D030"]]]) {
    writeFileSync(join(proj, "artifacts", `${name}.prg`), bytes);
    await call("analyze_prg", { prg_path: `artifacts/${name}.prg`, output_json: `artifacts/${name}_analysis.json`, entry_points: entries });
  }

  // The pointer pass runs on an analysis, so analyse first and render from that analysis.
  await call("analyze_prg", {
    prg_path: "artifacts/halves.prg", output_json: "artifacts/halves_analysis.json",
    entry_points: ["C000", "C010", "C020", "C030", "C050", "C060", "C070", "C080", "C090", "C0A0", "C0C0", "C0E0", "C0F0", "C100", "C110", "C130", "C140", "C150", "C160", "C170", "C180", "C190"],
  });
  const out = await call("disasm_prg", {
    prg_path: "artifacts/halves.prg", analysis_json: "artifacts/halves_analysis.json",
  });
  const asmPath = /^Output: (.+)$/m.exec(out)?.[1];
  const asm = asmPath && existsSync(asmPath) ? readFileSync(asmPath, "utf8") : "";
  check(asm.length > 0, "the listing was written", asmPath ?? out.slice(0, 200));
  const lines = asm.split("\n");
  // the instruction lines carry the address as a comment or label; find them by their operand store
  const around = (zp) => {
    const i = lines.findIndex((l) => new RegExp(`sta\\s+\\$${zp}\\b`, "i").test(l));
    return i < 0 ? [] : lines.slice(Math.max(0, i - 1), i + 1);
  };
  const aLo = around("fb")[0] ?? "", aHi = around("fc")[0] ?? "";
  check(/lda\s+#<\S+/i.test(aLo) && /lda\s+#>\S+/i.test(aHi),
    "a: a pointer that is dereferenced as ($fb),y renders as label halves", `${aLo.trim()} | ${aHi.trim()}`);
  const bLo = around("fd")[0] ?? "", bHi = around("fe")[0] ?? "";
  check(/lda\s+#\$40/i.test(bLo) && /lda\s+#\$c0/i.test(bHi),
    "b: the same constants stored to cells nothing dereferences stay literal", `${bLo.trim()} | ${bHi.trim()}`);
  const cLo = around("f7")[0] ?? "";
  check(/lda\s+#\$40/i.test(cLo), "c: a lone low half stays literal", cLo.trim());
  const dLo = around("f9")[0] ?? "", dHi = around("fa")[0] ?? "";
  check(/lda\s+#<\S+/i.test(dLo) && /lda\s+#>\S+/i.test(dHi),
    "d: a vector jumped through as jmp ($00f9) renders as label halves", `${dLo.trim()} | ${dHi.trim()}`);


  const eLo = around("f3")[0] ?? "", eHi = around("f4")[0] ?? "";
  check(/lda\s+#\$40/i.test(eLo) && /lda\s+#\$c0/i.test(eHi),
    "e: shared pool - $f3 is (zp),y in another routine, but this pair goes to a callee that reads it as a plain operand: literals", `${eLo.trim()} | ${eHi.trim()}`);
  const fLo = around("f5")[0] ?? "", fHi = around("f6")[0] ?? "";
  check(/lda\s+#<\S+/i.test(fLo) && /lda\s+#>\S+/i.test(fHi),
    "f: a setup followed by jsr to a callee that does lda ($f5),y renders as label halves", `${fLo.trim()} | ${fHi.trim()}`);
  const gLo = around("e0")[0] ?? "", gHi = around("e1")[0] ?? "";
  check(/lda\s+#\$40/i.test(gLo) && /lda\s+#\$c0/i.test(gHi),
    "g: the cell is overwritten before the deref: literals", `${gLo.trim()} | ${gHi.trim()}`);
  check(/ldx\s+#\$40/i.test(asm) && /ldy\s+#\$c0/i.test(asm) && !/ldx\s+#<\S+/i.test(asm) && !/ldy\s+#>\S+/i.test(asm),
    "h: the high half of one setup and the low half of the next never pair across a call", (asm.match(/(ldx|ldy)\s+#[<>]\S+/gi) ?? []).join(" "));
  const iLo = around("e4")[0] ?? "", iHi = around("e5")[0] ?? "";
  check(/lda\s+#\$40/i.test(iLo) && /lda\s+#\$c0/i.test(iHi),
    "i: a setup followed by jsr to a routine outside the image is unknown flow: literals", `${iLo.trim()} | ${iHi.trim()}`);
  const jLo = around("e6")[0] ?? "", jHi = around("e7")[0] ?? "";
  check(/lda\s+#<\S+/i.test(jLo) && /lda\s+#>\S+/i.test(jHi),
    "j: the setup routine returns and its caller does lda ($e6),y: label halves", `${jLo.trim()} | ${jHi.trim()}`);


  const kLo = around("d0")[0] ?? "", kHi = around("d1")[0] ?? "";
  check(/lda\s+#<\S+/i.test(kLo) && /lda\s+#>\S+/i.test(kHi),
    "k: the callee is in another file of the project and does lda ($d0),y: label halves", `${kLo.trim()} | ${kHi.trim()}`);
  const lLo = around("d2")[0] ?? "", lHi = around("d3")[0] ?? "";
  check(/lda\s+#\$40/i.test(lLo) && /lda\s+#\$c0/i.test(lHi),
    "l: the callee is in another file and reads the cells as plain operands: literals", `${lLo.trim()} | ${lHi.trim()}`);
  const mLo = around("d4")[0] ?? "", mHi = around("d5")[0] ?? "";
  check(/lda\s+#\$40/i.test(mLo) && /lda\s+#\$c0/i.test(mHi) && /zp-pair \$D4\/\$D5.*callee \$D020 ambiguous: 2 residents/.test(asm),
    "m: two files resident at the callee address that disagree: literals, and the listing says so", `${mLo.trim()} | ${mHi.trim()}`);
  const nLo = around("d6")[0] ?? "", nHi = around("d7")[0] ?? "";
  check(/lda\s+#<\S+/i.test(nLo) && /lda\s+#>\S+/i.test(nHi),
    "n: two files resident at the callee address that agree (both deref): label halves", `${nLo.trim()} | ${nHi.trim()}`);

  const oLo = around("d8")[0] ?? "", oHi = around("d9")[0] ?? "";
  check(/lda\s+#<\S+/i.test(oLo) && /lda\s+#>\S+/i.test(oHi),
    "o: the callee saves the cells (lda / pha), reuses them, restores them (pla / sta) and then derefs: label halves", `${oLo.trim()} | ${oHi.trim()}`);

  const pLo = around("da")[0] ?? "", pHi = around("db")[0] ?? "";
  check(/lda\s+#<\S+/i.test(pLo) && /lda\s+#>\S+/i.test(pHi),
    "p: the deref comes after nested calls below the depth bound that provably leave the cells alone: label halves", `${pLo.trim()} | ${pHi.trim()}`);

  const qLo = around("dc")[0] ?? "", qHi = around("dd")[0] ?? "";
  check(/lda\s+#<\S+/i.test(qLo) && /lda\s+#>\S+/i.test(qHi),
    "q: the callee parks the cells in patch operands, borrows them, restores them from the patched lda #imm and derefs: label halves", `${qLo.trim()} | ${qHi.trim()}`);

  if (failCount > 0) console.log(`\n--- listing ---\n${asm}`);
  if (!HAVE_ASSEMBLER) {
    skipped += 1;
    console.log(`  SKIP  the listing rebuilds byte-identical  (KickAssembler not found at ${KICKASS} — skipped, not passed)`);
  } else {
    check(!/WARNING: rebuild/.test(out), "the listing rebuilds byte-identical in all cases",
      out.split("\n").find((l) => /rebuild/i.test(l)));
  }
} finally {
  proc.kill();
  rmSync(proj, { recursive: true, force: true });
}
console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  e2e-zp-pointer-halves: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
