#!/usr/bin/env node
// BUG-060 defect 2 — two annotation segments that share a start address.
//
// An autonomous run's answer carried one line, below a green rebuild verdict:
//
//   Annotations import: FAILED — migration_log: annotations:s1_t01s02_core_4300/segment:43a8 logged twice
//
// The listing rebuilt byte-identical, so every other signal said the call had
// worked. It had not: the graph got NOTHING. The importer keys a segment row on
// its START address (`segment:<hex4>`), two entries sharing a start produce one
// id twice, and the ledger throws on the second — after which the whole import
// is rolled back. The contradiction was in the FILE, two entries claiming one
// address, and nothing looked at it until the graph was already half written.
//
// What this gate holds the doors to:
//
//   D2a  the file is REFUSED at parse time, before anything is rendered, and
//        the refusal names the offending PAIR — both segments, both starts,
//        both ends — not an id in a migration log.
//   D2b  the refusal reaches the caller, where the caller is looking: the
//        tool's answer, not a line under a green verdict.
//   D2c  no listing is produced that claims a rebuild while the graph got
//        nothing — the half-success that hid this for a whole run.
//   D2d  the graph importer, called on such a file directly, names the same
//        pair instead of dying with `migration_log: … logged twice`.
//   D2e  CONTROL: distinct starts — including two segments that OVERLAP — still
//        render, still rebuild, and still import.
//
// Hermetic: a temp project, synthetic bytes, one MCP session over stdio. No
// ROMs, no media, no daemon. The rebuild half of the control needs no
// assembler: the door reports its own verdict.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:bug060-dup-segment

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `\n          ${String(detail).replace(/\n/g, "\n          ")}` : ""}`);
};
const head = (t) => console.log(`\n── ${t}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("BUG-060 defect 2 — two annotation segments on one start address\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-bug060-dup-"));
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

// The payload: a small routine at $4300, then a table the human classifies.
const LOAD = 0x4300;
const BODY = [
  0xa9, 0x00, 0x8d, 0x20, 0xd0,       // 4300 lda #$00 / sta $d020
  0xa2, 0x00, 0xbd, 0xa8, 0x43,       // 4305 ldx #$00 / lda $43A8,x
  0x9d, 0x00, 0x04, 0xe8, 0xd0, 0xf7, // 430A sta $0400,x / inx / bne
  0x60,                               // 4310 rts
  ...Array.from({ length: 0x97 }, () => 0xea), // 4311..43A7 filler
  ...Array.from({ length: 0x18 }, (_, i) => i + 1), // 43A8..43BF the table
];

// Two entries, one start. Different ends and different kinds, so the file is a
// contradiction and not a harmless repeat.
const DUPLICATE = {
  segments: [
    { start: "43A8", end: "43AF", kind: "data", label: "tbl_lo" },
    { start: "43A8", end: "43BF", kind: "pointer_table", label: "tbl_all" },
  ],
  labels: [{ address: "4300", label: "core_init" }],
  routines: [],
};

// The control: distinct starts, and deliberately OVERLAPPING, because an
// overlap is legal (Spec 055 reshapes across boundaries) and a rule that
// refuses it would cost far more than this defect did.
const DISTINCT = {
  segments: [
    { start: "43A8", end: "43BF", kind: "data", label: "tbl_all" },
    { start: "43B0", end: "43BF", kind: "pointer_table", label: "tbl_hi" },
  ],
  labels: [{ address: "4300", label: "core_init" }],
  routines: [],
};

const writePrg = (name) => {
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const rel = `artifacts/prg/${name}.prg`;
  writeFileSync(join(proj, rel), Buffer.from([LOAD & 0xff, LOAD >> 8, ...BODY]));
  return rel;
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-bug060", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "bug060-dup" });
  await call("agent_onboard", {});

  // ── the contradiction ────────────────────────────────────────────────────
  head("two segments, one start");
  const rel = writePrg("core_4300");
  const annPath = join(proj, "artifacts", "prg", "core_4300_annotations.json");
  writeFileSync(annPath, JSON.stringify(DUPLICATE, null, 2));
  await call("analyze_prg", { prg_path: rel, entry_points: ["4300"] });
  const out = await call("disasm_prg", { prg_path: rel });

  // D2a — the pair is named, both ends of it.
  check(/\$?43A8/i.test(out) && /\$?43AF/i.test(out) && /\$?43BF/i.test(out),
    "D2a the refusal names BOTH segments — one start, and each of the two ends",
    out.split("\n").filter((l) => /43A8/i.test(l)).slice(0, 3).join("\n") || "(no line mentions $43A8)");
  check(/tbl_lo/.test(out) && /tbl_all/.test(out),
    "D2a …and names them the way the file does, so the offending lines are findable",
    out.split("\n").filter((l) => /tbl_/.test(l)).slice(0, 3).join("\n") || "(neither label is quoted back)");

  // D2b — loud where the caller is looking.
  check(/refused/i.test(out),
    "D2b the answer is a refusal, not a green verdict with a footnote",
    out.split("\n").filter(Boolean).slice(0, 2).join("\n"));
  check(!/logged twice/.test(out) && !/migration_log/.test(out),
    "D2b …and never an internal id crash out of the migration log",
    /.*(logged twice|migration_log).*/.exec(out)?.[0] ?? "");

  // D2c — nothing half-written: no listing claiming a rebuild the graph never saw.
  check(!/rebuild verified byte-identical/.test(out),
    "D2c no rebuild verdict is reported for a file that was never applied",
    /.*rebuild verified.*/.exec(out)?.[0] ?? "");
  check(!existsSync(join(proj, "artifacts", "prg", "core_4300_disasm.asm")),
    "D2c …and no listing is left on disk to be believed later",
    existsSync(join(proj, "artifacts", "prg", "core_4300_disasm.asm"))
      ? "artifacts/prg/core_4300_disasm.asm was written from a file the graph rejected"
      : "");

  // D2d — the importer, reached directly, says the same thing.
  head("the graph importer, called on the same file");
  {
    const { importAnnotationFile } = await import(join(ROOT, "dist/knowledge-graph/migrate/migrate.js"));
    let message = "";
    try {
      importAnnotationFile(annPath, { projectDir: proj });
      message = "(it did not refuse at all)";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    check(/43A8/i.test(message) && /43AF/i.test(message) && /43BF/i.test(message),
      "D2d the importer names the pair",
      message);
    check(!/logged twice/.test(message),
      "D2d …instead of the duplicate-id crash the run actually got",
      message);
  }

  // ── the control ──────────────────────────────────────────────────────────
  head("CONTROL: distinct starts, overlapping ranges");
  {
    const rel2 = writePrg("core_4300b");
    writeFileSync(join(proj, "artifacts", "prg", "core_4300b_annotations.json"), JSON.stringify(DISTINCT, null, 2));
    await call("analyze_prg", { prg_path: rel2, entry_points: ["4300"] });
    const ok = await call("disasm_prg", { prg_path: rel2 });
    check(!/refused/i.test(ok),
      "D2e overlapping segments with distinct starts are not refused",
      ok.split("\n").filter(Boolean).slice(0, 2).join("\n"));
    check(/Graph: imported \d+ routines, \d+ labels, [1-9]\d* segments/.test(ok),
      "D2e …and their segments reach the graph",
      ok.split("\n").find((l) => l.startsWith("Graph:")) ?? "(no Graph: line)");
    check(!/Annotations import: FAILED/.test(ok),
      "D2e …with no import failure",
      ok.split("\n").find((l) => /Annotations import/.test(l)) ?? "");
  }
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  the gate itself could not run: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  proc.kill();
}

console.log(`\nproject: ${proj}`);
console.log(`${failCount ? "RED" : "GREEN"}  BUG-060 defect 2: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
