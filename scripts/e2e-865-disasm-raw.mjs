#!/usr/bin/env node
// Bytes at an address — the door two autonomous runs did not have.
//
// One of them wrote its own disassembler and called it 180 times. The other bolted a
// 2-byte load header onto .bin blocks, in its own words "so the MCP disassembler can
// eat them", and made 308 PRGs that were never PRGs. Both then held listings the
// project knew nothing about. `disasm_raw` is that door, and this is what it must do:
//
//   1 a headerless block disassembles, and no load-address word appears in the output
//   2 it round-trips, and a range that cannot is reported rather than claimed
//   3 a window of a bigger file yields the window, and the provenance names the range
//   4 an entry point seeds it, and without one the misaligned code is not there
//   5 the same annotations file yields the same names through disasm_prg and disasm_raw
//   6 drive code at $0300 renders and round-trips
//   7 nothing is invented: the input is untouched and no .prg is left behind
//   8 the project knows: the listing is registered with its provenance, and a second
//     identical run does not make a second artifact
//
// Hermetic: temp projects, synthetic bytes, no ROMs, no media, no runtime daemon, no
// network. The reassembly half needs KickAssembler and skips loudly without it, the
// way e2e:830 does.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:865

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const head = (n, title) => console.log(`\n── §6.${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_ASSEMBLER = existsSync(KICKASS);

console.log("Spec 865 — disassemble bytes at an address\n");

// ── the MCP harness ─────────────────────────────────────────────────────────
const proj = mkdtempSync(join(tmpdir(), "c64re-865-"));
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

/** The listing's body: everything after the `.pc =` line, trimmed, blanks dropped. */
const body = (asm) => {
  const lines = asm.split("\n");
  const at = lines.findIndex((l) => /^\s+\.pc = /.test(l));
  return lines.slice(at + 1).map((l) => l.trim()).filter(Boolean);
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Every file under `dir` matching `re`, relative to it. */
const findFiles = (dir, re, prefix = "") => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...findFiles(join(dir, entry.name), re, rel));
    else if (re.test(entry.name)) out.push(rel);
  }
  return out;
};

// A small, real routine: clear the border, copy a page to the screen, print, return.
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

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-865", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "spec865" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});

  mkdirSync(join(proj, "artifacts", "blocks"), { recursive: true });

  // ── §6.1 a headerless block disassembles ──────────────────────────────────
  head(1, "a headerless block disassembles");
  const blockPath = join(proj, "artifacts", "blocks", "block.bin");
  const blockBytes = Buffer.alloc(256, 0xea);
  Buffer.from(KNOWN_CODE).copy(blockBytes, 0);
  writeFileSync(blockPath, blockBytes);
  const blockHashBefore = sha(blockPath);

  const out1 = await call("disasm_raw", { path: "artifacts/blocks/block.bin", load_address: "C000" });
  const asm1Path = /^Output: (.+)$/m.exec(out1)?.[1];
  check(!!asm1Path && existsSync(asm1Path), "the listing was written", asm1Path ?? out1.split("\n")[0]);
  const asm1 = readFileSync(asm1Path, "utf8");
  const b1 = body(asm1);
  check(/\.pc = \$C000 "code"/.test(asm1), "the first instruction sits at $C000", /(\s+\.pc = .*)/.exec(asm1)?.[1]?.trim());
  check(b1[0] === "WC000:" && b1[1] === "lda  #$00", "the body starts with the block's first instruction", b1.slice(0, 2).join(" | "));
  for (const [want, what] of [
    ["sta  $D020", "the border write"],
    ["lda  $C100,x", "the indexed load"],
    ["bne  WC007", "the branch, to a label of its own"],
    ["jsr  $FFD2", "the KERNAL call"],
  ]) {
    check(b1.some((l) => l.startsWith(want)), `the listing holds ${what}`, want);
  }
  // No load-address word: nothing in the output emits the two header bytes, and the
  // renderer never saw any — the first thing after `.pc` is code, not data.
  const beforeFirstInstruction = b1.slice(0, b1.indexOf("lda  #$00"));
  check(
    beforeFirstInstruction.every((l) => !/^\.(byte|word)\b/.test(l)),
    "no load-address word is emitted anywhere before the code",
    beforeFirstInstruction.join(" | ") || "nothing before it",
  );
  check(!/\.word \$C000/.test(asm1) && !/\.byte \$00, \$C0/.test(asm1), "…and none appears later either");
  check(/Raw block — the bytes carry no PRG load header and none was invented\./.test(asm1),
    "the listing says what it is");
  check(/Seeded: \$C000 \(the first byte/.test(out1), "the answer names what was seeded", /Seeded: .*/.exec(out1)?.[0]);
  check(/Analysis: none/.test(asm1), "…and that it had no analysis", /\/\/  Analysis: .*/.exec(asm1)?.[0]?.trim());
  check(/\d+ instructions/.test(out1), "the answer names the instruction count", /Listing: .*/.exec(out1)?.[0]);

  // ── §6.2 it round-trips ───────────────────────────────────────────────────
  head(2, "it round-trips, and what cannot is reported");
  if (!HAVE_ASSEMBLER) {
    skip("the 256-byte block rebuilds byte-identical", `KickAssembler not found at ${KICKASS} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
    skip("a range that cannot round-trip is reported instead of claimed", "same");
  } else {
    check(/rebuild verified byte-identical against block\.bin bytes 0\.\.255 \(256 bytes\)/.test(out1),
      "the 256-byte block rebuilds byte-identical, compared header-free on both sides",
      out1.split("\n").find((l) => /rebuild/.test(l)));
    check(/rebuild verified byte-identical/.test(readFileSync(asm1Path, "utf8")),
      "…and the verdict is in the listing's own head, not only in the answer");

    // A range that genuinely cannot round-trip. NOT "data misread as code": the
    // renderer emits an unknown opcode as `.byte` and forces the exact operand width,
    // so arbitrary data comes back byte-for-byte — 256 bytes of pseudo-random data
    // rebuild identically, which is why §8.1 of the spec records that acceptance item
    // as written wrongly. What does break is a relative branch whose target wrapped
    // below $0000: the decoder wraps at 16 bits, the assembler refuses the distance.
    const wrapPath = join(proj, "artifacts", "blocks", "wrap.bin");
    writeFileSync(wrapPath, Buffer.from([0x10, 0x80, 0xea, 0xea, 0x60]));
    const outWrap = await call("disasm_raw", { path: "artifacts/blocks/wrap.bin", load_address: "0010" });
    check(!/rebuild verified byte-identical/.test(outWrap),
      "a range that cannot round-trip does not claim success",
      outWrap.split("\n").find((l) => /rebuild/.test(l)));
    check(/WARNING: rebuild/.test(outWrap) && /is not byte-identical/.test(outWrap),
      "…it is reported as such, and the listing is still produced",
      outWrap.split("\n").find((l) => /rebuild/.test(l)));
    check(/jump distance is too far/i.test(outWrap),
      "…and the verdict names the reason rather than an exit code alone",
      outWrap.split("\n").find((l) => /rebuild/.test(l)));
    const wrapAsm = /^Output: (.+)$/m.exec(outWrap)?.[1];
    check(!!wrapAsm && existsSync(wrapAsm), "the listing a caller asked for is still on disk", wrapAsm);
  }

  // ── §6.3 a window of a bigger file ────────────────────────────────────────
  head(3, "a window of a bigger file");
  const bigPath = join(proj, "artifacts", "blocks", "overlay.bin");
  const big = Buffer.alloc(16 * 1024, 0x00);
  Buffer.from(KNOWN_CODE).copy(big, 0x1000);
  writeFileSync(bigPath, big);
  const out3 = await call("disasm_raw", {
    path: "artifacts/blocks/overlay.bin", load_address: "$8000", offset: "1000", length: "14",
  });
  const asm3Path = /^Output: (.+)$/m.exec(out3)?.[1];
  const b3 = body(readFileSync(asm3Path, "utf8"));
  check(b3.filter((l) => /^(lda|sta|ldx|inx|bne|jsr|rts)/.test(l)).length === 9,
    "exactly the window's nine instructions, and nothing of the 16 KB around it",
    b3.filter((l) => /^(lda|sta|ldx|inx|bne|jsr|rts)/.test(l)).length.toString());
  check(b3[0] === "W8000:" && b3[1] === "lda  #$00", "the window's first byte runs at the address given", b3.slice(0, 2).join(" | "));
  check(/offset 4096 \(\$1000\), length 20 \(\$14\)/.test(out3),
    "the answer prints the window in both notations, because offsets are counted and addresses are not",
    /Provenance: .*/.exec(out3)?.[0]);
  check(/Bytes 4096\.\.4115 of overlay\.bin/.test(out3), "the provenance names the byte range");
  check(/1000-1013/.test(asm3Path), "…and the default output path carries it too", asm3Path);
  {
    // The rule, held against a caller who reads it the other way round.
    const refused = await call("disasm_raw", { path: "artifacts/blocks/overlay.bin", load_address: "8000", offset: "FFFFFF" });
    check(/disasm_raw refused/.test(refused) && /past the end of overlay\.bin/.test(refused),
      "an offset past the end is refused by name", refused.split("\n").filter(Boolean)[2]);
    check(/is HEX/.test(refused), "…and the refusal quotes the one address rule");
    const badSeed = await call("disasm_raw", { path: "artifacts/blocks/overlay.bin", load_address: "8000", offset: "1000", length: "14", entry_points: ["1000"] });
    check(/lie outside \$8000-\$8013/.test(badSeed),
      "an entry point outside the window is refused, and told it is a runtime address",
      badSeed.split("\n").filter(Boolean)[2]);
  }

  // ── §6.4 entry points seed it ─────────────────────────────────────────────
  head(4, "entry points seed it");
  // Three bytes of data whose decode swallows the code start: $A9 $00 is `lda #$00`,
  // then $AD eats the two bytes of the real first instruction.
  const seedPath = join(proj, "artifacts", "blocks", "seeded.bin");
  writeFileSync(seedPath, Buffer.from([0xa9, 0x00, 0xad, 0xa9, 0x41, 0x8d, 0x20, 0xd0, 0x60]));
  const blind = await call("disasm_raw", { path: "artifacts/blocks/seeded.bin", load_address: "C000" });
  const blindBody = body(readFileSync(/^Output: (.+)$/m.exec(blind)[1], "utf8"));
  check(blindBody.some((l) => l.startsWith("lda  $41A9")) && !blindBody.some((l) => l.startsWith("lda  #$41")),
    "without a seed the misaligned decode swallows the code, and the tool does not pretend otherwise",
    blindBody.join(" | "));
  const seeded = await call("disasm_raw", {
    path: "artifacts/blocks/seeded.bin", load_address: "C000", entry_points: ["C003"],
    output_asm: "analysis/raw-disasm/seeded_at_c003.asm",
  });
  const seededBody = body(readFileSync(/^Output: (.+)$/m.exec(seeded)[1], "utf8"));
  check(seededBody.some((l) => l.startsWith("lda  #$41")) && seededBody.some((l) => l.startsWith("sta  $D020")),
    "with the entry point the code at +3 is there", seededBody.join(" | "));
  check(seededBody.some((l) => l === ".byte $AD"),
    "…and the byte the seed broke out of an instruction is data, so the bytes still add up",
    seededBody.join(" | "));
  check(/Seeded: \$C003/.test(seeded), "the answer says what seeded it", /Seeded: .*/.exec(seeded)?.[0]);
  if (HAVE_ASSEMBLER) {
    check(/rebuild verified byte-identical/.test(seeded), "a reseeded listing is still byte-exact",
      seeded.split("\n").find((l) => /rebuild/.test(l)));
  } else {
    skip("a reseeded listing is still byte-exact", "KickAssembler absent");
  }

  // ── §6.5 annotations apply ────────────────────────────────────────────────
  head(5, "the same annotations file, through both doors");
  const annotations = {
    labels: [{ address: "C007", label: "copy_loop", comment: "one page to the screen" }],
    routines: [{ address: "C000", name: "show_title", comment: "border, then the title line" }],
  };
  // The PRG door: the same bytes with a load header in front of them.
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const prgPath = join(proj, "artifacts", "prg", "twin.prg");
  writeFileSync(prgPath, Buffer.concat([Buffer.from([0x00, 0xc0]), blockBytes]));
  writeFileSync(join(proj, "artifacts", "prg", "twin_annotations.json"), JSON.stringify(annotations, null, 2));
  const viaPrg = await call("disasm_prg", { prg_path: "artifacts/prg/twin.prg" });
  const prgAsm = readFileSync(/^Output: (.+)$/m.exec(viaPrg)[1], "utf8");
  // The raw door: the same annotations file, named outright.
  const rawTwin = join(proj, "artifacts", "blocks", "twin.bin");
  writeFileSync(rawTwin, blockBytes);
  const viaRaw = await call("disasm_raw", {
    path: "artifacts/blocks/twin.bin", load_address: "C000",
    annotations_path: "artifacts/prg/twin_annotations.json",
  });
  const rawAsm = readFileSync(/^Output: (.+)$/m.exec(viaRaw)[1], "utf8");
  for (const [name, what] of [["show_title", "the routine name"], ["copy_loop", "the label"]]) {
    check(prgAsm.includes(name), `disasm_prg applies ${what}`);
    check(rawAsm.includes(name), `disasm_raw applies ${what} from the same file`);
  }
  {
    // Same names in the same places: compare the two bodies line for line.
    const left = body(prgAsm), right = body(rawAsm);
    const firstDiff = left.findIndex((l, i) => l !== right[i]);
    check(left.length === right.length && firstDiff === -1,
      "the two listings are the same listing — same labels, same comments, same order",
      firstDiff === -1 ? `${left.length} lines` : `line ${firstDiff}: ${left[firstDiff]} vs ${right[firstDiff]}`);
  }

  // ── §6.6 drive code ───────────────────────────────────────────────────────
  head(6, "drive code at $0300");
  // 1541 side: read the VIA1 port, set the data line, bump the buffer pointer, return.
  const drivePath = join(proj, "artifacts", "blocks", "drive.bin");
  writeFileSync(drivePath, Buffer.from([
    0xad, 0x00, 0x18,       // 0300 lda $1800
    0x29, 0x01,             // 0303 and #$01
    0x8d, 0x00, 0x18,       // 0305 sta $1800
    0xa5, 0x30,             // 0308 lda $30
    0xe6, 0x30,             // 030A inc $30
    0x60,                   // 030C rts
  ]));
  const outDrive = await call("disasm_raw", { path: "artifacts/blocks/drive.bin", load_address: "$0300", cpu: "drive" });
  const driveAsm = readFileSync(/^Output: (.+)$/m.exec(outDrive)[1], "utf8");
  check(body(driveAsm)[0] === "W0300:" && /lda  \$1800/.test(driveAsm), "the drive block renders at $0300", body(driveAsm).slice(0, 2).join(" | "));
  check(/on the 1541's 6502/.test(outDrive), "the provenance records which CPU these bytes run on", /Provenance: .*/.exec(outDrive)?.[0]);
  if (HAVE_ASSEMBLER) {
    check(/rebuild verified byte-identical against drive\.bin/.test(outDrive), "and it round-trips",
      outDrive.split("\n").find((l) => /rebuild/.test(l)));
  } else {
    skip("the drive block round-trips", "KickAssembler absent");
  }

  // ── §6.7 nothing is invented ──────────────────────────────────────────────
  head(7, "nothing is invented");
  check(sha(blockPath) === blockHashBefore, "the input file's bytes are unchanged, hash before and after", blockHashBefore.slice(0, 16));
  check(statSync(blockPath).size === 256, "…and so is its length — no header was prepended");
  {
    // Nowhere disasm_raw touched holds a .prg: not beside the bytes it read, not
    // beside the listings it wrote, not as a leftover rebuild check. (`artifacts/prg/`
    // is out of this: §6.5 put a real PRG there on purpose and ran disasm_prg on it,
    // whose own rebuild check is not this tool's doing.)
    const strays = [
      ...findFiles(join(proj, "artifacts", "blocks"), /\.prg$/i).map((p) => `artifacts/blocks/${p}`),
      ...findFiles(join(proj, "analysis", "raw-disasm"), /\.prg$/i).map((p) => `analysis/raw-disasm/${p}`),
    ];
    check(strays.length === 0,
      "disasm_raw wrote no .prg — not beside the bytes, not beside the listing",
      strays.join(", ") || "none");
  }

  // ── §6.8 the project knows ────────────────────────────────────────────────
  head(8, "the project knows");
  const artifactId = /^Artifact: (\S+)/m.exec(out1)?.[1];
  check(!!artifactId, "the listing is registered", artifactId ?? out1);
  const lineage = await call("get_artifact_lineage", { artifact_id: artifactId });
  check(/Lineage \(1 entries/.test(lineage), "…as one artifact", lineage.split("\n")[0]);
  const again = await call("disasm_raw", { path: "artifacts/blocks/block.bin", load_address: "C000" });
  check(/^Artifact: (\S+)/m.exec(again)?.[1] === artifactId,
    "a second identical run produces the same artifact, not a second copy",
    `${artifactId} → ${/^Artifact: (\S+)/m.exec(again)?.[1]}`);
  const lineageAgain = await call("get_artifact_lineage", { artifact_id: artifactId });
  check(/Lineage \(1 entries/.test(lineageAgain), "…and the lineage is still one entry", lineageAgain.split("\n")[0]);
  {
    const store = JSON.parse(readFileSync(join(proj, "knowledge", "artifacts.json"), "utf8"));
    const row = store.items.find((a) => a.id === artifactId);
    check(/Bytes 0\.\.255 of block\.bin/.test(row?.description ?? ""),
      "the provenance is readable back off the artifact — which file, which byte range, which address",
      row?.description ?? "no description");
    check(/running at \$C000-\$C0FF/.test(row?.description ?? ""), "…including the address the bytes run at");
  }
  {
    // A payload created by the disk door — the kind a listing used to be invisible to.
    const registered = await call("register_payload", {
      name: "title_block",
      load_address: 0xc000,
      source_prg_path: "artifacts/blocks/block.bin",
      format: "raw",
    });
    check(/payload/i.test(registered), "a payload over those bytes exists", registered.split("\n")[0]);
    const linked = await call("disasm_raw", { path: "artifacts/blocks/block.bin", load_address: "C000" });
    check(/^Payload: (linked to|already linked to) title_block/m.test(linked),
      "the listing links to it, whichever door created the payload",
      linked.split("\n").find((l) => l.startsWith("Payload:")) ?? "no payload line");
  }

  // ── the surface ───────────────────────────────────────────────────────────
  head("S", "the surface says when to reach for which");
  {
    const tools = (await rpc("tools/list", {})).result.tools;
    const raw = tools.find((t) => t.name === "disasm_raw");
    check(!!raw, "disasm_raw is on the default surface");
    check(/\bUse [a-z]/i.test(raw?.description ?? ""), "its description carries a Use-trigger");
    check(/use disasm_prg/i.test(raw?.description ?? "") && /use runtime_monitor_disasm/i.test(raw?.description ?? ""),
      "…and points at both alternatives: the PRG door and the live machine");
    check(!/\bSpec\s+\d/i.test(raw?.description ?? ""), "…and cites no spec number");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-865-disasm-raw: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount ? 1 : 0);
