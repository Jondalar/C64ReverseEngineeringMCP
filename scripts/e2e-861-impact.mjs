#!/usr/bin/env node
// Spec 861 §7.5 — the impact of a change.
//
// A patch in routine R lists R's callers at depth 1, the readers of the bytes R
// writes, the pointer table pointing into R, the document covering R and the
// finding on R. A `jmp ($xxxx)` in the chain yields UNKNOWN, not low.
//
// The project is built through the product's own doors — project_init,
// analyze_prg, disasm_prg with an annotations file, doc_register, save_finding —
// so the fixture is the product's output and not a hand-written graph. Hermetic:
// no ROM, no assembler, no media, no runtime daemon.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:861-impact

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

console.log("Spec 861 §7.5 — what a change breaks, and what it cannot say\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

const proj = mkdtempSync(join(tmpdir(), "c64re-861i-"));
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

/** The section of the report under a heading, as lines. */
const section = (text, heading) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    if (l.trim()) out.push(l.trim());
  }
  return out;
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-861-impact", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "cost861impact" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});

  // ── the fixture ───────────────────────────────────────────────────────────
  //  C000 outer     jsr mid / jmp outer
  //  C010 mid       jsr tick_irq / jsr reader / jmp ($00FE)   ← the UNKNOWN
  //  C020 tick_irq  lda #$01 / sta $02 / sta $D020 / rts       ← what changes
  //  C029 reader    lda $02 / sta $D021 / rts                  ← reads what it writes
  //  C02F vectors   eight pointers, four of them into tick_irq
  const LOAD = 0xc000;
  const pad = (n) => Array(n).fill(0xea);
  const bytes = [
    0x20, 0x10, 0xc0, 0x4c, 0x00, 0xc0, ...pad(10),               // C000 outer
    0x20, 0x20, 0xc0, 0x20, 0x29, 0xc0, 0x6c, 0xfe, 0x00, ...pad(7), // C010 mid
    0xa9, 0x01, 0x85, 0x02, 0x8d, 0x20, 0xd0, 0x60, 0xea,          // C020 tick_irq
    0xa5, 0x02, 0x8d, 0x21, 0xd0, 0x60,                            // C029 reader
    0x20, 0xc0, 0x20, 0xc0, 0x20, 0xc0, 0x20, 0xc0,                // C02F → tick_irq ×4
    0x29, 0xc0, 0x29, 0xc0, 0x29, 0xc0, 0x29, 0xc0,                // C037 → reader ×4
  ];
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const prg = join(proj, "artifacts", "prg", "engine.prg");
  writeFileSync(prg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...bytes]));
  writeFileSync(join(proj, "artifacts", "prg", "engine_annotations.json"), JSON.stringify({
    routines: [
      { address: "C000", name: "outer", comment: "the main loop" },
      { address: "C010", name: "mid", comment: "dispatches through the vector at $00FE" },
      { address: "C020", name: "tick_irq", comment: "one raster tick: border and the tick counter at $02" },
      { address: "C029", name: "reader", comment: "reads the tick counter" },
    ],
    segments: [
      { start: "C000", end: "C02E", kind: "code" },
      { start: "C02F", end: "C03E", kind: "pointer_table", label: "vectors" },
    ],
  }, null, 2));

  await call("analyze_prg", { prg_path: "artifacts/prg/engine.prg", entry_points: ["C000"] });
  const disasm = await call("disasm_prg", { prg_path: "artifacts/prg/engine.prg", analysis_json: "artifacts/prg/engine_analysis.json" });
  check(/Graph: imported 4 routines/.test(disasm), "the four routines are in the graph's human layer", disasm.split("\n").find((l) => l.startsWith("Graph:")));

  mkdirSync(join(proj, "docs", "model"), { recursive: true });
  writeFileSync(join(proj, "docs", "model", "tick.md"), [
    "---", "title: The raster tick", "kind: synthesis", "covers:", "  - $C020-$C028",
    "sources: [engine_disasm.asm]", "method: >", "  Read from the listing.", "status: current", "---", "",
    "# The raster tick", "", "It writes the border colour once per frame and counts at $02.", "",
  ].join("\n"));
  const registered = await call("doc_register", { path: "docs/model/tick.md" });
  check(/Registered synthesis "The raster tick"/.test(registered), "the document declares what it covers (847)", registered);

  const saved = await call("save_finding", {
    kind: "observation", title: "the tick writes the border every frame",
    summary: "one $D020 write per call, and $02 counts the calls",
    address_range: { start: 0xc020, end: 0xc027 },
    evidence: [{ kind: "note", title: "engine_disasm.asm $C020" }],
  });
  check(/Finding saved/.test(saved), "the finding is on the range that is about to change");

  // ── the walk ──────────────────────────────────────────────────────────────
  const report = await call("change_impact", { ref: "tick_irq", prg_path: "artifacts/prg/engine.prg" });
  const d1 = section(report, "depth 1");
  const d2 = section(report, "depth 2");
  const unknown = section(report, "UNKNOWN");
  const claims = section(report, "claims that may be false");

  check(/change_impact: tick_irq → \$C020-\$C02[0-9A-F]/.test(report), "the target resolves to its range", report.split("\n")[0]);
  check(d1.some((l) => /^mid\b/.test(l) && /calls it/.test(l)), "depth 1 names the caller", d1.join(" | "));
  check(
    d1.some((l) => /points into it/.test(l)),
    "depth 1 names what POINTS into it — the pointer table a call graph never shows",
    d1.join(" | "),
  );
  check(d2.some((l) => /^outer\b/.test(l)), "depth 2 names the caller's caller", d2.join(" | "));
  check(
    d2.some((l) => /reads \$0002, which this range writes/.test(l)),
    "depth 2 names the routine that reads what this range writes",
    d2.join(" | "),
  );
  check(
    unknown.some((l) => /jmp \(\$00FE\)/i.test(l)),
    "the `jmp ($xxxx)` in the chain is UNKNOWN",
    unknown.slice(0, 6).join(" | "),
  );
  check(
    /UNKNOWN — not low, not none/.test(report),
    "…and UNKNOWN is its own class, never folded into low",
  );
  check(
    unknown.some((l) => /the destination is a pointer in memory/.test(l)),
    "…with the reason it cannot be followed",
  );
  check(claims.some((l) => /\[document\] The raster tick/.test(l)), "the document covering the range is listed as a claim that may go stale", claims.join(" | "));
  check(claims.some((l) => /\[finding\] the tick writes the border/.test(l)), "so is the finding on it", claims.join(" | "));
  {
    // The WHOLE routine: liveness at its exit is everything by construction (an
    // `rts` is where the graph ends), so the answer is what its caller expects —
    // the computed signature.
    const line = report.split("\n").find((l) => l.includes("must preserve")) ?? "";
    const how = report.split("\n")[report.split("\n").indexOf(line) + 1] ?? "";
    check(/what the change must preserve: [A-Z]/.test(line), "it names what the change must preserve", line);
    check(/computed signature/.test(how) && /§3.3/.test(how), "…from the interface its caller sees (826), carried backwards by liveness (§3.3)", how.trim());
  }
  {
    // A range INSIDE the routine: now liveness is the sharper answer, and it is
    // the one reported.
    const part = await call("change_impact", { address_start: "$C020", address_end: "$C023", prg_path: "artifacts/prg/engine.prg" });
    const line = part.split("\n").find((l) => l.includes("must preserve")) ?? "";
    const how = part.split("\n")[part.split("\n").indexOf(line) + 1] ?? "";
    check(/read backwards from \$C023/.test(how), "a range that ends INSIDE a routine is read backwards from its own end", how.trim());
    check(/must preserve: A\b/.test(line), "…and A is live after $C023, because $C024 stores it", line);
  }

  // ── an address range instead of a name, and a depth limit ─────────────────
  {
    const byRange = await call("change_impact", { address_start: "$C020", address_end: "$C027", depth: 1, prg_path: "artifacts/prg/engine.prg" });
    check(/depth 1 — will break/.test(byRange), "a range works as well as a name");
    check(section(byRange, "depth 2").join(" ") === "nothing", "…and depth 1 stops at depth 1", section(byRange, "depth 2").join(" "));
  }

  // ── a range nothing in the graph knows ────────────────────────────────────
  {
    const empty = await call("change_impact", { address_start: "$9000", address_end: "$9010" });
    check(/nothing in the graph resolves/.test(empty), "a range the graph does not know says so, rather than inventing a chain", empty.split("\n").slice(0, 3).join(" | "));
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-861-impact: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
