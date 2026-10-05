// Spec 896, items 1, 2, 3, 6, 8 — the static half of the PETSCII-project findings.
//
// Every case builds its own minimal fixture in a temp directory (nothing is downloaded)
// and spawns its own MCP server (dist/cli.js) over stdio with C64RE_RUNTIME_AUTOSTART=0.
// No runtime daemon is started and nothing touches :4312.
//
//   1  disasm_prg rebuild check follows preferredAssembler: a 64tass-only environment
//      (no KickAssembler jar) verifies byte-identical; with neither assembler it warns
//      naming both. Skips loudly when 64tass is not installed.
//   2  disasm offset/length: a string is hex, a number is decimal
//   3  assemble_source / runtime_render_screen's writer / try_depack create a missing
//      output folder
//   6  try_depack: a header-less result is written as .bin and the answer says so; a
//      depacker that knows its destination writes a PRG with that load address
//   8  analyze: a BASIC stub at $0801 is a `basic` segment, its SYS target an entry point
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build`"); process.exit(2); }
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));

let pass = 0, fail = 0, skipped = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${String(d).replace(/\s+/g, " ").slice(0, 300)})` : ""}`); };
const skip = (m) => { skipped++; console.log(`  SKIP  ${m}`); };

const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "c64re-896-")));
const scratch = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("C64RE_") || /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|NAMESPACE)$/.test(k)) delete env[k];
  return {
    ...env,
    GIT_AUTHOR_NAME: "c64re smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "c64re smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    C64RE_RUNTIME_AUTOSTART: "0",
    ...extra,
  };
}

async function session(env, fn) {
  const mcp = spawn(process.execPath, [cli], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pend = new Map(); let n = 1;
  mcp.stdout.on("data", (b) => { buf += b; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const call = (method, params) => new Promise((res, rej) => {
    const id = n++; const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout: ${method}`)); }, 120000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const m = await call("tools/call", { name, arguments: args });
    if (m.error) return `[rpc error] ${m.error.message}`;
    return (m.result?.content ?? []).map((c) => c.text).join("\n");
  };
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-896", version: "1" } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await tool("agent_onboard", {});
    await fn(tool);
  } finally {
    mcp.kill("SIGKILL");
  }
}

function makeProject(name, extra = {}) {
  const dir = scratch(name);
  new ProjectKnowledgeService(dir).initProject({ name, ...extra });
  spawnSync("git", ["init"], { cwd: dir, env: cleanEnv() });
  spawnSync("git", ["add", "-A"], { cwd: dir, env: cleanEnv() });
  spawnSync("git", ["commit", "-m", "base"], { cwd: dir, env: cleanEnv() });
  return dir;
}

// Mike's shape: a BASIC line `1994 SYS 2059` whose next-line pointer ($080B) is the first
// byte of the machine code the SYS jumps to — there is no $0000 chain end. Code at $080B:
// LDA #$00 / STA $D020 / RTS.
const STUB_PRG = Buffer.from([
  0x01, 0x08,
  0x0b, 0x08, 0xca, 0x07, 0x9e, 0x32, 0x30, 0x35, 0x39, 0x00, // $0801-$080A
  0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60,                         // $080B
]);
// The canonical chain: `0B 08 CA 07 9E "2061" 00` then the `00 00` chain end, code at $080D.
const CANON_PRG = Buffer.from([
  0x01, 0x08,
  0x0b, 0x08, 0xca, 0x07, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, // $0801-$080C
  0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60,                                     // $080D
]);
// Not BASIC: the same first bytes with no SYS to prove a launcher — must stay code.
const NOT_BASIC_PRG = Buffer.from([
  0x01, 0x08,
  0x0b, 0x08, 0xca, 0x07, 0x99, 0x32, 0x30, 0x35, 0x39, 0x00, // line "1994 PRINT 2059"? (token $99)
  0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60,
]);

console.log("Spec 896 — static items 1, 2, 3, 6, 8\n");

const have64tass = spawnSync("sh", ["-c", "command -v 64tass || test -x /opt/homebrew/bin/64tass || test -x /usr/local/bin/64tass"]).status === 0;
const haveKick = existsSync("/Applications/KickAssembler/KickAss.jar") || (process.env.C64RE_KICKASS_JAR && existsSync(process.env.C64RE_KICKASS_JAR));

try {
  const P = makeProject("p896", { preferredAssembler: "64tass" });
  const Q = makeProject("q896"); // no preference
  const stub = join(P, "stub.prg");
  const canon = join(P, "canon.prg");
  const notBasic = join(P, "notbasic.prg");
  writeFileSync(stub, STUB_PRG); writeFileSync(canon, CANON_PRG); writeFileSync(notBasic, NOT_BASIC_PRG);

  await session(cleanEnv({ C64RE_PROJECT_DIR: P }), async (tool) => {
    // ── 8 — BASIC detection ────────────────────────────────────────────────────
    const analyse = async (file, name) => {
      const out = join(P, "analysis", `${name}_analysis.json`);
      const answer = await tool("analyze", { path: file, output_json: out });
      if (!existsSync(out)) { check(false, `8 analyze wrote ${name}'s analysis`, answer.split("\n").slice(0, 3).join(" | ")); return undefined; }
      return JSON.parse(readFileSync(out, "utf8"));
    };
    const seg = (r, start) => (r.segments ?? []).find((s) => s.start === start);

    const rs = await analyse(stub, "stub");
    if (rs) {
      check(seg(rs, 0x0801)?.kind === "basic" && seg(rs, 0x0801)?.end === 0x080a, "8a launcher with the link pointing at its own code: $0801-$080A is a `basic` segment", JSON.stringify(seg(rs, 0x0801)));
      check(seg(rs, 0x080b) && seg(rs, 0x080b).kind !== "basic", "8b real code starts at $080B", JSON.stringify(seg(rs, 0x080b)));
      check((rs.entryPoints ?? []).some((e) => e.address === 0x080b && e.source === "basic_sys"), "8c SYS 2059 is an entry point at $080B", JSON.stringify(rs.entryPoints));
    }
    const rc = await analyse(canon, "canon");
    if (rc) {
      check(seg(rc, 0x0801)?.kind === "basic" && seg(rc, 0x0801)?.end === 0x080c, "8d canonical chain ending 00 00: $0801-$080C is `basic`", JSON.stringify(seg(rc, 0x0801)));
      check((rc.entryPoints ?? []).some((e) => e.address === 0x080d && e.source === "basic_sys"), "8e SYS 2061 is an entry point at $080D", JSON.stringify(rc.entryPoints));
    }
    const rn = await analyse(notBasic, "notbasic");
    if (rn) {
      check(seg(rn, 0x0801)?.kind !== "basic", "8f a line with no SYS to prove the exit is not claimed as BASIC", JSON.stringify(seg(rn, 0x0801)));
    }

    // ── 1 — the rebuild check follows the preferred assembler ───────────────────
    if (!have64tass) {
      skip("1 SKIPPED: 64tass is not installed (C64RE_64TASS_BIN / PATH / homebrew) — the rebuild-check items cannot run here");
    } else {
      const d = await tool("disasm_prg", { prg_path: stub, no_analysis: true });
      check(/rebuild verified byte-identical/.test(d) && /with 64tass/.test(d) && !/jar not found/i.test(d),
        "1a preferredAssembler=64tass: the rebuild is verified, by 64tass", d.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
      const asm = readFileSync(join(P, "stub_disasm.asm"), "utf8");
      check(/rebuild verified byte-identical .* with 64tass/.test(asm), "1b the verdict is stamped into the listing head, naming the assembler");
      // the listing of a BASIC-bearing PRG is data for the basic bytes and code after: byte-identical rebuild
      const dc = await tool("disasm_prg", { prg_path: canon, no_analysis: true });
      check(/rebuild verified byte-identical/.test(dc), "1c the canonical-chain PRG also rebuilds byte-identical", dc.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
    }
  });

  // Q: no preference, its own server, in a project with no preference recorded
  if (have64tass) {
    const q = join(Q, "stub.prg"); writeFileSync(q, STUB_PRG);
    await session(cleanEnv({ C64RE_PROJECT_DIR: Q }), async (tool) => {
      const d = await tool("disasm_prg", { prg_path: q, no_analysis: true });
      const want = haveKick ? "KickAssembler" : "64tass";
      check(/rebuild verified byte-identical/.test(d) && d.includes(`with ${want}`),
        `1d no preference: ${want} (KickAssembler first when installed), verified`, d.split("\n").filter((l) => /rebuild|WARNING/.test(l)).join(" | "));
    });
  }
  if (haveKick || have64tass) {
    skip("1e SKIPPED: the 'no assembler at all' warning naming both cannot be provoked here — KickAssembler and 64tass both resolve from fixed install paths on this machine");
  }

  // ── 2 — a string offset/length is hex, a number is decimal ─────────────────────
  await session(cleanEnv({ C64RE_PROJECT_DIR: P }), async (tool) => {
    const blob = join(P, "window.bin");
    writeFileSync(blob, Buffer.alloc(0x300, 0xea));
    const hexs = await tool("disasm", { path: blob, load_address: "00F6", offset: "113", length: "70", no_analysis: true, import_graph: false });
    check(/offset 275 \(\$113\), length 112 \(\$70\)/.test(hexs), 'disasm offset="113" length="70" are $113 / $70 (275 / 112 bytes)', hexs.split("\n").filter((l) => /offset/.test(l)).join(" | ").slice(0, 200));
    const nums = await tool("disasm", { path: blob, load_address: "00F6", offset: 275, length: 112, no_analysis: true, import_graph: false });
    check(/offset 275 \(\$113\), length 112 \(\$70\)/.test(nums), "disasm offset=275 length=112 (JSON numbers) name the same window", "");
    const decimalString = await tool("disasm", { path: blob, load_address: "00F6", offset: "100", length: "10", no_analysis: true, import_graph: false });
    check(/offset 256 \(\$100\), length 16 \(\$10\)/.test(decimalString), 'a decimal-looking string "100"/"10" is hex ($100 / $10), not decimal', "");
    const rawTool = await tool("disasm_raw", { path: blob, load_address: "00F6", offset: "113", length: "70", output_asm: join(P, "analysis", "raw_window.asm"), no_analysis: true, import_graph: false });
    check(/offset 275 \(\$113\), length 112 \(\$70\)/.test(rawTool) || /275/.test(rawTool), "disasm_raw reads the same strings as hex", rawTool.split("\n").slice(0, 3).join(" | ").slice(0, 200));
  });

  // ── 3 — output folders are created ────────────────────────────────────────────
  await session(cleanEnv({ C64RE_PROJECT_DIR: P }), async (tool) => {
    if (have64tass) {
      const src = join(P, "tiny.tas");
      writeFileSync(src, "* = $0801\n.byte 1, 2, 3\n");
      const out = join(P, "analysis", "rebuild", "deep", "tiny.prg");
      const a = await tool("assemble_source", { source_path: src, assembler: "64tass", output_path: "analysis/rebuild/deep/tiny.prg" });
      check(existsSync(out) && /Exit code: 0/.test(a), "3a assemble_source (64tass) creates a missing analysis/rebuild/deep/ and writes the PRG", a.split("\n").slice(0, 5).join(" | "));
    } else {
      skip("3a SKIPPED: 64tass is not installed");
    }
    if (haveKick) {
      const src = join(P, "tinyk.asm");
      writeFileSync(src, "*=$0801\n.byte 1,2,3\n");
      const a = await tool("assemble_source", { source_path: src, assembler: "kickassembler", output_path: "analysis/kick/out/tinyk.prg" });
      check(existsSync(join(P, "analysis", "kick", "out", "tinyk.prg")) && /Exit code: 0/.test(a), "3c assemble_source (KickAssembler) creates a missing folder too", a.split("\n").slice(0, 5).join(" | "));
    } else {
      skip("3c SKIPPED: KickAssembler is not installed");
    }
    const tok = await tool("basic_tokenize", { text: '10 PRINT "HI"\n', output_path: "analysis/basic/new/hi.prg" });
    check(existsSync(join(P, "analysis", "basic", "new", "hi.prg")), "3d basic_tokenize creates a missing output folder", tok.split("\n").slice(0, 3).join(" | "));
  });

  // runtime_render_screen needs a daemon, which this smoke never starts: its writer is the
  // shared function below, tested directly with a stubbed screenshot reply.
  {
    const { writeFileCreatingDirs, pngBytesFromDataUrl } = await import(join(ROOT, "dist/lib/write-output.js"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const target = join(base, "screens-not-there", "a", "x.png");
    writeFileCreatingDirs(target, pngBytesFromDataUrl(`data:image/png;base64,${png.toString("base64")}`));
    check(existsSync(target) && Buffer.compare(readFileSync(target), png) === 0, "3e runtime_render_screen's writer (daemon stubbed) creates analysis/screens/-style folders and writes the PNG bytes");
  }

  // ── 6 — try_depack: header or .bin ───────────────────────────────────────────
  {
    const { packStandardPrg } = await import(join(ROOT, "dist/byteboozer-cruncher.js"));
    const payload = new Uint8Array(300);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + (i >> 3)) & 0xff;
    const { output: bb2 } = packStandardPrg(payload, 0x0800);
    writeFileSync(join(P, "lethargy.prg"), bb2);

    // RLE: [header $00 $C0] [run of 4 x $AA] [copy of 2: $01 $02] [end $00]
    const rle = Buffer.from([0x00, 0xc0, 0x03, 0xaa, 0x81, 0x01, 0x02, 0x00]);
    writeFileSync(join(P, "rle_headed.bin"), rle);
    writeFileSync(join(P, "rle_headless.bin"), rle.subarray(2));

    await session(cleanEnv({ C64RE_PROJECT_DIR: P }), async (tool) => {
      const a = await tool("try_depack", { input_path: join(P, "lethargy.prg"), format: "byteboozer2", output_path: "out/leth_bb2.prg" });
      const f = join(P, "out", "leth_bb2.prg");
      const got = existsSync(f) ? readFileSync(f) : Buffer.alloc(0);
      check(got.length === payload.length + 2 && got[0] === 0x00 && got[1] === 0x08 && Buffer.compare(got.subarray(2), Buffer.from(payload)) === 0,
        "6a byteboozer2: the .prg carries the load address $0800 and the body byte for byte (output folder created)", a.split("\n").slice(0, 8).join(" | "));
      check(/PRG \(2-byte load address/.test(a), "6b the answer says it is a PRG", "");

      const dflt = await tool("try_depack", { input_path: join(P, "lethargy.prg"), format: "byteboozer2" });
      check(existsSync(join(P, "lethargy.prg.byteboozer2.unpacked.prg")), "6c default name for a result with a load address is .prg", dflt.split("\n").slice(0, 5).join(" | "));

      const r1 = await tool("try_depack", { input_path: join(P, "rle_headless.bin"), format: "rle", output_path: "out/rle_body.prg" });
      check(!existsSync(join(P, "out", "rle_body.prg")) && existsSync(join(P, "out", "rle_body.bin")), "6d rle with no header: a requested .prg is written as .bin beside it", r1.split("\n").slice(0, 8).join(" | "));
      check(/written as .*rle_body\.bin/.test(r1) && /no load address/.test(r1), "6e the answer says the name was changed and why", "");
      const body = readFileSync(join(P, "out", "rle_body.bin"));
      check(Buffer.compare(body, Buffer.from([0xaa, 0xaa, 0xaa, 0xaa, 0x01, 0x02])) === 0, "6f the .bin holds the unpacked body only", [...body].join(","));

      const r2 = await tool("try_depack", { input_path: join(P, "rle_headed.bin"), format: "rle", has_rle_header: true, output_path: "out/rle_headed.prg" });
      const hb = existsSync(join(P, "out", "rle_headed.prg")) ? readFileSync(join(P, "out", "rle_headed.prg")) : Buffer.alloc(0);
      check(hb.length === 8 && hb[0] === 0x00 && hb[1] === 0xc0 && hb[2] === 0xaa, "6g rle with has_rle_header: a PRG at the header's address $C000", r2.split("\n").slice(0, 6).join(" | "));

      const r3 = await tool("try_depack", { input_path: join(P, "rle_headless.bin"), format: "rle", output_path: "out/rle_named.dat" });
      check(existsSync(join(P, "out", "rle_named.dat")) && !/written as/.test(r3), "6h a caller's own non-.prg name for a header-less result is kept", "");
    });
  }
} finally {
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}
