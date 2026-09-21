#!/usr/bin/env node
// Six defects an autonomous RE run wrote down against the disassembly family.
//
//   1 the address rule is ONE function, imported, not a sentence copied into a
//     second door — and both doors answer by it
//   2 a window of a bigger file does not inherit that file's analysis, and a caller
//     can refuse an analysis outright
//   3 an analysis named outright is the analysis rendered — it used to lose to the
//     stem-matched sidecar whenever no entry points were passed
//   4 disasm_raw imports the annotations it applied into the graph, the way disasm_prg
//     does; it is the ONLY door for a block with no PRG header
//   5 no answer carries a project's whole owner list
//   6 a listing that cannot be reassembled says what to do about it
//
// Hermetic: temp projects, synthetic bytes, a synthetic graph.sqlite, no ROMs, no
// media, no daemon, no network. The rebuild half needs KickAssembler and skips those
// checks loudly without a jar, the way e2e:830 and e2e:865 do.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:disasm-family

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };
const head = (n, title) => console.log(`\n── ${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_ASSEMBLER = existsSync(KICKASS);

console.log("The disassembly family — six defects from one autonomous run\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-disasm-family-"));
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

// The same small routine e2e:865 uses: border, page copy, print, return.
const KNOWN_CODE = [
  0xa9, 0x00, 0x8d, 0x20, 0xd0, 0xa2, 0x00, 0xbd, 0x00, 0xc1,
  0x9d, 0x00, 0x04, 0xe8, 0xd0, 0xf7, 0x20, 0xd2, 0xff, 0x60,
];

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-disasm-family", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "disasm-family" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts", "blocks"), { recursive: true });

  // ── 1 one address rule, imported, not copied ──────────────────────────────
  head(1, "one address rule, and both halves read by it");
  {
    // The window a string names is the HEX window, in the answer and in the file.
    const big = Buffer.alloc(0x400, 0xea);
    Buffer.from(KNOWN_CODE).copy(big, 0x33);
    const path = join(proj, "artifacts", "blocks", "rule.bin");
    writeFileSync(path, big);
    const out = await call("disasm_raw", {
      path: "artifacts/blocks/rule.bin", load_address: "C000", offset: "33", length: "78", no_analysis: true,
    });
    check(/offset 51 \(\$33\), length 120 \(\$78\)/.test(out),
      'a string offset/length is HEX: "33"/"78" is 51/120 bytes, never 33/78',
      /Provenance: .*/.exec(out)?.[0]);
    check(/Source window: offset 51, length 120 \(bytes 51\.\.170\)/.test(out),
      "…and the pipeline half read the very same window, not a second notation",
      out.split("\n").find((l) => l.startsWith("Source window")));
    const asNumbers = await call("disasm_raw", {
      path: "artifacts/blocks/rule.bin", load_address: "C000", offset: 51, length: 120, no_analysis: true,
      output_asm: "analysis/raw-disasm/rule_numbers.asm",
    });
    check(/offset 51 \(\$33\), length 120 \(\$78\)/.test(asNumbers),
      "a JSON number is taken as given, so 51/120 names the same window as \"33\"/\"78\"",
      /Provenance: .*/.exec(asNumbers)?.[0]);
    const refused = await call("disasm_raw", { path: "artifacts/blocks/rule.bin", load_address: "GGGG" });
    check(/disasm_raw refused/.test(refused) && /load_address/.test(refused) && /is HEX/.test(refused),
      "a bad address is refused by field name, with the rule attached",
      refused.split("\n").filter(Boolean)[2]);
  }
  {
    // The structural half: one body, no third copy. Run as part of this gate so a
    // copy cannot be reintroduced by a change that never runs check:address-rule.
    const { status } = await import("node:child_process").then((cp) => ({
      status: cp.spawnSync(process.execPath, [join(ROOT, "scripts/check-address-rule.mjs")], { stdio: "pipe" }).status,
    }));
    check(status === 0, "check:address-rule is green — one body, no third copy", `exit ${status}`);
  }

  // ── 2 a window does not inherit the file's analysis ───────────────────────
  head(2, "a window is not the file it came out of");
  {
    // A PRG, analysed whole. Then a window out of the middle of the same bytes.
    mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
    const whole = Buffer.alloc(0x800, 0xea);
    Buffer.from(KNOWN_CODE).copy(whole, 0);
    Buffer.from(KNOWN_CODE).copy(whole, 0x400);
    const prgPath = join(proj, "artifacts", "prg", "whole.prg");
    writeFileSync(prgPath, Buffer.concat([Buffer.from([0x00, 0xc0]), whole]));
    await call("analyze_prg", { prg_path: "artifacts/prg/whole.prg" });
    const analysisAbs = join(proj, "artifacts", "prg", "whole_analysis.json");
    check(existsSync(analysisAbs), "the whole file has an analysis beside it", analysisAbs);

    // The same bytes as a headerless block, with the whole-file analysis beside them.
    const blockPath = join(proj, "artifacts", "prg", "whole.bin");
    writeFileSync(blockPath, whole);
    const windowed = await call("disasm_raw", {
      path: "artifacts/prg/whole.bin", load_address: "C400", offset: "400", length: "14",
    });
    check(!/disasm_raw refused/.test(windowed), "a 20-byte window renders", windowed.split("\n")[0]);
    check(/\(legacy rendering\)/.test(windowed) && /Analysis used: none/.test(windowed),
      "…without inheriting whole_analysis.json, which describes the whole file",
      windowed.split("\n").find((l) => l.startsWith("Listing:")));
    const instructions = Number(/Listing: (\d+) instructions/.exec(windowed)?.[1] ?? "-1");
    check(instructions === 9,
      "…so the listing holds the window's nine instructions, not the file's hundreds",
      `${instructions} instructions`);

    // Named outright, the mismatch is a refusal that names both spans.
    const forced = await call("disasm_raw", {
      path: "artifacts/prg/whole.bin", load_address: "C400", offset: "400", length: "14",
      analysis_json: "artifacts/prg/whole_analysis.json",
    });
    check(/disasm_raw refused/.test(forced) && /describes \$C000-\$C7FF/.test(forced) && /this window runs at \$C400-\$C413/.test(forced),
      "an analysis that describes a different span is refused, and both spans are named",
      forced.split("\n").filter(Boolean)[2]?.slice(0, 120));
    check(/no_analysis/.test(forced), "…and the refusal names the way out");

    // And a caller can say "no analysis" outright, over a file that has one.
    const refusedOutright = await call("disasm_raw", {
      path: "artifacts/prg/whole.bin", load_address: "C000", no_analysis: true,
      output_asm: "analysis/raw-disasm/whole_linear.asm",
    });
    check(/Analysis used: none/.test(refusedOutright) && /\(legacy rendering\)/.test(refusedOutright),
      "no_analysis renders linearly and says so",
      refusedOutright.split("\n").find((l) => l.startsWith("Listing:")));
    const both = await call("disasm_raw", {
      path: "artifacts/prg/whole.bin", load_address: "C000", no_analysis: true,
      analysis_json: "artifacts/prg/whole_analysis.json",
    });
    check(/refused/.test(both) && /both/.test(both), "naming an analysis AND refusing one is a refusal, not a guess",
      both.split("\n").filter(Boolean)[2]);
  }

  // ── 3 an analysis named outright is the analysis rendered ─────────────────
  head(3, "the analysis a caller names is the analysis rendered");
  {
    // Two analyses of one PRG: the stem-matched sidecar, and one with an extra entry
    // point that makes a second routine visible. The second is named outright, with
    // NO entry_points — the call shape that used to slide it into the entry slot.
    const bytes = Buffer.alloc(0x40, 0xea);
    Buffer.from(KNOWN_CODE).copy(bytes, 0);
    // A second routine at +0x20 reachable from nothing: only a seed finds it.
    Buffer.from([0xa9, 0x2a, 0x8d, 0x21, 0xd0, 0x60]).copy(bytes, 0x20);
    const prgPath = join(proj, "artifacts", "prg", "two.prg");
    writeFileSync(prgPath, Buffer.concat([Buffer.from([0x00, 0xc0]), bytes]));
    await call("analyze_prg", { prg_path: "artifacts/prg/two.prg" });
    mkdirSync(join(proj, "analysis", "depack"), { recursive: true });
    await call("analyze_prg", {
      prg_path: "artifacts/prg/two.prg",
      output_json: "analysis/depack/two_analysis_ep.json",
      entry_points: ["C020"],
    });
    const sidecar = JSON.parse(readFileSync(join(proj, "artifacts", "prg", "two_analysis.json"), "utf8"));
    const named = JSON.parse(readFileSync(join(proj, "analysis", "depack", "two_analysis_ep.json"), "utf8"));
    const seeded = (r) => (r.entryPoints ?? []).some((e) => (e.address & 0xffff) === 0xc020);
    check(seeded(named) && !seeded(sidecar),
      "the two analyses genuinely differ — only the named one carries the $C020 entry",
      `sidecar=${seeded(sidecar)} named=${seeded(named)}`);

    const out = await call("disasm_prg", {
      prg_path: "artifacts/prg/two.prg",
      analysis_json: "analysis/depack/two_analysis_ep.json",
      output_asm: "analysis/depack/two_ep_disasm.asm",
    });
    const asmPath = /^Output: (.+)$/m.exec(out)?.[1];
    const asm = asmPath ? readFileSync(asmPath, "utf8") : "";
    check(/two_analysis_ep\.json/.test(asm),
      "the listing's header names the analysis that was passed, not the sidecar",
      asm.split("\n").find((l) => /Analysis:/.test(l))?.trim());
    check(!/artifacts\/prg\/two_analysis\.json/.test(asm),
      "…and not the stem-matched one beside the PRG");
    // Spec 866 §5 changed what happens when the named path is ABSENT. It used to be a
    // refusal, because the only alternative was a stem guess beside the PRG. There is
    // now a better answer: the project store knows which analysis is registered FOR
    // THESE BYTES — which is the half of the defect that had `extract_disk` writing its
    // analysis into a hashed payload directory while the render insisted on the path
    // beside the PRG, and a session re-running the analyser for every extracted file.
    // The swap BUG-055 killed is still killed: it is stated in the answer, by name.
    const missing = await call("disasm_prg", {
      prg_path: "artifacts/prg/two.prg",
      analysis_json: "analysis/depack/nope_analysis.json",
      output_asm: "analysis/depack/two_missing.asm",
    });
    check(/^Analysis: .*does not exist, so the project store was asked/m.test(missing),
      "an analysis named but absent is looked up in the store, not silently swapped for a stem guess",
      missing.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 140));
    check(/nope_analysis\.json/.test(missing),
      "…and the answer names the path that was asked for");
    check(/^Analysis: (two_analysis\.json|two_analysis_ep\.json) —/m.test(missing),
      "…and names the file it actually used",
      missing.split("\n").find((l) => l.startsWith("Analysis:"))?.slice(0, 80));
    // Nothing registered and nothing beside the bytes: then it IS still a refusal.
    writeFileSync(join(proj, "artifacts", "blocks", "orphan.bin"), Buffer.from(KNOWN_CODE));
    const orphan = await call("disasm_raw", {
      path: "artifacts/blocks/orphan.bin", load_address: "C000",
      analysis_json: "analysis/depack/nope_analysis.json",
    });
    check(/disasm_raw refused/.test(orphan) && /does not exist/.test(orphan) && /nothing is registered/.test(orphan),
      "a named analysis that exists nowhere, with nothing in the store either, is still a refusal",
      orphan.split("\n").filter(Boolean)[2]?.slice(0, 140));
  }

  // ── 4 disasm_raw imports what it applied ──────────────────────────────────
  head(4, "the names disasm_raw applies reach the graph");
  {
    const driveBytes = Buffer.from([
      0xad, 0x00, 0x18, 0x29, 0x01, 0x8d, 0x00, 0x18, 0xa5, 0x30, 0xe6, 0x30, 0x60,
    ]);
    writeFileSync(join(proj, "artifacts", "blocks", "stage1.bin"), driveBytes);
    writeFileSync(join(proj, "artifacts", "blocks", "stage1_annotations.json"), JSON.stringify({
      labels: [{ address: "0308", label: "buf_ptr", comment: "the buffer pointer" }],
      routines: [{ address: "0300", name: "drive_stage1", comment: "read VIA1, set data, bump" }],
    }, null, 2));
    const out = await call("disasm_raw", {
      path: "artifacts/blocks/stage1.bin", load_address: "$0300", cpu: "drive",
    });
    check(/Annotations used: .*stage1_annotations\.json/.test(out),
      "the answer names the annotations file the RENDERER read",
      out.split("\n").find((l) => l.startsWith("Annotations used:")));
    check(/\[annotations\] applied [1-9]/.test(out), "…they were applied to the listing",
      out.split("\n").find((l) => l.startsWith("[annotations]")));
    check(/^Graph: imported \d+ routines, \d+ labels/m.test(out),
      "…and imported into the knowledge graph, the same as through the PRG door",
      out.split("\n").find((l) => l.startsWith("Graph:")) ?? "no Graph line");
    const found = await call("graph_find", { query: "drive_stage1" });
    check(/drive_stage1/.test(found), "the routine name is IN the graph, not only in the listing",
      found.split("\n").slice(0, 2).join(" | "));
    const again = await call("disasm_raw", { path: "artifacts/blocks/stage1.bin", load_address: "$0300", cpu: "drive" });
    check(/^Graph: unchanged since the last import/m.test(again),
      "a second identical run says unchanged instead of importing twice",
      again.split("\n").find((l) => l.startsWith("Graph:")));
    const broken = await call("disasm_raw", {
      path: "artifacts/blocks/stage1.bin", load_address: "$0300", annotations_path: "artifacts/blocks/nope.json",
    });
    check(/refused/.test(broken) && /does not exist/.test(broken),
      "an annotations file named but absent is a refusal, not a fallback to the sidecar",
      broken.split("\n").filter(Boolean)[2]);
  }

  // ── 5 no answer carries 500 owner names ───────────────────────────────────
  head(5, "the owner list is a count, not five hundred names");
  {
    const graphPath = join(proj, "knowledge", "graph.sqlite");
    const db = new DatabaseSync(graphPath);
    let owners = 0;
    try {
      // Every NOT NULL column gets a value: an INSERT OR IGNORE that trips a
      // constraint is silently ignored, and a test that seeds nothing proves nothing.
      const info = db.prepare("PRAGMA table_info(nodes)").all();
      const needed = info.filter((c) => c.notnull === 1 || c.name === "owner");
      var seedError = "";
      if (needed.some((c) => c.name === "owner")) {
        // A plain INSERT, never OR IGNORE: a constraint violation must surface, or a
        // gate that seeded nothing reports success over an empty table.
        const stmt = db.prepare(
          `INSERT INTO nodes (${needed.map((c) => c.name).join(", ")}) `
          + `VALUES (${needed.map(() => "?").join(", ")})`,
        );
        for (let i = 0; i < 500; i += 1) {
          const value = (c) => {
            switch (c.name) {
              case "id": return `seed${i}:ram:code:${(0x1000 + i).toString(16)}`;
              case "owner": return `a_long_owner_name_number_${i}`;
              case "layer": return "generated";
              case "kind": return "code";
              case "space": return "ram";
              case "address": return 0x1000 + i;
              case "attrs": return "{}";
              case "evidence": return "[]";
              case "origin": return "static";
              case "confidence": return "certain";
              case "producer": return "820";
              default: return /INT/i.test(c.type) ? 0 : "x";
            }
          };
          try { stmt.run(...needed.map(value)); } catch (e) { seedError ||= e.message; }
        }
        owners = db.prepare("SELECT COUNT(DISTINCT owner) AS c FROM nodes WHERE owner IS NOT NULL").get().c;
      }
    } finally { db.close(); }
    if (owners < 100) {
      skip("an analysis answer does not print every seeded owner", `could not seed the graph (${owners} owners; ${seedError || "no error"})`);
      skip("…and neither does the listing header", "same");
    } else {
      const bytes = Buffer.alloc(0x20, 0xea);
      Buffer.from(KNOWN_CODE).copy(bytes, 0);
      writeFileSync(join(proj, "artifacts", "prg", "owners.prg"), Buffer.concat([Buffer.from([0x00, 0xc0]), bytes]));
      const analysed = await call("analyze_prg", { prg_path: "artifacts/prg/owners.prg" });
      const names = (analysed.match(/a_long_owner_name_number_/g) ?? []).length;
      check(names <= 3, "the analysis answer names at most a handful of owners, never all 500", `${names} names`);
      const seedLine = analysed.split("\n").find((l) => /Graph code seeds/.test(l)) ?? "";
      check(/\d{3} owners are seeded/.test(seedLine) && seedLine.length < 400,
        `…it states the count and stays one line (${seedLine.length} characters, not the ~15 000 the list is)`,
        seedLine.slice(0, 200));
      const listed = await call("disasm_prg", { prg_path: "artifacts/prg/owners.prg", analysis_json: "artifacts/prg/owners_analysis.json" });
      const asmPath = /^Output: (.+)$/m.exec(listed)?.[1];
      const asm = asmPath ? readFileSync(asmPath, "utf8") : "";
      const inHeader = (asm.match(/a_long_owner_name_number_/g) ?? []).length;
      check(inHeader <= 3, "…and neither does the listing header", `${inHeader} names in ${asmPath}`);
    }
  }

  // ── 6 a listing that cannot be reassembled says what to do ────────────────
  head(6, "an unrenderable stream says what to do about it");
  if (!HAVE_ASSEMBLER) {
    skip("the branch that wraps the address space names the remedy", `KickAssembler not found at ${KICKASS}`);
  } else {
    // The same shape a packed stream produces: a relative branch whose target wrapped
    // below $0000. The assembler refuses the distance; the message has to go further.
    writeFileSync(join(proj, "artifacts", "blocks", "packed.bin"), Buffer.from([0x10, 0x80, 0xea, 0xea, 0x60]));
    const out = await call("disasm_raw", { path: "artifacts/blocks/packed.bin", load_address: "0010" });
    check(/WARNING: rebuild/.test(out), "the rebuild is reported as failed", out.split("\n").find((l) => /rebuild/.test(l)));
    check(/probably packed/.test(out), "…named as what it is: bytes that are not code",
      out.split("\n").find((l) => /probably packed/.test(l))?.slice(0, 100) ?? "no diagnosis");
    check(/"kind":"unknown"/.test(out) && /annotations_path/.test(out),
      "…with the remedy spelled out: declare the range as data through annotations_path",
      out.split("\n").find((l) => /kind":"unknown/.test(l))?.slice(0, 120) ?? "no remedy");
    check(/try_depack|sandbox_depack/.test(out), "…and the other way on: depack first, then disassemble");
  }

  // ── the surface ───────────────────────────────────────────────────────────
  head("S", "the surface says what it does");
  {
    const tools = (await rpc("tools/list", {})).result.tools;
    const raw = tools.find((t) => t.name === "disasm_raw");
    check(!!raw?.inputSchema?.properties?.no_analysis, "disasm_raw takes no_analysis");
    check(!/\bSpec\s+\d/i.test(raw?.description ?? ""), "…and its description cites no spec number");
    check(/\bUse [a-z]/i.test(raw?.description ?? ""), "…and carries a Use-trigger");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-disasm-family: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount ? 1 : 0);
