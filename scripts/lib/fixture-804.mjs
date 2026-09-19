// Spec 804 — a fixture project built through the product's own doors.
//
// No local game project, no hand-written graph: `project_init` → PRGs → `analyze_prg` →
// annotation files + `disasm_prg` (the human layer, relocations for one payload) →
// `assemble_source` (the build layer). Four payloads:
//
//   alpha  $1000  JSR $1010 / INC $0400 / JMP $1000 ... $1010 LDA #1 STA $D020 RTS
//   beta   $1000  LDX #0 / INX / BNE $1002 / JSR $1010 / JMP $1000 ... $1010 LDA #2 STA $D021 RTS
//          — the SAME addresses as alpha with different code: only residency tells them apart
//   delta  stored $3000, runs at $C000 (a relocation), a user routine at $C000
//   gamma  KickAssembler source at $2000, assembled with symbols → the build layer
//
// Used by smoke-804-resolver (no runtime) and smoke-804-monitor (a sandbox runtime).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PAYLOADS = {
  alpha: { load: 0x1000, bytes: [0x20, 0x10, 0x10, 0xee, 0x00, 0x04, 0x4c, 0x00, 0x10, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60] },
  beta: { load: 0x1000, bytes: [0xa2, 0x00, 0xe8, 0xd0, 0xfd, 0x20, 0x10, 0x10, 0x4c, 0x00, 0x10, 0xea, 0xea, 0xea, 0xea, 0xea, 0xa9, 0x02, 0x8d, 0x21, 0xd0, 0x60] },
  delta: { load: 0x3000, bytes: [0xa9, 0x05, 0x8d, 0x00, 0x04, 0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x4c, 0x00, 0xc0, 0xea, 0xea, 0x60] },
};

export const GAMMA_ASM = [
  "*=$2000",
  "start:",
  "  jsr print_string",
  "  jmp start",
  "print_string:",
  "  lda #$41",
  "  sta $0400",
  "  ldx #$00",
  "  rts",
  "",
].join("\n");

export function prgBytes(p) {
  return Buffer.from([p.load & 0xff, p.load >> 8, ...p.bytes]);
}

/** A stdio MCP client on dist/cli.js. */
export function startMcp(root, env) {
  const proc = spawn(process.execPath, [join(root, "dist/cli.js")], {
    cwd: env.C64RE_PROJECT_DIR,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 1;
  const rpc = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const my = id++;
    const t = setTimeout(() => { pending.delete(my); reject(new Error(`timeout ${method} ${params?.name ?? ""}\n${stderr.slice(-800)}`)); }, timeoutMs);
    pending.set(my, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  });
  const textOf = (r) => (r?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const tool = async (name, args, timeoutMs) => {
    const r = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return { text: textOf(r), structured: r.result?.structuredContent, isError: r.result?.isError === true };
  };
  return {
    proc,
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-804", version: "0" } });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return (await rpc("tools/list", {})).result?.tools ?? [];
    },
    tool,
    stderr: () => stderr,
    close() { try { proc.kill(); } catch { /* gone */ } },
  };
}

/** Build the fixture project. Returns its dir and the paths of the payloads. */
export async function buildFixture804(root, log = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "c64re-804-"));
  const mcp = startMcp(root, { C64RE_PROJECT_DIR: dir, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_AUTOSTART: "0" });
  try {
    await mcp.init();
    await mcp.tool("project_init", { project_dir: dir, name: "Spec 804 fixture" });
    const pay = join(dir, "payloads");
    mkdirSync(pay, { recursive: true });
    const paths = {};
    for (const [name, p] of Object.entries(PAYLOADS)) {
      paths[name] = join(pay, `${name}.prg`);
      writeFileSync(paths[name], prgBytes(p));
    }
    // annotations: the human layer
    writeFileSync(join(pay, "alpha_annotations.json"), JSON.stringify({
      routines: [{ address: "1000", name: "alpha_main", comment: "fixture" }, { address: "1010", name: "set_border", comment: "fixture" }],
    }, null, 2));
    writeFileSync(join(pay, "beta_annotations.json"), JSON.stringify({
      routines: [{ address: "1000", name: "beta_main", comment: "fixture" }, { address: "1010", name: "set_background", comment: "fixture" }],
    }, null, 2));
    writeFileSync(join(pay, "delta_annotations.json"), JSON.stringify({
      routines: [{ address: "C000", name: "reloc_entry", comment: "runs relocated" }],
      segments: [{ start: "C000", end: "C00F", kind: "code", label: "reloc_block" }],
    }, null, 2));
    for (const name of Object.keys(PAYLOADS)) {
      const analysis = join(pay, `${name}_analysis.json`);
      const a = await mcp.tool("analyze_prg", { project_dir: dir, prg_path: paths[name], output_json: analysis });
      log(`analyze_prg ${name}: ${existsSync(analysis) ? "ok" : a.text.slice(0, 200)}`);
      const args = { project_dir: dir, prg_path: paths[name], analysis_json: analysis };
      if (name === "delta") args.relocations = [{ fileStart: "$3000", fileEnd: "$300F", runtimeAddr: "$C000" }];
      const d = await mcp.tool("disasm_prg", args);
      log(`disasm_prg ${name}: ${d.isError ? d.text.slice(0, 200) : "ok"}`);
    }
    // the build layer
    const src = join(pay, "gamma.asm");
    writeFileSync(src, GAMMA_ASM);
    const asm = await mcp.tool("assemble_source", { source_path: src, assembler: "kickassembler" });
    log(`assemble_source gamma: ${/Symbols: /u.test(asm.text) ? "symbols registered" : asm.text.slice(0, 300)}`);
    paths.gamma = join(pay, "gamma.prg");
    return { dir, paths };
  } finally {
    mcp.close();
  }
}
