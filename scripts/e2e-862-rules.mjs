#!/usr/bin/env node
// Spec 862 §7.1, §7.2, §7.5 and §7.6 — the rules, the refusals, and the two
// things the tool must never do.
//
//  §7.1  every rule has a positive and a negative fixture. The positive yields
//        its candidate with the verdict EQUIVALENT (or the structural class's
//        measurement) and the exact Δ; the negative — a live flag, a return
//        address that is read, a target out of branch range — yields none, and
//        where the rule fired it is counted.
//  §7.2  timing code is left alone: a delay loop, a stable-raster routine and a
//        drive GCR loop produce no candidate and all three appear in the
//        exclusion list with the reason.
//  §7.5  nothing is applied: the project's bytes and its graph are byte-for-byte
//        what they were before the run.
//  §7.6  undocumented opcodes are opt-in. Off, no LAX or DCP candidate; on,
//        they appear.
//
// §7.3 and §7.4 need a measurement and live in `e2e:862-rank` (synthesised rows
// through 861's own evaluator) and in `smoke:862` (a real capture).
//
// The project is built through the product's own doors — project_init,
// agent_onboard, analyze_prg, disasm_prg with an annotations file, save_finding
// for the free-RAM slot — so the fixture is the product's output and not a
// hand-written graph. Hermetic: no ROM, no assembler, no media, no runtime.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:862-rules

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

console.log("Spec 862 §7.1/§7.2/§7.5/§7.6 — a fixture per rule, the refusals, and nothing applied\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

// ---------------------------------------------------------------- the fixture
//
// One PRG at $C000, one routine per rule, positive and negative side by side.
// Built here rather than assembled, so the gate needs no assembler.

const LOAD = 0xc000;
const B = [];
const ROUTINES = [];
let open = null;
const here = () => LOAD + B.length;
const emit = (...b) => B.push(...b);
const close = () => { if (open) ROUTINES.push({ ...open, end: here() - 1 }); open = null; };
const routine = (name, comment) => { close(); open = { name, comment, start: here() }; };
const at = (addr, name, comment) => { close(); while (here() < addr) B.push(0xea); open = { name, comment, start: addr }; };
const rel = (to, from) => (to - (from + 2)) & 0xff;

// --- local: tail-call
routine("tailcall", "jsr then rts — the tail call");
emit(0x20, 0x00, 0xc2, 0x60);                       // jsr plain ($C200) / rts
routine("tailneg", "the callee reads its own return address");
emit(0x20, 0x20, 0xc2, 0x60);                       // jsr stacky ($C220) / rts

// --- local: redundant-load
routine("redundant", "store then load the same cell");
emit(0xa5, 0x11, 0x85, 0x10, 0xa5, 0x10, 0x60);     // lda $11 / sta $10 / lda $10 / rts
routine("redundantneg", "the same shape with the flags live and different");
emit(0xa5, 0x11, 0xc9, 0x05, 0x85, 0x10, 0xa5, 0x10, 0x60); // lda $11 / cmp #$05 / sta $10 / lda $10 / rts

// --- local: jump-to-next
routine("jumpnext", "a jump to the next instruction");
{ const a = here(); emit(0x4c, (a + 3) & 0xff, (a + 3) >> 8, 0x60); }
routine("jumpsomewhere", "a jump that goes somewhere else");
emit(0x4c, 0x00, 0xc2, 0xea);                        // jmp $C200

// --- local: jump-threading
routine("threadjmp", "a jmp to a jmp");
emit(0x4c, 0x40, 0xc2);                              // jmp hop ($C240) which holds jmp $C250
routine("threadbr", "a branch to a jmp, with the final target in reach");
{ const a = here(); emit(0xa5, 0x12, 0xd0, 0x00, 0x60); B[a + 3 - LOAD] = rel(a + 5, a + 2); }
routine("nearhop", "the hop the branch above goes through");
{ const a = here(); emit(0x4c, (a + 3) & 0xff, (a + 3) >> 8); }
routine("neartarget", "where that hop goes — close enough for the branch to reach it");
emit(0xa9, 0x02, 0x60);
routine("threadfar", "a branch to a jmp whose final target is out of reach");
{ const a = here(); emit(0xa5, 0x12, 0xd0, 0x00, 0x60); B[a + 3 - LOAD] = rel(a + 5, a + 2); }
routine("farhop", "the hop whose target no branch can reach");
emit(0x4c, 0x50, 0xc2);                              // jmp $C250 — far away

// --- dataflow: known-carry
routine("carrydup", "the carry is already what the second clc would set");
emit(0x18, 0x18, 0x60);
routine("carryedge", "the fall-through of a bcc has the carry set");
{
  const a = here();
  emit(0xa5, 0x13, 0xc9, 0x05);                      // lda $13 / cmp #$05
  const br = here();
  emit(0x90, 0x00);                                  // bcc skip
  emit(0x38, 0xe9, 0x05);                            // sec / sbc #$05   ← the sec is redundant
  const skip = here();
  B[br + 1 - LOAD] = rel(skip, br);
  emit(0x85, 0x14, 0x60);                            // sta $14 / rts
  void a;
}
routine("carrymoved", "something between writes the carry");
emit(0x18, 0x69, 0x01, 0x18, 0x60);                  // clc / adc #$01 / clc / rts

// --- dataflow: known-register
routine("knownreg", "the register already holds that value");
emit(0xa9, 0x05, 0x85, 0x20, 0xa9, 0x05, 0x85, 0x21, 0x60);
routine("knownregneg", "the same value, but the flags it sets are read");
{
  emit(0xa9, 0x05, 0xc5, 0x20);                      // lda #$05 / cmp $20
  emit(0xa9, 0x05);                                  // lda #$05   ← would change Z
  const br = here();
  emit(0xd0, 0x02);                                  // bne out
  emit(0xe6, 0x21);                                  // inc $21
  emit(0x60);
  void br;
}

// --- structural: count-down
routine("countdown", "an up-counting loop whose index nothing reads");
{
  emit(0xa2, 0x00);
  const head = here();
  emit(0x8d, 0x00, 0x04, 0xe8, 0xe0, 0x28);          // sta $0400 / inx / cpx #$28
  const br = here();
  emit(0xd0, rel(head, br));
  emit(0xa2, 0x00, 0x18, 0x60);                      // ldx #$00 / clc / rts — X, N, Z, C dead
}
routine("countdownneg", "the same loop, but the body reads the index");
{
  emit(0xa2, 0x00);
  const head = here();
  emit(0xbd, 0x00, 0x20, 0xe8, 0xe0, 0x28);          // lda $2000,x / inx / cpx #$28
  const br = here();
  emit(0xd0, rel(head, br));
  emit(0xa2, 0x00, 0x18, 0x60);
}

// --- structural: page-align
routine("pagealign", "an indexed read across a page boundary");
{
  emit(0xa2, 0x27);
  const head = here();
  emit(0xbd, 0xf0, 0x10, 0x9d, 0x00, 0x04, 0xca);    // lda $10F0,x / sta $0400,x / dex
  const br = here();
  emit(0x10, rel(head, br));
  emit(0x60);
}
routine("pagealignneg", "the same loop over a table that starts on a page");
{
  emit(0xa2, 0x27);
  const head = here();
  emit(0xbd, 0x00, 0x11, 0x9d, 0x00, 0x04, 0xca);    // lda $1100,x
  const br = here();
  emit(0x10, rel(head, br));
  emit(0x60);
}

// --- structural: zp-promote
routine("zpvar", "one absolute cell, read and written");
emit(0xad, 0x00, 0x20, 0x18, 0x69, 0x01, 0x8d, 0x00, 0x20, 0x60);
routine("zpvarneg", "two cells, each touched once");
emit(0xad, 0x00, 0x21, 0x8d, 0x01, 0x21, 0x60);

// --- undocumented
routine("laxpair", "a load into A and X from the same cell");
emit(0xa5, 0x30, 0xa6, 0x30, 0x60);
routine("laxio", "the same shape on an I/O register, which is read twice on purpose");
emit(0xad, 0x12, 0xd0, 0xae, 0x12, 0xd0, 0x60);
routine("fusepair", "a read-modify-write and the compare on the same cell");
emit(0xc6, 0x31, 0xc5, 0x31, 0x60);
routine("fuseneg", "the same shape on two different cells");
emit(0xc6, 0x31, 0xc5, 0x32, 0x60);

// --- §3: what must never be made faster
routine("delayloop", "a loop that writes nothing and only counts");
{ emit(0xa2, 0x20); const head = here(); emit(0xca); const br = here(); emit(0xd0, rel(head, br)); emit(0x60); }
routine("rasterwait", "a stable-raster wait, and a store that would be redundant anywhere else");
{
  const head = here();
  emit(0xad, 0x12, 0xd0, 0xc9, 0x30);                // lda $D012 / cmp #$30
  const br = here();
  emit(0xd0, rel(head, br));
  emit(0x85, 0x15, 0xa5, 0x15);                      // sta $15 / lda $15  ← a redundant-load shape
  emit(0x8d, 0x20, 0xd0, 0x60);
}
routine("gcrloop", "the 1541's byte-ready handshake");
{
  const br = here();
  emit(0x50, rel(br, br));                           // bvc *
  emit(0xb8, 0xad, 0x01, 0x1c);                      // clv / lda $1C01
  emit(0x85, 0x16, 0xa5, 0x16);                      // sta $16 / lda $16  ← a redundant-load shape
  emit(0x60);
}

// --- the callees and the hops, at fixed addresses
at(0xc200, "plain", "a plain subroutine");
emit(0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60);
at(0xc220, "stacky", "a subroutine that reads its own return address");
emit(0xba, 0xbd, 0x00, 0x01, 0x60);
at(0xc240, "hop", "a jmp that only forwards");
emit(0x4c, 0x50, 0xc2);
at(0xc250, "final", "where the hop goes");
emit(0xa9, 0x01, 0x60);
close();

const hex4 = (a) => a.toString(16).toUpperCase().padStart(4, "0");

// ---------------------------------------------------------------- the harness

const proj = mkdtempSync(join(tmpdir(), "c64re-862r-"));
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
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
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 120000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

/** Every candidate line, as { at, rule, unit }. */
const candidatesIn = (report) => {
  const body = report.split("\ncandidates (")[1] ?? "";
  const stop = body.indexOf("\nthe rules, counted");
  const text = stop >= 0 ? body.slice(0, stop) : body;
  return [...text.matchAll(/^ {2}\$([0-9A-F]{4}) {2}([a-z-]+) {2}\[(\w+)\] {2}in (\S+)/gmu)]
    .map((m) => ({ at: parseInt(m[1], 16), rule: m[2], class: m[3], unit: m[4] }));
};
/** The whole block of a candidate, for reading its verdict and deltas. */
const candidateBlock = (report, rule, unit) => {
  const lines = report.split("\n");
  const head = lines.findIndex((l) => new RegExp(`^ {2}\\$[0-9A-F]{4} {2}${rule} {2}\\[\\w+\\] {2}in ${unit}\\b`).test(l));
  if (head < 0) return "";
  const out = [lines[head]];
  for (const l of lines.slice(head + 1)) {
    if (/^ {2}\$[0-9A-F]{4} {2}/.test(l) || /^\S/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
};
const counterLine = (report, rule) =>
  report.split("\n").find((l) => l.trim().startsWith(`${rule} `) && l.includes("matched")) ?? "";
const exclusionFor = (report, unit) =>
  report.split("\n\n").join("\n").split("\n").filter((l, i, all) => l.includes(`in ${unit}`) && all[i].startsWith("  [")) ;

/**
 * A hash over every file in the project, so §7.5 can be a fact.
 *
 * SQLite's own `-wal` and `-shm` sidecars are left out and checked separately:
 * opening a WAL database CREATES them, read-only or not, so their appearance
 * says nothing about whether anything was written. What does say it is the
 * database file itself, hashed like every other file, and the size of the
 * write-ahead log, asserted below to be empty.
 */
const SQLITE_SIDECAR = /-(wal|shm)$/u;

function fileMap(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!SQLITE_SIDECAR.test(name)) out.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

function hashTree(dir) {
  const h = createHash("sha256");
  for (const [name, digest] of [...fileMap(dir).entries()].sort()) h.update(`F ${name} ${digest}\n`);
  return h.digest("hex");
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-862-rules", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = new Set(((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name));
  check(tools.has("optimisation_candidates"), "optimisation_candidates is on the default surface — a tool not in DEFAULT_TOOLS is hidden");

  await call("project_init", { name: "opt862" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});

  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const prg = join(proj, "artifacts", "prg", "rules.prg");
  writeFileSync(prg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...B]));
  writeFileSync(join(proj, "artifacts", "prg", "rules_annotations.json"), JSON.stringify({
    routines: ROUTINES.map((r) => ({ address: hex4(r.start), name: r.name, comment: r.comment })),
    segments: [{ start: hex4(LOAD), end: hex4(LOAD + B.length - 1), kind: "code" }],
  }, null, 2));

  await call("analyze_prg", { prg_path: "artifacts/prg/rules.prg", entry_points: ROUTINES.map((r) => hex4(r.start)) });
  const disasm = await call("disasm_prg", { prg_path: "artifacts/prg/rules.prg", analysis_json: "artifacts/prg/rules_analysis.json" });
  check(
    new RegExp(`Graph: imported ${ROUTINES.length} routines`).test(disasm),
    `the ${ROUTINES.length} routines are in the graph's human layer`,
    disasm.split("\n").find((l) => l.startsWith("Graph:")),
  );

  // ---- the rule table is a table ----------------------------------------
  {
    const table = await call("optimisation_candidates", { show_rules: true });
    const ids = ["tail-call", "redundant-load", "jump-to-next", "jump-threading", "known-carry",
      "known-register", "page-align", "zp-promote", "count-down", "lax-load", "rmw-alu-fuse"];
    const missing = ids.filter((id) => !table.includes(`  ${id}  [`));
    check(missing.length === 0, "§4 every rule is a row with its pattern, preconditions, rewrite and saving", missing.join(",") || "all 11");
    check(/preconditions:/.test(table) && /rewrite:/.test(table) && /saves:/.test(table), "…and the row carries all four columns");
  }

  // ---- zp-promote's negative: no free zero page is recorded yet ---------
  {
    const r = await call("optimisation_candidates", { prg_path: "artifacts/prg/rules.prg", ref: "zpvar" });
    check(
      candidatesIn(r).filter((c) => c.rule === "zp-promote").length === 0,
      "zp-promote proposes nothing while no zero page is established free",
    );
    check(
      /no zero page is established FREE in this project/.test(r),
      "…and says the free-RAM slot is what would say where it may go",
      counterLine(r, "zp-promote").trim(),
    );
  }

  // The project's own door for that answer: a finding on the slot.
  await call("save_finding", {
    kind: "observation", title: "$FB-$FE are free in this build",
    summary: "four zero-page bytes nothing in the title touches; a run confirmed it",
    address_range: { start: 0xfb, end: 0xfe },
    tags: ["slot:S11", "method:run"],
    evidence: [{ kind: "note", title: "a run with the range poisoned changed nothing" }],
  });

  // ---- §7.5, first half: what the project looks like before the scans ---
  const before = hashTree(proj);
  const beforeMap = fileMap(proj);

  // ---- the whole scan, undocumented off ---------------------------------
  const report = await call("optimisation_candidates", { prg_path: "artifacts/prg/rules.prg", limit: 100 });
  const found = candidatesIn(report);
  const has = (rule, unit) => found.some((c) => c.rule === rule && c.unit === unit);
  const none = (unit) => found.filter((c) => c.unit === unit).length === 0;

  // ---- §7.1 positive + negative, rule by rule ---------------------------
  {
    const block = candidateBlock(report, "tail-call", "tailcall");
    check(has("tail-call", "tailcall"), "tail-call: the positive yields a candidate", block.split("\n")[0]);
    check(/verdict: EQUIVALENT/.test(block), "…with the verdict EQUIVALENT");
    check(/Δ bytes -1 {3}Δ cycles -9/.test(block), "…and the exact Δ: a byte, and 9 cycles (jsr 6 + rts 6 against jmp 3)", block.split("\n")[1]?.trim());
    check(none("tailneg"), "tail-call: the negative yields none — the callee reads its own return address");
    check(/tsx.*at \$C220/.test(counterLine(report, "tail-call") + report), "…and the drop names the `tsx` it found", counterLine(report, "tail-call").trim());
  }
  {
    const block = candidateBlock(report, "redundant-load", "redundant");
    check(has("redundant-load", "redundant"), "redundant-load: the positive yields a candidate");
    check(/verdict: EQUIVALENT/.test(block), "…EQUIVALENT, because N and Z already follow A");
    check(/N and Z already follow A/.test(block), "…and the fact it rests on is named", block.split("\n").find((l) => l.includes("follow")) ?? "(no line mentions it)");
    check(/Δ bytes -2 {3}Δ cycles -3/.test(block), "…and the exact Δ: 2 bytes, 3 cycles");
    check(none("redundantneg"), "redundant-load: the negative yields none — the flags are live and differ");
    check(/dropped at \$[0-9A-F]+: NOT EQUIVALENT/.test(counterLine(report, "redundant-load") + "\n" + report), "…and it is counted as dropped, NOT EQUIVALENT");
  }
  {
    const block = candidateBlock(report, "jump-to-next", "jumpnext");
    check(has("jump-to-next", "jumpnext"), "jump-to-next: the positive yields a candidate");
    check(/Δ bytes -3 {3}Δ cycles -3/.test(block), "…3 bytes and 3 cycles, exactly");
    check(none("jumpsomewhere"), "jump-to-next: a jump that goes somewhere else yields none");
  }
  {
    const block = candidateBlock(report, "jump-threading", "threadjmp");
    check(has("jump-threading", "threadjmp"), "jump-threading: a jmp to a jmp yields a candidate");
    check(/JMP \$c250/.test(block), "…retargeted to the final address", block.split("\n").find((l) => l.includes("candidate:")) ?? "");
    check(has("jump-threading", "threadbr"), "jump-threading: a branch to a jmp does too, when the displacement fits");
    check(none("threadfar"), "jump-threading: the negative yields none — the final target is out of branch range");
    check(/out of reach of a branch/.test(report), "…and the reason is the displacement, named", counterLine(report, "jump-threading").trim());
  }
  {
    const dup = candidateBlock(report, "known-carry", "carrydup");
    check(has("known-carry", "carrydup"), "known-carry: a second `clc` yields a candidate");
    check(/C is already 0/.test(dup), "…naming the fact the verdict holds under");
    check(/it rests on:.*C = 0/.test(dup), "…and carrying it into the assumptions");
    const edge = candidateBlock(report, "known-carry", "carryedge");
    check(has("known-carry", "carryedge"), "known-carry: a `sec` on the fall-through of a `bcc` does too");
    check(/fall-through of the `bcc`/.test(edge), "…because the branch edge says the carry is set", edge.split("\n").find((l) => l.includes("holds because")) ?? "");
    check(none("carrymoved"), "known-carry: the negative yields none — the `adc` between writes the carry");
  }
  {
    const block = candidateBlock(report, "known-register", "knownreg");
    check(has("known-register", "knownreg"), "known-register: a reload of a value already there yields a candidate");
    check(/A already holds \$05/.test(block), "…naming the fact");
    check(/Δ bytes -2 {3}Δ cycles -2/.test(block), "…2 bytes and 2 cycles");
    check(none("knownregneg"), "known-register: the negative yields none — the flags it sets are read by the branch after it");
  }
  {
    const block = candidateBlock(report, "count-down", "countdown");
    check(has("count-down", "countdown"), "count-down: a loop whose index nothing reads yields a candidate");
    check(/verdict: MEASURED/.test(block), "…as a measurement, which is what the class says it is");
    check(/Δ bytes -2 {3}Δ cycles -2/.test(block), "…the compare's own 2 bytes and 2 cycles");
    check(/80 cycle\(s\)/.test(block), "…and 40 iterations of it is the gain", block.split("\n")[1]?.trim());
    check(/the `ldx #\$00` before the loop becomes `ldx #\$27`/.test(block), "…with the initialiser it also has to change");
    check(none("countdownneg"), "count-down: the negative yields none — the body reads the index");
    check(/the body reads X/.test(report), "…and says so");
  }
  {
    const block = candidateBlock(report, "page-align", "pagealign");
    check(has("page-align", "pagealign"), "page-align: a table read across a page yields a candidate");
    check(/24 of the 40 iterations cross/.test(block), "…counted from the loop's own bound, not estimated", block.split("\n").find((l) => l.includes("iterations cross")) ?? "");
    check(none("pagealignneg"), "page-align: a table that starts on a page yields none");
  }
  {
    const block = candidateBlock(report, "zp-promote", "zpvar");
    check(has("zp-promote", "zpvar"), "zp-promote: with the free-RAM slot answered, the candidate appears");
    check(/\$FB is free/.test(block), "…naming the destination and where that came from");
    check(/confirmed by running/.test(block), "…and that a run confirmed it, not a listing");
    check(/2 access\(es\) to \$2000/.test(block), "…with every access that has to move");
    check(none("zpvarneg"), "zp-promote: a cell touched once yields none");
  }

  // ---- §7.2 timing code -------------------------------------------------
  {
    check(none("delayloop"), "§7.2 the delay loop yields no candidate");
    check(none("rasterwait"), "§7.2 the stable-raster routine yields none, though it holds a store/load pair that would otherwise be one");
    check(none("gcrloop"), "§7.2 the drive's byte-ready loop yields none, though it holds one too");
    check(/\[delay-loop\].*in delayloop/su.test(report) || /\[delay-loop\]/.test(report), "…the delay loop is in the exclusion list");
    const ex = report.split("left alone, and why")[1]?.split("\ncandidates (")[0] ?? "";
    check(/\[delay-loop\]/.test(ex) && /only counts/.test(ex), "…with the reason: it writes nothing and only counts");
    check(/\[raster-timed\]/.test(ex) && /waits for the raster/.test(ex), "…the raster wait is there with its own reason");
    check(/\[drive-code\]/.test(ex) && /(byte-ready|1541's VIA)/.test(ex), "…and the drive loop with its own");
    check(/not proposed at \$[0-9A-F]+:/.test(report), "…and a rule that fired inside an excluded span is counted, not silently skipped");
  }

  // ---- §7.6 undocumented opcodes are opt-in -----------------------------
  {
    check(!found.some((c) => c.rule === "lax-load" || c.rule === "rmw-alu-fuse"), "§7.6 off: no LAX and no DCP candidate");
    check(!/lax-load/.test(report), "…the class is not even counted when it is off");
    const on = await call("optimisation_candidates", {
      prg_path: "artifacts/prg/rules.prg", classes: ["local", "dataflow", "structural", "undocumented"], limit: 100,
    });
    const undoc = candidatesIn(on);
    check(undoc.some((c) => c.rule === "lax-load" && c.unit === "laxpair"), "§7.6 on: the LAX candidate appears");
    check(/LAX \$30/.test(candidateBlock(on, "lax-load", "laxpair")), "…as the opcode it rewrites into");
    check(/verdict: EQUIVALENT/.test(candidateBlock(on, "lax-load", "laxpair")), "…with the same verdict every other rule gets");
    check(undoc.some((c) => c.rule === "rmw-alu-fuse" && c.unit === "fusepair"), "§7.6 on: so does the DCP candidate");
    check(/DCP \$31/.test(candidateBlock(on, "rmw-alu-fuse", "fusepair")), "…rewriting `dec $31 / cmp $31` into one opcode");
    check(undoc.filter((c) => c.unit === "laxio").length === 0, "…and the negative yields none: two reads of $D012 are two reads on purpose");
    check(undoc.filter((c) => c.unit === "fuseneg").length === 0, "…nor does a read-modify-write and a compare on two different cells");
  }

  // ---- §7.5 nothing is applied ------------------------------------------
  {
    const after = hashTree(proj);
    if (before !== after) {
      const a = fileMap(proj);
      for (const [k, v] of a) if (beforeMap.get(k) !== v) console.log(`      CHANGED ${k}${beforeMap.has(k) ? "" : " (new)"}`);
      for (const k of beforeMap.keys()) if (!a.has(k)) console.log(`      GONE ${k}`);
    }
    check(before === after, "§7.5 nothing is applied: every file in the project is what it was before the scan", `${before.slice(0, 12)} → ${after.slice(0, 12)}`);
    const prgNow = readFileSync(prg);
    check(prgNow.equals(Buffer.from([LOAD & 0xff, LOAD >> 8, ...B])), "…the PRG in particular is untouched");
    const wal = join(proj, "knowledge", "graph.sqlite-wal");
    const walSize = existsSync(wal) ? statSync(wal).size : 0;
    check(walSize === 0, "…and the graph's write-ahead log is empty: the scan opened the database, it did not write to it", `${walSize} bytes`);
  }

  // ---- the counters are the point ---------------------------------------
  {
    check(/matched .* proposed .* dropped NOT EQUIVALENT .* not formed .* UNKNOWN/.test(report), "§6 every rule carries its own counters", counterLine(report, "tail-call").trim());
    check(/ranked by what each change saves once/.test(report), "§2 without a trace the report says it has no frequency to go on");
    check(
      /impact: \d+ reach it directly, \d+ depend on it, \d+ UNKNOWN, \d+ claim\(s\) would need re-reading/.test(report),
      "§5 every candidate carries the impact walk's summary",
      report.split("\n").find((l) => l.includes("impact:"))?.trim() ?? "(no candidate carries one)",
    );
    check(
      /impact: [1-9]\d* reach it directly/.test(report),
      "…and it is a real walk: the tail call's own routine is reached by the caller the graph knows",
      report.split("\n").filter((l) => l.includes("impact:")).slice(0, 3).map((l) => l.trim()).join(" | "),
    );
    check(/nothing here is applied/.test(report), "…and that nothing was applied");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-862-rules: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
