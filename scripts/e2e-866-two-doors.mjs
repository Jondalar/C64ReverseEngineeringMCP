#!/usr/bin/env node
// Two doors, not four: the load address decides.
//
// Four doors answered two questions. `disasm_prg` and `disasm_raw` ran the same
// decoder, renderer, annotations and rebuild proof and differed only in whether two
// bytes at the front are a load address; `analyze_prg` took a PRG and nothing else, so
// headerless bytes could not be classified at all. A run over four G64 sides needed
// segment annotations on 1541 drive code, so it built FAKE 2-byte load headers, wrote
// `.prg` copies and routed them through the PRG door — the exact workaround the raw
// door exists to end, one door over.
//
// What the two doors must do:
//
//   1 the same bytes both ways — a PRG with no load_address, and its headerless body
//     with load_address set to the header's value, are the same listing
//   2 a header and a load_address that disagree are REFUSED, naming both
//   3 every answer states the reading it took and where the address came from
//   4 the nine analysers run on raw bytes, and the renderer applies their segments —
//     the 1541 case end to end, with no .prg written anywhere
//   5 a named analysis is never swapped; a missing one is looked up in the project
//     store and the answer names what it found and why
//   6 the old names work and say so, once, naming their successor
//   7 nothing is invented: the input bytes are unchanged and no .prg stands in for
//     headerless bytes
//
// Hermetic: temp projects, synthetic 6502, no ROMs, no media, no daemon, no network.
// The reassembly half needs KickAssembler and skips loudly without it, like e2e:830.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:866

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };
const head = (n, title) => console.log(`\n── §8.${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_ASSEMBLER = existsSync(KICKASS);

console.log("Spec 866 — two doors, not four: the load address decides\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-866-"));
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
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

/**
 * A SECOND server process over the same project. Spec 877 D4's "once" is bounded by the
 * session, and this server outlives the session: the answer that matters is the one a
 * different process gives the next session, which a single-process gate cannot see.
 */
async function session(clientName) {
  const p = spawn(process.execPath, [cli], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let b = "";
  const waiting = new Map();
  let id2 = 1;
  p.stdout.on("data", (d) => {
    b += d.toString();
    let nl;
    while ((nl = b.indexOf("\n")) >= 0) {
      const ln = b.slice(0, nl).trim();
      b = b.slice(nl + 1);
      if (!ln) continue;
      let m;
      try { m = JSON.parse(ln); } catch { continue; }
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  p.stderr.on("data", () => {});
  const rpc2 = (method, params) => new Promise((res, rej) => {
    const id = id2++;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error(`timeout ${method}`)); }, 180000);
    waiting.set(id, (m) => { clearTimeout(t); res(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    async call(name, args) {
      const r = await rpc2("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
      return (r.result?.content || []).map((c) => c.text).join("\n");
    },
    close() { try { p.kill(); } catch { /* already gone */ } },
  };
}

/** The listing's body: everything after the `.pc =` line, trimmed, blanks dropped. */
const body = (asm) => {
  const lines = asm.split("\n");
  const at = lines.findIndex((l) => /^\s+\.pc = /.test(l));
  return lines.slice(at + 1).map((l) => l.trim()).filter(Boolean);
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const findFiles = (dir, re, prefix = "") => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...findFiles(join(dir, entry.name), re, rel));
    else if (re.test(entry.name)) out.push(rel);
  }
  return out;
};
const outputOf = (answer) => /^Output: (.+)$/m.exec(answer)?.[1];
const firstLine = (answer) => answer.split("\n").find((l) => l.trim() !== "") ?? "";

// Border, a page copy, a KERNAL call, return — a small real routine at $C000.
const KNOWN_CODE = [
  0xa9, 0x00,             // C000 lda #$00
  0x8d, 0x20, 0xd0,       // C002 sta $D020
  0xa2, 0x00,             // C005 ldx #$00
  0xbd, 0x00, 0xc1,       // C007 lda $C100,x
  0x9d, 0x00, 0x04,       // C00A sta $0400,x
  0xe8,                   // C00D inx
  0xd0, 0xf7,             // C00E bne $C007
  0x20, 0xd2, 0xff,       // C010 jsr $FFD2
  0x60,                   // C013 rts
];

// 1541 side: read VIA1, mask, write it back, bump the buffer pointer, return —
// then a table of bytes that is NOT code and must not be decoded as any.
const DRIVE_CODE = [
  0xad, 0x00, 0x18,       // 0300 lda $1800
  0x29, 0x01,             // 0303 and #$01
  0x8d, 0x00, 0x18,       // 0305 sta $1800
  0xa5, 0x30,             // 0308 lda $30
  0xe6, 0x30,             // 030A inc $30
  0x60,                   // 030C rts
];
const DRIVE_TABLE = [0x11, 0x00, 0x11, 0x01, 0x12, 0x00, 0x12, 0x01, 0x13, 0x00, 0x13, 0x01];

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-866", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "spec866" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});

  mkdirSync(join(proj, "artifacts", "blocks"), { recursive: true });
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });

  const bodyBytes = Buffer.alloc(0x40, 0xea);
  Buffer.from(KNOWN_CODE).copy(bodyBytes, 0);
  const twinPrg = join(proj, "artifacts", "prg", "twin.prg");
  const twinBin = join(proj, "artifacts", "blocks", "twin.bin");
  writeFileSync(twinPrg, Buffer.concat([Buffer.from([0x00, 0xc0]), bodyBytes]));
  writeFileSync(twinBin, bodyBytes);
  const twinBinHashBefore = sha(twinBin);
  const twinPrgHashBefore = sha(twinPrg);

  // ── §8.1 the same bytes, both ways ────────────────────────────────────────
  head(1, "the same bytes, read both ways, are the same listing");
  const headed = await call("disasm", { path: "artifacts/prg/twin.prg" });
  const raw = await call("disasm", { path: "artifacts/blocks/twin.bin", load_address: "C000" });
  const headedAsm = readFileSync(outputOf(headed), "utf8");
  const rawAsm = readFileSync(outputOf(raw), "utf8");
  check(/\.pc = \$C000/.test(headedAsm), "the headed reading starts at the header's address", /\s+\.pc = .*/.exec(headedAsm)?.[0]?.trim());
  check(/\.pc = \$C000/.test(rawAsm), "…and the raw reading starts at the address it was given", /\s+\.pc = .*/.exec(rawAsm)?.[0]?.trim());
  {
    const left = body(headedAsm), right = body(rawAsm);
    const firstDiff = left.findIndex((l, i) => l !== right[i]);
    check(left.length === right.length && firstDiff === -1,
      "the same instructions at the same addresses — line for line, one renderer",
      firstDiff === -1 ? `${left.length} lines` : `line ${firstDiff}: ${left[firstDiff]} vs ${right[firstDiff]}`);
  }
  check(!/\.word \$C000/.test(rawAsm) && !body(rawAsm)[1]?.startsWith(".byte"),
    "…and no load-address word was invented for the headerless half");

  // ── §8.2 a disagreement is refused ────────────────────────────────────────
  head(2, "a header and a load_address that disagree are refused, naming both");
  {
    const basicPrg = join(proj, "artifacts", "prg", "basic.prg");
    writeFileSync(basicPrg, Buffer.concat([Buffer.from([0x01, 0x08]), bodyBytes]));
    const clash = await call("disasm", { path: "artifacts/prg/basic.prg", headed: true, load_address: "C000" });
    check(/# disasm refused/.test(clash), "it is a refusal, not a silent choice", firstLine(clash));
    check(/\$0801/.test(clash) && /\$C000/.test(clash),
      "…and it names BOTH: the header and what the caller said",
      clash.split("\n").filter(Boolean)[1]?.slice(0, 140));
    check(/headed: false/.test(clash) && /leave load_address out/.test(clash),
      "…and names the two ways to pick one");

    // The store's own record says PRG, so the two bytes at the front are a header by
    // record and not by guess — the same clash, with nothing declared by the caller.
    await call("analyze", { path: "artifacts/prg/basic.prg" });
    const recorded = await call("disasm", { path: "artifacts/prg/basic.prg", load_address: "C000" });
    check(/# disasm refused/.test(recorded) && /registered as a PRG/.test(recorded),
      "a file the project store recorded as a PRG clashes too, with nothing declared",
      recorded.split("\n").filter(Boolean)[1]?.slice(0, 120));

    // Agreeing is not a clash: the header is CONFIRMED and the body is what renders.
    const agree = await call("disasm", { path: "artifacts/prg/twin.prg", headed: true, load_address: "C000" });
    check(!/refused/.test(agree) && /which is the load_address you passed/.test(agree),
      "a load_address that AGREES with the header is confirmation, not a clash",
      firstLine(agree).slice(0, 130));

    // And the extension decides nothing, in either direction: a .bin read as headed.
    // In the PRG directory, under a .bin name: neither the extension nor the folder
    // decides. It lives here so artifacts/blocks/ holds only headerless work and
    // §8.7's "no .prg beside the headerless bytes" can be checked exactly.
    const binHeaded = join(proj, "artifacts", "prg", "s.bin");
    writeFileSync(binHeaded, Buffer.concat([Buffer.from([0x5f, 0x0a]), bodyBytes]));
    const asHeaded = await call("disasm", { path: "artifacts/prg/s.bin" });
    check(/read as headed/.test(asHeaded) && /\$0A5F/.test(asHeaded),
      "a .bin with no load_address is read as headed — the name is a hint, never the decider",
      firstLine(asHeaded).slice(0, 130));
    const prgAsRaw = await call("disasm", { path: "artifacts/prg/basic.prg", headed: false, load_address: "C000" });
    check(!/refused/.test(prgAsRaw) && /read as raw bytes starting there/.test(prgAsRaw),
      "…and a .prg is read as raw bytes when the caller says so",
      firstLine(prgAsRaw).slice(0, 130));
  }

  // ── §8.3 the reading is stated ────────────────────────────────────────────
  head(3, "every answer says which rule it took and where the address came from");
  {
    check(/^Reading: no load_address given and twin\.prg read as headed — the first two bytes are \$C000/.test(headed),
      "the headed answer opens with the reading, the file and the header word",
      firstLine(headed).slice(0, 130));
    check(/if that is wrong, pass load_address/.test(headed),
      "…and says what to do when the reading is wrong");
    check(/^Reading: load_address \$C000 given — twin\.bin is read as raw bytes starting there/.test(raw),
      "the raw answer opens with the address it was given",
      firstLine(raw).slice(0, 130));
    check(/name decides nothing/.test(raw), "…and says the file name decided nothing");
    const analysed = await call("analyze", { path: "artifacts/blocks/twin.bin", load_address: "C000" });
    check(/^Reading: load_address \$C000 given/.test(analysed),
      "the analysis door states its reading the same way", firstLine(analysed).slice(0, 110));
  }

  // ── §8.4 the analysers run on raw bytes ───────────────────────────────────
  head(4, "the nine analysers run on headerless bytes — the 1541 case, end to end");
  const drivePath = join(proj, "artifacts", "blocks", "drive.bin");
  writeFileSync(drivePath, Buffer.from([...DRIVE_CODE, ...DRIVE_TABLE]));
  const driveHashBefore = sha(drivePath);
  {
    const analysed = await call("analyze", {
      path: "artifacts/blocks/drive.bin", load_address: "$0300",
    });
    const analysisPath = outputOf(analysed);
    check(!!analysisPath && existsSync(analysisPath),
      "an analysis of a headerless block of drive code was written", analysisPath ?? firstLine(analysed));
    const report = JSON.parse(readFileSync(analysisPath, "utf8"));
    check(report.mapping?.startAddress === 0x0300 && report.mapping?.endAddress === 0x0300 + DRIVE_CODE.length + DRIVE_TABLE.length - 1,
      "…over exactly the span the bytes run at, so a render of them can use it",
      `$${(report.mapping?.startAddress ?? 0).toString(16)}-$${(report.mapping?.endAddress ?? 0).toString(16)}`);
    check((report.segments ?? []).length > 0, "…and it has segments", `${(report.segments ?? []).length} segments`);
    check((report.codeAnalysis?.instructions ?? []).some((i) => (i.address & 0xffff) === 0x0300),
      "…with the code at $0300 discovered as code");

    // And the renderer applies them — found through the project store, not through a
    // path guessed beside the bytes: the analysis is in analysis/raw-analysis/.
    const rendered = await call("disasm", {
      path: "artifacts/blocks/drive.bin", load_address: "$0300", platform: "c1541",
    });
    check(/^Analysis: drive_0300_analysis\.json — the project store has it registered for these bytes/m.test(rendered),
      "the render found the analysis by asking the store which one is about these bytes",
      rendered.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 130));
    const driveAsm = readFileSync(outputOf(rendered), "utf8");
    check(/\(analysis rendering\)/.test(rendered) || /Analysis: .*drive_0300_analysis\.json/.test(driveAsm),
      "…and rendered segment-aware, not linearly",
      rendered.split("\n").find((l) => /rendering\)/.test(l)));
    check(/VIA1_PRB/.test(driveAsm), "…on the drive's own symbol tables", driveAsm.split("\n").find((l) => /VIA1_PRB/.test(l))?.trim());
    const prgsNearby = [
      ...findFiles(join(proj, "artifacts", "blocks"), /\.prg$/i),
      ...findFiles(join(proj, "analysis", "raw-disasm"), /\.prg$/i),
      ...findFiles(join(proj, "analysis", "raw-analysis"), /\.prg$/i),
    ];
    check(prgsNearby.length === 0,
      "…and no .prg was written anywhere to stand in for the headerless bytes",
      prgsNearby.join(", ") || "none");
  }

  // ── §8.5 the analysis a render uses ───────────────────────────────────────
  head(5, "a named analysis is never swapped; a missing one is looked up in the store");
  {
    // Two analyses of one block, the second in a directory nothing would guess —
    // the shape extract_disk leaves behind when it writes into a hashed payload dir.
    const hashed = join(proj, "artifacts", "generated", "payloads", "abc123");
    mkdirSync(hashed, { recursive: true });
    const named = await call("analyze", {
      path: "artifacts/blocks/twin.bin", load_address: "C000",
      output_json: "artifacts/generated/payloads/abc123/twin_analysis.json",
    });
    check(existsSync(join(hashed, "twin_analysis.json")),
      "an analysis written into a hashed payload directory", outputOf(named));
    check(/Registered for: twin\.bin/.test(named),
      "…is registered FOR those bytes, whatever directory it sits in",
      named.split("\n").find((l) => l.startsWith("Registered for:")));

    const found = await call("disasm", {
      path: "artifacts/blocks/twin.bin", load_address: "C000",
      output_asm: "analysis/raw-disasm/twin_store.asm",
    });
    check(/^Analysis: twin_analysis\.json — the project store has it registered for these bytes/m.test(found),
      "a render with no analysis_json finds it through the store — no path beside the bytes exists",
      found.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 140));
    check(/abc123/.test(readFileSync(outputOf(found), "utf8")),
      "…and the listing's own header names the file in the hashed directory");

    // Named and present: used unchanged, never swapped — the rule BUG-055 settled.
    const second = await call("analyze", {
      path: "artifacts/blocks/twin.bin", load_address: "C000",
      output_json: "analysis/raw-analysis/twin_seeded_analysis.json",
      entry_points: ["C020"],
    });
    check(!!outputOf(second), "a second analysis of the same bytes exists", outputOf(second));
    const explicit = await call("disasm", {
      path: "artifacts/blocks/twin.bin", load_address: "C000",
      analysis_json: "artifacts/generated/payloads/abc123/twin_analysis.json",
      output_asm: "analysis/raw-disasm/twin_named.asm",
    });
    check(/^Analysis: twin_analysis\.json — you named it, and a named analysis is used unchanged\./m.test(explicit),
      "a named analysis that exists is the one rendered, never the newer one the store holds",
      explicit.split("\n").find((l) => l.startsWith("Analysis:")));
    check(!/twin_seeded_analysis\.json/.test(readFileSync(outputOf(explicit), "utf8")),
      "…and the listing header confirms it");

    // Named and ABSENT: looked up, and the answer says both — what was asked for and
    // what was used. This is the half that used to be a refusal, and it was refusing
    // correct calls: extract_disk's analysis is not beside the bytes.
    const absent = await call("disasm", {
      path: "artifacts/blocks/twin.bin", load_address: "C000",
      analysis_json: "analysis/raw-analysis/nope_analysis.json",
      output_asm: "analysis/raw-disasm/twin_absent.asm",
    });
    check(/does not exist, so the project store was asked/.test(absent),
      "a named analysis that is absent is looked up instead of refused",
      absent.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 150));
    check(/nope_analysis\.json/.test(absent) && /^Analysis: twin(_seeded)?_analysis\.json —/m.test(absent),
      "…and the answer names both the path asked for and the file it used instead",
      absent.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 90));

    // no_analysis still refuses one outright, and a window still refuses an analysis
    // that describes a different span.
    const linear = await call("disasm", {
      path: "artifacts/blocks/twin.bin", load_address: "C000", no_analysis: true,
      output_asm: "analysis/raw-disasm/twin_linear.asm",
    });
    check(/^Analysis: none — no_analysis was passed/m.test(linear),
      "no_analysis still refuses every analysis and says so",
      linear.split("\n").find((l) => l.startsWith("Analysis:")));
    const windowed = await call("disasm", {
      path: "artifacts/blocks/twin.bin", load_address: "C010", offset: "10", length: "10",
      analysis_json: "artifacts/generated/payloads/abc123/twin_analysis.json",
    });
    check(/refused/.test(windowed) && /describes \$C000-\$C03F/.test(windowed) && /this window runs at \$C010-\$C01F/.test(windowed),
      "an analysis of the whole block over a window of it is still refused, both spans named",
      windowed.split("\n").filter(Boolean)[1]?.slice(0, 130));
  }

  // ── §8.6 the old names work and say so ────────────────────────────────────
  head(6, "the old names render identically and each names its successor, once");
  // ORDER MATTERS HERE (Spec 877 D4): the note is once per SESSION, so the three
  // calls below must be the FIRST this script makes under each retired name. A new
  // section that reaches for disasm_prg / disasm_raw / analyze_prg earlier spends the
  // announcement and this block fails for a reason that has nothing to do with it —
  // and a new `agent_onboard` anywhere above re-arms it, which breaks it the other way.
  {
    const viaOld = await call("disasm_prg", { prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg.asm" });
    const oldBody = body(readFileSync(outputOf(viaOld), "utf8"));
    const newBody = body(headedAsm);
    const diff = oldBody.findIndex((l, i) => l !== newBody[i]);
    check(oldBody.length === newBody.length && diff === -1,
      "disasm_prg renders exactly what disasm renders — it IS the same body",
      diff === -1 ? `${oldBody.length} lines` : `line ${diff}: ${oldBody[diff]} vs ${newBody[diff]}`);
    check(/disasm_prg is now `disasm`/.test(viaOld) && /one release/.test(viaOld),
      "…and says so once, naming its successor",
      viaOld.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120));
    check((viaOld.match(/is now `disasm`/g) ?? []).length === 1, "…exactly once, not on every line");

    // Spec 877 D4 — ONCE PER SESSION, not once per answer. A session is told where a
    // retired name went the first time it uses it; after that the note is noise on
    // every listing, and noise is how the sentence stops being read.
    check(/last answer that will say so/.test(viaOld),
      "…and the answer says it is the only one that will say it");
    const twiceOld = await call("disasm_prg", {
      prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg_again.asm",
    });
    check(!/is now `disasm`/.test(twiceOld),
      "…once per SESSION: the second disasm_prg answer does not repeat it",
      twiceOld.split("\n").find((l) => l.startsWith("Note: ")) ?? "no Note line — correct");
    check(body(readFileSync(outputOf(twiceOld), "utf8")).length === oldBody.length,
      "…and the second answer still renders the same listing — the note went, nothing else did");

    const viaRawOld = await call("disasm_raw", {
      path: "artifacts/blocks/twin.bin", load_address: "C000", no_analysis: true,
      output_asm: "analysis/alias/twin_raw.asm",
    });
    check(/disasm_raw is now `disasm`/.test(viaRawOld) && /one release/.test(viaRawOld),
      "disasm_raw says the same, naming the same successor",
      viaRawOld.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120));
    check(/whether two bytes at the front are a load address/.test(viaRawOld),
      "…and says WHY the two became one");

    const viaAnalyzeOld = await call("analyze_prg", { prg_path: "artifacts/prg/twin.prg", output_json: "analysis/alias/twin_analysis.json" });
    check(/analyze_prg is now `analyze`/.test(viaAnalyzeOld) && /one release/.test(viaAnalyzeOld),
      "analyze_prg names `analyze`",
      viaAnalyzeOld.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120));
    check(/^Reading: no load_address given/m.test(viaAnalyzeOld),
      "…and still states its reading, like every other answer");
    // The measured consequence of NOT saying this: a run four days after 866 shipped
    // reached for analyze_prg / disasm_prg, those want a header, so it wrote
    // `struct.pack('<H', addr) + data` in front of every block it extracted — the
    // fake load headers 865 exists to abolish. The note names the OLD door as the one
    // that wanted a header, and says outright not to invent one.
    check(/analyze_prg took a PRG and nothing else/.test(viaAnalyzeOld),
      "…and names the OLD door as the one that took a PRG — not its successor",
      viaAnalyzeOld.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 200));
    for (const [name, answer] of [["analyze_prg", viaAnalyzeOld], ["disasm_prg", viaOld], ["disasm_raw", viaRawOld]]) {
      check(/never (?:invent|write|pack) a 2-byte (?:load )?header/i.test(answer),
        `${name}'s note says not to invent a load header to get bytes through`,
        answer.split("\n").find((l) => /2-byte/.test(l))?.slice(-130));
    }
    check(!/is now `disasm`/.test(await call("disasm", { path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_new.asm" })),
      "the new name carries no such note — a successor has nothing to point at");

    // "Once" is bounded by the SESSION, not by the process. This server outlives a
    // session and serves several projects at once: a globally configured one that has
    // already answered a disasm_prg hands the next session nothing, and the next
    // session is precisely the one that has not been told. `agent_onboard` is what
    // marks a session's start — the call every session makes first, and the one it
    // makes again after a compaction — so it re-arms the note, exactly as 849 D5
    // re-arms the project rules. Everything above this line runs inside ONE session
    // and cannot see that; this is the half that can.
    await call("agent_onboard", {});
    const afterOnboard = await call("disasm_prg", {
      prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg_session2.asm",
    });
    check(/disasm_prg is now `disasm`/.test(afterOnboard),
      "a new session is told again: agent_onboard re-arms the note",
      afterOnboard.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120) ?? "no Note line");
    const stillOnce = await call("disasm_prg", {
      prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg_session2b.asm",
    });
    check(!/is now `disasm`/.test(stillOnce),
      "…and once more means once in THAT session too",
      stillOnce.split("\n").find((l) => l.startsWith("Note: ")) ?? "no Note line — correct");
    const analyzeAfter = await call("analyze_prg", {
      prg_path: "artifacts/prg/twin.prg", output_json: "analysis/alias/twin_analysis_s2.json",
    });
    check(/analyze_prg is now `analyze`/.test(analyzeAfter),
      "…and every retired name is re-armed, not just the one that was called",
      analyzeAfter.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120) ?? "no Note line");

    // The ledger is a file for the same reason 849's is: process state cannot survive
    // the process, and the answer this gate is written about is the one a DIFFERENT
    // process gives. A second server over the same project, onboarding as any session
    // does, is told; and a third that does not onboard is not told twice.
    const second = await session("e2e-866-session2");
    try {
      await second.call("agent_onboard", {});
      const fresh = await second.call("disasm_prg", {
        prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg_proc2.asm",
      });
      check(/disasm_prg is now `disasm`/.test(fresh),
        "another process, same project: the session that onboards is told",
        fresh.split("\n").find((l) => l.startsWith("Note: "))?.slice(0, 120) ?? "no Note line");
      const again = await second.call("disasm_prg", {
        prg_path: "artifacts/prg/twin.prg", output_asm: "analysis/alias/twin_prg_proc2b.asm",
      });
      check(!/is now `disasm`/.test(again), "…and told once there as well",
        again.split("\n").find((l) => l.startsWith("Note: ")) ?? "no Note line — correct");
    } finally { second.close(); }
  }

  // ── §8.7 nothing is invented ──────────────────────────────────────────────
  head(7, "nothing is invented");
  {
    check(sha(twinBin) === twinBinHashBefore, "the headerless input's bytes are unchanged, hash before and after", twinBinHashBefore.slice(0, 16));
    check(sha(twinPrg) === twinPrgHashBefore, "…and so are the PRG's");
    check(sha(drivePath) === driveHashBefore, "…and the drive block's");
    const strays = [
      ...findFiles(join(proj, "artifacts", "blocks"), /\.prg$/i).map((p) => `artifacts/blocks/${p}`),
      ...findFiles(join(proj, "analysis", "raw-disasm"), /\.prg$/i).map((p) => `analysis/raw-disasm/${p}`),
      ...findFiles(join(proj, "analysis", "raw-analysis"), /\.prg$/i).map((p) => `analysis/raw-analysis/${p}`),
    ];
    check(strays.length === 0, "no .prg was written to stand in for headerless bytes", strays.join(", ") || "none");
  }

  // ── the rebuild proof, on both readings ───────────────────────────────────
  head("R", "both readings prove themselves the same way");
  if (!HAVE_ASSEMBLER) {
    skip("the headed reading rebuilds byte-identical", `KickAssembler not found at ${KICKASS} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
    skip("the raw reading rebuilds byte-identical against its window", "same");
  } else {
    check(/rebuild verified byte-identical against twin\.prg/.test(headed),
      "the headed reading rebuilds byte-identical against the whole PRG",
      headed.split("\n").find((l) => /rebuild/.test(l)));
    check(/rebuild verified byte-identical against twin\.bin bytes 0\.\.63/.test(raw),
      "the raw reading rebuilds byte-identical against the bytes it was rendered from",
      raw.split("\n").find((l) => /rebuild/.test(l)));
  }

  // ── the surface ───────────────────────────────────────────────────────────
  head("S", "two doors on the surface, and three old names beside them");
  {
    const tools = (await rpc("tools/list", {})).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["disasm", "analyze"]) {
      const tool = byName.get(name);
      check(!!tool, `${name} is on the default surface`);
      check(/\bUse [a-z]/i.test(tool?.description ?? ""), `…${name}'s description carries a Use-trigger`);
      check(/Not for|\(use [a-z_]+/i.test(tool?.description ?? ""), `…and points at the alternative`);
      check(!/\bSpec\s+\d/i.test(tool?.description ?? ""), `…and cites no spec number`);
      check(/load address decides/i.test(tool?.description ?? ""), `…and states the rule that decides the reading`);
    }
    for (const name of ["disasm_prg", "disasm_raw", "analyze_prg"]) {
      check(byName.has(name), `${name} is still reachable — one release`);
      check(/one release/i.test(byName.get(name)?.description ?? ""), `…and its description says so`);
    }
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-866-two-doors: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount ? 1 : 0);
