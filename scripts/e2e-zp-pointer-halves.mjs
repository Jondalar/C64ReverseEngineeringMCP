#!/usr/bin/env node
// Issue #83 — an immediate becomes `#<label` / `#>label` only when it really builds a pointer.
//
// The renderer guessed a pointer from two immediates stored to adjacent zero-page cells whose
// combined value hits a label. A constant that merely equals a label's low byte (and a high
// byte that equals its high byte) was turned into a label half, so the listing still rebuilt
// byte-identical but stopped being relocatable. The pair must also be DEREFERENCED
// ((zp),y / (zp,x)) somewhere in the listing.
//
//   a  lda #<tbl / sta $fb / lda #>tbl / sta $fc / lda ($fb),y   -> label halves
//   b  the same constants stored to $fd/$fe, never dereferenced      -> literals
//   c  a lone lo half, no hi half                                   -> literal
//   d  a vector built in zero page and used by jmp ($00xx)          -> label halves
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
const BODY = Buffer.alloc(0x48, 0xea);
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
const prg = Buffer.concat([Buffer.from([0x00, 0xc0]), BODY]);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-zp-pointer-halves", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "zp-halves" });
  await call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts"), { recursive: true });
  writeFileSync(join(proj, "artifacts", "halves.prg"), prg);

  // The pointer pass runs on an analysis, so analyse first and render from that analysis.
  await call("analyze_prg", {
    prg_path: "artifacts/halves.prg", output_json: "artifacts/halves_analysis.json",
    entry_points: ["C000", "C010", "C020", "C030"],
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

  if (failCount > 0) console.log(`\n--- listing ---\n${asm}`);
  if (!HAVE_ASSEMBLER) {
    skipped += 1;
    console.log(`  SKIP  the listing rebuilds byte-identical  (KickAssembler not found at ${KICKASS} — skipped, not passed)`);
  } else {
    check(!/WARNING: rebuild/.test(out), "the listing rebuilds byte-identical in all four cases",
      out.split("\n").find((l) => /rebuild/i.test(l)));
  }
} finally {
  proc.kill();
  rmSync(proj, { recursive: true, force: true });
}
console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  e2e-zp-pointer-halves: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
