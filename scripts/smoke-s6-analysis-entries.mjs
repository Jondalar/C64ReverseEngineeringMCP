#!/usr/bin/env node
// Three defects of one real-project run (a boot stub that loads over the KERNAL vectors):
//
//   A  a PRG that loads over a KERNAL/BASIC RAM vector gets its entry from the vector it
//      overwrites, and those bytes are a pointer segment — not code decoded from the load address
//   B  a re-analysis is not seeded by its own previous heuristic output: a generated routine of
//      the same owner, reached by a RESOLVES_TO alias, no longer seeds (and so no longer pins a
//      wrong decode over the real entry); a human routine still does
//   C  an entry point outside the window the bytes run at is refused, naming the window and the
//      likely hex/decimal mix-up, and nothing is written
//
// Hermetic: synthetic 6502, temp projects, no ROMs, no media, no daemon.
// Exit 0 = pass, 1 = fail.   npm run smoke:s6-analysis-entries

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const hex = (a) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

const pipelineCli = join(ROOT, "dist/pipeline/cli.cjs");
const mcpCli = join(ROOT, "dist/cli.js");
if (!existsSync(pipelineCli) || !existsSync(mcpCli)) { console.error("dist/ is not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");

const analyze = (prgPath, outPath, { entries = [], projectDir = "" } = {}) => {
  execFileSync(process.execPath, [pipelineCli, "analyze-prg", prgPath, outPath, ...(entries.length ? [entries.join(",")] : []), "--no-register"], {
    stdio: "pipe",
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_NO_GRAPH_SEEDS: projectDir === "" ? "1" : "" },
  });
  return JSON.parse(readFileSync(outPath, "utf8"));
};
const kindAt = (report, address) => report.segments.find((s) => address >= s.start && address <= s.end)?.kind ?? "(none)";
const prg = (dir, name, load, bytes) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from([load & 0xff, load >> 8, ...bytes]));
  return path;
};

// ======================================================================== A
console.log("A — a load over the KERNAL vectors: the entry comes from the vector\n");
{
  const dir = testTmpDir("c64re-s6-a-");
  // $0326 IBSOUT -> $0331 (the image's own entry), ISTOP/IGETIN/ICLALL/USRCMD still the ROM's,
  // $0330 the low byte of ILOAD (the load ends inside that vector), then the code.
  const stub = [
    0x31, 0x03, 0xed, 0xf6, 0x3e, 0xf1, 0x2f, 0xf3, 0x66, 0xfe, 0x82,
    0xa9, 0x00, 0x8d, 0x20, 0xd0, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x60,
  ];
  const r = analyze(prg(dir, "boot.prg", 0x0326, stub), join(dir, "boot.json"));
  const entry = r.entryPoints.find((e) => e.address === 0x0331);
  check(entry?.source === "vector" && /IBSOUT/.test(entry.reason) && /overwritten by the load/.test(entry.reason),
    "the entry is $0331 from IBSOUT, said as 'overwritten by the load'", entry?.reason);
  check(!r.entryPoints.some((e) => e.source === "prg_header"), "the load address is not taken as the entry");
  check(kindAt(r, 0x0326) === "pointer_table" && kindAt(r, 0x0330) === "pointer_table", "$0326-$0330 is a pointer segment (the half vector included)");
  check(kindAt(r, 0x0331) === "code", "$0331 is code");
  check(!(r.codeAnalysis?.instructions ?? []).some((i) => i.address < 0x0331), "no instruction is decoded in the vector bytes");

  // The same bytes with vectors that all point at the ROM: not an autostart, nothing claimed, the old fallback.
  const rom = [0x31, 0xea, 0xed, 0xf6, 0xa9, 0x00, 0x60];
  const q = analyze(prg(dir, "rom.prg", 0x0326, rom), join(dir, "rom.json"));
  check(kindAt(q, 0x0326) !== "pointer_table", "vectors pointing out of the image are not an entry and claim no segment");

  // Other vectors of the table, by the ROM's own addresses: CINV is $0314, USRCMD $032E.
  const usr = Array.from({ length: 0x20 }, () => 0xea);
  usr[0x32e - 0x314] = 0x20; usr[0x32f - 0x314] = 0x03; // USRCMD -> $0320
  const u = analyze(prg(dir, "usr.prg", 0x0314, usr), join(dir, "usr.json"));
  check(u.entryPoints.some((e) => e.address === 0x0320 && e.source === "vector" && /USRCMD/.test(e.reason)), "USRCMD ($032E) overwritten with an in-image address is an entry too");
  rmSync(dir, { recursive: true, force: true });
}

// ======================================================================== B
console.log("\nB — a re-analysis is not seeded by its own previous heuristic output\n");
{
  const dir = testTmpDir("c64re-s6-b-");
  const proj = testTmpDir("c64re-s6-b-proj-");
  // $C000 lda #$60 ... — a fallback decode from $C000 swallows $C001, the real entry (an rts).
  const image = [0xa9, 0x60, 0xa2, 0x00, 0xca, 0xd0, 0xfd, 0x60, ...Array(8).fill(0x02), 0xa0, 0x00, 0x8c, 0x18, 0xd0, 0x60];
  const path = prg(dir, "stub.prg", 0xc000, image);
  const nodeId = (kind, a, layer = "ram/stub") => `p:${layer}:${kind}:${a.toString(16).padStart(4, "0")}`;
  mkdirSync(join(proj, "knowledge"), { recursive: true });
  const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"));
  db.exec(GRAPH_DDL);
  const n = db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,'ram','stub',NULL,'stub',?,?,?,'{}','static','inferred','control-flow','[]')");
  // last run's output: a generated routine at the load address, and the alias onto it
  n.run(nodeId("routine", 0xc000), "generated", "routine", 0xc000, 0xc007, "Wc000");
  db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,'ram',NULL,NULL,NULL,?,NULL,NULL,'{}','static','inferred','control-flow','[]')")
    .run("p:ram:addr:c000", "generated", "addr", 0xc000);
  // a human routine at $C010, and an alias onto it
  n.run(nodeId("routine", 0xc010), "human", "routine", 0xc010, 0xc015, "hud_setup");
  db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,'ram',NULL,NULL,NULL,?,NULL,NULL,'{}','static','inferred','control-flow','[]')")
    .run("p:ram:addr:c010", "generated", "addr", 0xc010);
  const e = db.prepare("INSERT OR REPLACE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,'generated','','static','inferred','signature-resolve',NULL,'{}')");
  e.run("p:ram:addr:c000", "RESOLVES_TO", nodeId("routine", 0xc000));
  e.run("p:ram:addr:c010", "RESOLVES_TO", nodeId("routine", 0xc010));
  db.close();

  const r = analyze(path, join(dir, "stub.json"), { entries: ["C001"], projectDir: proj });
  const seeds = r.codeSeedReport?.seeds ?? [];
  check(!seeds.some((s) => s.address === 0xc000), "the generated routine of the same owner is not a seed, alias or not");
  check((r.rejectedEntryPoints ?? []).every((x) => x.address !== 0xc001), "the real entry $C001 is not rejected", JSON.stringify(r.rejectedEntryPoints));
  check(r.entryPoints.some((x) => x.address === 0xc001 && x.source === "user"), "…it is seeded as the user entry");
  check(seeds.some((s) => s.address === 0xc010), "a human routine of the owner still seeds (through its alias)");
  rmSync(dir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}

// ======================================================================== C
console.log("\nC — an entry point outside the window is refused\n");
{
  const proj = testTmpDir("c64re-s6-c-");
  const proc = spawn(process.execPath, [mcpCli], {
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
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-s6", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { preferred_assembler: "kickass", name: "s6entries" });
    await call("agent_onboard", {});
    mkdirSync(join(proj, "artifacts", "blocks"), { recursive: true });
    const code = Buffer.alloc(0x40, 0xea);
    code[0x3f] = 0x60;
    writeFileSync(join(proj, "artifacts", "blocks", "win.bin"), code);
    const out = (name) => join(proj, "analysis", name);

    // load_address 7000 as the JSON number is $1B58; the entry "7000" is a string, i.e. hex $7000
    const bad = await call("analyze", { path: "artifacts/blocks/win.bin", load_address: 7000, entry_points: ["7000"], output_json: "analysis/bad.json" });
    check(/analyze refused/.test(bad), "the entry '7000' outside a window loaded at the number 7000 is refused");
    check(bad.includes(`${hex(7000)}-${hex(7000 + 0x3f)}`) && bad.includes(hex(0x7000)), "…naming the window and the address it read", bad.split("\n").find((l) => /outside/.test(l))?.slice(0, 200));
    check(/hex\/decimal mix-up/.test(bad), "…and the likely hex/decimal mix-up");
    check(!existsSync(out("bad.json")), "…and nothing was written");

    const badDisasm = await call("disasm", { path: "artifacts/blocks/win.bin", load_address: 7000, entry_points: ["7000"] });
    check(/disasm refused/.test(badDisasm) && /outside/.test(badDisasm), "the disassembly door refuses it the same way");

    const good = await call("analyze", { path: "artifacts/blocks/win.bin", load_address: 7000, entry_points: [7000], output_json: "analysis/good.json" });
    check(!/refused/.test(good) && existsSync(out("good.json")), "the same entry as a JSON number (decimal 7000 = the window's first byte) is accepted");
    const hexed = await call("analyze", { path: "artifacts/blocks/win.bin", load_address: "1B58", entry_points: ["1B58"], output_json: "analysis/hexed.json" });
    check(!/refused/.test(hexed) && existsSync(out("hexed.json")), "…and so is the hex string");

    const tools = (await rpc("tools/list", {})).result.tools;
    const description = JSON.stringify(tools.find((t) => t.name === "analyze")?.inputSchema ?? {});
    check(/decimal/i.test(description) && /7000/.test(description), "the schema says plainly: a number is decimal, a string is hex");
  } catch (e) {
    check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
  } finally {
    proc.kill();
    try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  smoke-s6-analysis-entries: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
