#!/usr/bin/env node
// One call, many paths — the bulk door on `disasm` and `analyze`.
//
// An autonomous run over Neuromancer extracted 217 payloads and then had to put each
// one through `analyze` and `disasm` on its own: 400+ MCP round trips through two doors
// that each take exactly ONE path. `disasm_menu` exists but wants an extract_disk
// manifest, not a list of payloads. The run worked around the arithmetic by spawning
// eight subagents — which is a scheduling answer to a door problem.
//
// What the bulk door must do:
//
//   1 `paths` exists on BOTH doors and is visible on the surface
//   2 one call renders every path, and every listing is really on disk
//   3 a bad path is named and does NOT sink the batch — the good ones still render
//   4 the answer stays READABLE at scale: one line per path, never N listings
//   5 the ways of naming the bytes are mutually exclusive, and the refusal says so
//   6 one output name cannot hold N listings — that is refused, not silently reused
//   7 an empty list is refused rather than answered with an empty report
//
// Hermetic: a temp project, synthetic 6502, no ROMs, no media, no daemon, no network.
// The rebuild half needs KickAssembler; without it the verdict line differs and the
// gate checks the batch bookkeeping only, which is what this door owns.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:060-bulk

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const head = (n, title) => console.log(`\n── §${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("Bulk doors — one call, many paths\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-bulk-"));
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
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 600000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return `# rpc error\n${JSON.stringify(r.error)}`;
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// Border, a page copy, a KERNAL call, return — a small real routine.
const CODE = [
  0xa9, 0x00,             // lda #$00
  0x8d, 0x20, 0xd0,       // sta $D020
  0xa2, 0x00,             // ldx #$00
  0xbd, 0x00, 0xc1,       // lda $C100,x
  0x9d, 0x00, 0x04,       // sta $0400,x
  0xe8,                   // inx
  0xd0, 0xf7,             // bne
  0x20, 0xd2, 0xff,       // jsr $FFD2
  0x60,                   // rts
];

/** The payload set the defect is about, in miniature. */
const PAYLOADS = 12;
const payloadPath = (n) => `artifacts/payloads/p${String(n).padStart(3, "0")}.prg`;

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-060-bulk", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "bulk-doors" });
  await call("agent_onboard", {});

  mkdirSync(join(proj, "artifacts", "payloads"), { recursive: true });
  const body = Buffer.alloc(0x40, 0xea);
  Buffer.from(CODE).copy(body, 0);
  for (let n = 0; n < PAYLOADS; n++) {
    // A different load address per payload, the way an extract run hands them over.
    const load = 0x2000 + n * 0x100;
    writeFileSync(join(proj, payloadPath(n)),
      Buffer.concat([Buffer.from([load & 0xff, load >> 8]), body]));
  }
  const all = Array.from({ length: PAYLOADS }, (_, n) => payloadPath(n));

  // ── §1 the surface ────────────────────────────────────────────────────────
  head(1, "`paths` is on both doors, and the surface shows it");
  {
    const tools = (await rpc("tools/list", {})).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["disasm", "analyze"]) {
      const tool = byName.get(name);
      check(!!tool, `${name} is on the default surface`);
      const props = tool?.inputSchema?.properties ?? {};
      check(Object.prototype.hasOwnProperty.call(props, "paths"),
        `…and ${name} declares a \`paths\` parameter`,
        Object.keys(props).join(",").slice(0, 120));
      check(/one call/i.test(props.paths?.description ?? ""),
        `…whose description says it is one call over many`,
        (props.paths?.description ?? "(none)").slice(0, 110));
      check(/named|per path/i.test(props.paths?.description ?? ""),
        `…and that a bad path is named rather than sinking the batch`);
    }
    // Backticked, so the incidental ".asm/.tas paths" in the old prose cannot pass this.
    check(/`paths`/.test(byName.get("disasm")?.description ?? ""),
      "disasm's own description names `paths` — a parameter nobody reads about is not reachable");
    check(/`paths`/.test(byName.get("analyze")?.description ?? ""),
      "…and analyze's does too");
  }

  // ── §2 one call, every path ───────────────────────────────────────────────
  head(2, "one call renders every path, and the listings are on disk");
  const batch = await call("disasm", { paths: all });
  {
    check(!/# disasm refused/.test(batch), "the batch is answered, not refused",
      batch.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(new RegExp(`${PAYLOADS} paths`).test(batch), `the header counts all ${PAYLOADS} paths`,
      batch.split("\n").filter(Boolean)[0]?.slice(0, 140));
    const named = all.filter((p) => batch.includes(p));
    check(named.length === PAYLOADS, "every path is named in the answer", `${named.length}/${PAYLOADS}`);
    const okLines = batch.split("\n").filter((l) => /^\s*OK\b/.test(l));
    check(okLines.length === PAYLOADS, "…on its own OK line", `${okLines.length} OK lines`);
    // …and the listings really exist, at the per-path default location.
    const written = all.filter((p) => existsSync(join(proj, p.replace(/\.prg$/, "_disasm.asm"))));
    check(written.length === PAYLOADS, "every listing was actually written", `${written.length}/${PAYLOADS} on disk`);
  }

  // ── §3 a bad path is named, and does not sink the batch ───────────────────
  head(3, "partial failure is per path and named");
  {
    const mixed = [payloadPath(0), "artifacts/payloads/nope.prg", payloadPath(1)];
    const out = await call("disasm", { paths: mixed });
    check(!/# disasm refused/.test(out), "one bad path does NOT refuse the whole call",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/nope\.prg/.test(out), "the bad path is named");
    check(/^\s*FAILED\s+.*nope\.prg/m.test(out), "…on a FAILED line of its own",
      out.split("\n").find((l) => /nope/.test(l))?.slice(0, 140));
    const okLines = out.split("\n").filter((l) => /^\s*OK\b/.test(l));
    check(okLines.length === 2, "…and the two good paths still rendered", `${okLines.length} OK lines`);
    check(/2 rendered/.test(out) && /1 failed/.test(out), "the header counts both halves",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/does not exist|no such file|not found/i.test(out),
      "the reason the bad path failed is in the answer, not just its name");
  }

  // ── §4 readable at scale ──────────────────────────────────────────────────
  head(4, "the answer stays readable — one line per path, never N listings");
  {
    // The server appends its once-per-session project rules to the first answer of a
    // session; that block is not this door's report, so it is not measured as one.
    const report = batch.split(/\n---\n\*\*Project rule/)[0];
    const lines = report.split("\n");
    check(lines.length < PAYLOADS * 2, "the answer is a report, not a pile of listings",
      `${lines.length} lines for ${PAYLOADS} paths`);
    check(!/\.pc = \$/.test(batch), "no listing body leaked into the batch answer");
    check(!/lda #\$00/.test(batch) && !/sta \$d020/i.test(batch),
      "…not one disassembled instruction");
    check(report.length / PAYLOADS < 250, "…and it stays bounded per path",
      `${Math.round(report.length / PAYLOADS)} chars per path`);
    check(/re-run/i.test(report), "…and it says how to get one path's full answer");
  }

  // ── §5 the bytes are named once ───────────────────────────────────────────
  head(5, "paths and path/artifact_id are mutually exclusive");
  {
    const clash = await call("disasm", { paths: [payloadPath(0)], path: payloadPath(1) });
    check(/# disasm refused/.test(clash), "paths + path is refused",
      clash.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/paths/.test(clash) && /\bpath\b/.test(clash), "…and the refusal names both");
    const clash2 = await call("analyze", { paths: [payloadPath(0)], artifact_id: "whatever" });
    check(/# analyze refused/.test(clash2), "paths + artifact_id is refused too",
      clash2.split("\n").filter(Boolean)[0]?.slice(0, 140));
  }

  // ── §6 one output name cannot hold N listings ─────────────────────────────
  head(6, "an output name and a batch are refused together");
  {
    const out = await call("disasm", { paths: [payloadPath(0), payloadPath(1)], output_asm: "one.asm" });
    check(/# disasm refused/.test(out), "paths + output_asm is refused",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/output_asm/.test(out), "…naming the parameter that cannot be shared");
    const out2 = await call("analyze", { paths: [payloadPath(0), payloadPath(1)], output_json: "one.json" });
    check(/# analyze refused/.test(out2) && /output_json/.test(out2),
      "…and the same on the analysis door",
      out2.split("\n").filter(Boolean)[0]?.slice(0, 140));
  }

  // ── §7 an empty list is refused ───────────────────────────────────────────
  head(7, "an empty list is refused, not answered with an empty report");
  {
    const out = await call("disasm", { paths: [] });
    check(/# disasm refused/.test(out), "paths: [] is refused",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/empty/i.test(out), "…and says so in words");
  }

  // ── §8 the analysis door does the same ────────────────────────────────────
  head(8, "analyze takes the same batch");
  {
    const out = await call("analyze", { paths: all.slice(0, 4) });
    check(!/# analyze refused/.test(out), "the analysis batch is answered",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(/4 paths/.test(out) && /4 analysed|4 rendered/.test(out),
      "…and counts what it did", out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    const written = all.slice(0, 4).filter((p) => existsSync(join(proj, p.replace(/\.prg$/, "_analysis.json"))));
    check(written.length === 4, "every analysis JSON was written", `${written.length}/4`);
    check(!/"segments"/.test(out), "…and no analysis JSON body leaked into the answer");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-060-bulk-doors: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
