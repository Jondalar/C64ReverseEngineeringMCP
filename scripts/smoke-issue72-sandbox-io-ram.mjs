#!/usr/bin/env node
// Issue #72 — a store to an I/O register is not a RAM byte, so it must not end up in the RAM image.
//
// With I/O banked in ($01=$37) a store to $D000-$DFFF lands in a chip. `sandbox_6502_run` used to
// lay that value over the RAM bytes it wrote to the PRG (output_path) and the runs: a depacker that
// wrote RAM at $D011 with I/O out and later did `sta $d011` with I/O in produced a file carrying the
// VIC value as if it were a game byte. The RAM image now keeps what RAM holds; the answer names the
// I/O addresses, says which of them lie inside the written runs and which are not in the image.
//
// A. hermetic: a stub `trx64cli` replays the runtime's JSON, new shape and old shape, so the C64RE
//    side is decided here with no runtime at all.
// B. live (needs a trx64cli that reports ramWrittenRuns/ramHex — C64RE_TRX64CLI_BIN; SKIPS LOUDLY
//    otherwise): the real routine, assembled with scripts/lib/asm6502-mini.mjs.
//
//   npm run smoke:issue72-sandbox-io-ram
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n        ${String(detail).split("\n").join("\n        ")}` : ""}`);
};
if (!existsSync(join(ROOT, "dist", "server-tools", "sandbox.js"))) {
  console.log("FAIL  dist is built (npm run build:mcp)");
  process.exit(1);
}

const { registerSandboxTools } = await import(pathToFileURL(join(ROOT, "dist/server-tools/sandbox.js")).href);
const { assemble } = await import(pathToFileURL(join(ROOT, "scripts/lib/asm6502-mini.mjs")).href);

const scratch = mkdtempSync(join(tmpdir(), "c64re-72-"));
const tools = new Map();
registerSandboxTools({ tool(name, description, shape, handler) { tools.set(name, { description, shape, handler }); return {}; } }, {
  projectDir: () => scratch,
  toolsDir: () => scratch,
  readTextFile: (p) => readFileSync(p, "utf8"),
  cliResultToContent: (r) => ({ content: [{ type: "text", text: r.stderr || r.stdout }] }),
  tryRegisterKnowledgeArtifacts: async () => ({}),
});
const call = async (args) => (await tools.get("sandbox_6502_run").handler(args, {})).content.map((c) => c.text).join("\n");
const prgs = (dir) => (existsSync(join(scratch, dir)) ? readdirSync(join(scratch, dir)).sort() : []);
const bytesOf = (dir, f) => [...readFileSync(join(scratch, dir, f)).subarray(2)];

const hex = (b) => Buffer.from(b).toString("hex");
const doorArgs = (out) => ({ loads: [{ hex_bytes: "60", address: "0800" }], initial_pc: "0800", output_path: out, max_steps: 100000 });

const savedBin = process.env.C64RE_TRX64CLI_BIN;
try {
  // ── A. the stub runtime ────────────────────────────────────────────────────
  // The routine "stored RAM $11,$06,$13 to $D010-$D012 with I/O out, then $0B to $D011 and $0A to
  // $D024 with I/O in". The runtime's overlay hex carries $0B/$0A; ramHex carries the RAM.
  const overlay = new Uint8Array(0x10000); overlay.set([0x11, 0x0b, 0x13], 0xd010); overlay[0xd024] = 0x0a;
  const rawRam = new Uint8Array(0x10000); rawRam.set([0x11, 0x06, 0x13], 0xd010);
  const stubJson = (modern) => ({
    ok: true, stopReason: "sentinel_rts", pc: 0xfffe, cycles: 100, steps: 20,
    writtenSpan: { lo: 0xd010, hi: 0xd024 },
    writtenRuns: [{ lo: 0xd010, hi: 0xd012 }, { lo: 0xd024, hi: 0xd024 }],
    ...(modern ? { ramWrittenRuns: [{ lo: 0xd010, hi: 0xd012 }] } : {}),
    finalRegs: { a: 0, x: 0, y: 0, sp: 0xfd, p: 0x22 }, streamPos: 0,
    harvest: { addr: 0, len: 0x10000, hex: hex(overlay), ioWritten: [[0xd011, 0xd011], [0xd024, 0xd024]], ...(modern ? { ramHex: hex(rawRam) } : {}) },
    harvests: [],
  });
  const stub = (name, json) => {
    const jsonFile = join(scratch, `${name}.json`);
    writeFileSync(jsonFile, JSON.stringify(json));
    const bin = join(scratch, name);
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(jsonFile)}, "utf8"));\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  process.env.C64RE_TRX64CLI_BIN = stub("cli-new", stubJson(true));
  const modern = await call(doorArgs("out/new.prg"));
  check("A1 new runtime: ONE file, $D010-$D012, and $D011 is the RAM byte ($06), not the VIC value ($0B)",
    JSON.stringify(prgs("out")) === JSON.stringify(["new.prg"]) && JSON.stringify(bytesOf("out", "new.prg")) === "[17,6,19]", modern);
  check("A2 the answer names the I/O stores and says $D011 is inside the runs, RAM byte kept",
    /I\/O stores: \$D011, \$D024/.test(modern) && /Inside the written runs: \$D011 — RAM was also stored there; the image keeps the RAM byte/.test(modern), modern);
  check("A3 ...and that $D024 (stored only in I/O) is not in the image",
    /Not in the image: \$D024 — stored only in I\/O/.test(modern), modern);
  check("A4 the written run is $D010-$D012 and carries no I/O value",
    /Written runs: 1, 3 bytes in all — \$D010-\$D012/.test(modern) && !/\bBB\b|\$0B\b/i.test(modern.split("\n").find((l) => l.startsWith("Written runs")) ?? ""), modern.split("\n").find((l) => l.startsWith("Written runs")));

  process.env.C64RE_TRX64CLI_BIN = stub("cli-old", stubJson(false));
  const old = await call(doorArgs("out/old.prg"));
  const oldFiles = prgs("out").filter((f) => f.startsWith("old"));
  check("A5 old runtime: the I/O-stored addresses are CUT OUT (split into $D010 and $D012), never written as I/O values",
    JSON.stringify(oldFiles) === JSON.stringify(["old-$D010.prg", "old-$D012.prg"])
      && JSON.stringify(bytesOf("out", "old-$D010.prg")) === "[17]" && JSON.stringify(bytesOf("out", "old-$D012.prg")) === "[19]", oldFiles.join(", "));
  check("A6 ...and the answer warns loudly that this runtime cannot report the RAM under them",
    /WARNING: this trx64cli does not report the RAM image under I\/O stores/.test(old), old);

  // ── B. the live runtime ────────────────────────────────────────────────────
  console.log("");
  if (savedBin === undefined) delete process.env.C64RE_TRX64CLI_BIN; else process.env.C64RE_TRX64CLI_BIN = savedBin;
  const cli = process.env.C64RE_TRX64CLI_BIN;
  const live = Boolean(cli && existsSync(cli));
  if (!live) {
    console.log(`SKIP  B. live half — no trx64cli at ${cli ?? "(C64RE_TRX64CLI_BIN unset)"}. Point C64RE_TRX64CLI_BIN at a trx64cli with ramWrittenRuns.`);
  } else {
    // $01=$34 (all RAM): store $11,$06,$13 to $D010-$D012. Then $01=$37 (I/O in): sta $D011 = $0B, sta $D024 = $0A.
    const code = assemble(0x0800, [
      "LDA #$34", "STA $01",
      "LDA #$11", "STA $D010", "LDA #$06", "STA $D011", "LDA #$13", "STA $D012",
      "LDA #$37", "STA $01",
      "LDA #$0B", "STA $D011", "LDA #$0A", "STA $D024",
      "RTS",
    ]);
    const out = await call({ loads: [{ hex_bytes: hex(code), address: "0800" }], initial_pc: "0800", output_path: "live/io.prg", max_steps: 100000 });
    const files = prgs("live");
    if (/WARNING: this trx64cli does not report the RAM image/.test(out)) {
      console.log("SKIP  B. live half — this trx64cli predates ramWrittenRuns/ramHex (the old-runtime path is covered by A5/A6).");
    } else {
    const d010 = files.find((f) => /D010/i.test(f));
    const img = d010 ? bytesOf("live", d010) : [];
    check("B1 live: the PRG byte at $D011 is the RAM value ($06), not the VIC register value ($0B)",
      img.length >= 3 && img[1] === 0x06 && img[0] === 0x11 && img[2] === 0x13, `${files.join(", ")} ${JSON.stringify(img)}\n${out}`);
    check("B2 live: $D024 (I/O only) is in no file, and the answer names it", !files.some((f) => /D024/i.test(f)) && /\$D024/.test(out) && !/WARNING: this trx64cli does not report/.test(out), out);
    }
  }
} finally {
  if (savedBin === undefined) delete process.env.C64RE_TRX64CLI_BIN; else process.env.C64RE_TRX64CLI_BIN = savedBin;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nan I/O store is not a RAM byte" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
