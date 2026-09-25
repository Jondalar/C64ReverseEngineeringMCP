#!/usr/bin/env node
// Spec 877 D6, first half — ONE door writes an annotation file.
//
// Measured, from a run watched live: five subagents each invented their own
// generator (`genA.py`, `B_gen.py`, `C_gen.py`, `D_gen.py`, `E_gen.py`) to turn a
// tuple list into the annotations JSON. They did not agree on a file name, and
// they did not agree on address spelling — the merge step afterwards had to
// normalise with `s["start"].upper().lstrip("$")`.
//
// What this gate holds the door to:
//
//   W1  the door is on the DEFAULT surface — a tool not in DEFAULT_TOOLS is
//       hidden, and a writer nobody can see is a writer nobody uses.
//   W2  it writes `<stem>_annotations.json`, the one name the importer reads a
//       stem off, beside the bytes it annotates.
//   W3  one spelling comes out whatever went in: `$43a8`, `0x4300` and `4305`
//       all land as bare uppercase hex, so nothing downstream has to normalise.
//   W4  a bad entry is refused BEFORE the file exists, in the importer's own
//       terms, naming the entry — not skipped after the fact:
//         a) two segments on one start (the BUG-060 rule),
//         b) a routine with no `name`,
//         c) a name longer than the project's limit,
//         d) an output path the importer could not read a stem off.
//       Every one of these leaves NO file behind.
//   W5  the round trip: structured input in, one file out, the real importer
//       accepts it, and the listing that consumes it rebuilds byte-identical.
//
// Hermetic: a temp project, synthetic bytes, one MCP session over stdio. No
// ROMs, no media, no daemon. W5's byte-identity half needs KickAssembler and
// SKIPS LOUDLY when it is not on this machine.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:877-write

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
const skip = (msg) => console.log(`  SKIP  ${msg}`);
const head = (t) => console.log(`\n── ${t}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

console.log("Spec 877 D6 — the annotations WRITER\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-877-write-"));
const procEnv = { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" };
const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env: procEnv, stdio: ["pipe", "pipe", "pipe"] });
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
  if (r.error) return `TOOL-ERROR ${name}: ${JSON.stringify(r.error)}`;
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// The payload: a routine at $4300 that copies a table at $43A8 to the screen.
const LOAD = 0x4300;
const BODY = [
  0xa9, 0x00, 0x8d, 0x20, 0xd0,       // 4300 lda #$00 / sta $d020
  0xa2, 0x00, 0xbd, 0xa8, 0x43,       // 4305 ldx #$00 / lda $43A8,x
  0x9d, 0x00, 0x04, 0xe8, 0xd0, 0xf7, // 430A sta $0400,x / inx / bne
  0x60,                               // 4310 rts
  ...Array.from({ length: 0x97 }, () => 0xea),      // 4311..43A7 filler
  ...Array.from({ length: 0x18 }, (_, i) => i + 1), // 43A8..43BF the table
];
const writePrg = (name) => {
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  const rel = `artifacts/prg/${name}.prg`;
  writeFileSync(join(proj, rel), Buffer.from([LOAD & 0xff, LOAD >> 8, ...BODY]));
  return rel;
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-877-write", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "877-write" });
  await call("agent_onboard", {});

  // ── W1 the door is visible ───────────────────────────────────────────────
  head("W1 the door is on the default surface");
  {
    const listed = await rpc("tools/list", {});
    const names = new Set((listed.result?.tools ?? []).map((t) => t.name));
    check(names.has("write_annotations"),
      "W1 write_annotations is registered on the DEFAULT surface — a tool outside DEFAULT_TOOLS is hidden",
      names.has("write_annotations") ? "" : `${names.size} tools listed, write_annotations is not one of them`);
  }

  const rel = writePrg("core_4300");
  const annPath = join(proj, "artifacts", "prg", "core_4300_annotations.json");

  // ── W2/W3 it writes the file, in one spelling ────────────────────────────
  head("W2/W3 one file, one spelling");
  const wrote = await call("write_annotations", {
    prg_path: rel,
    // deliberately three different spellings of a hex address, as five separate
    // generators produced and the merge script then had to undo.
    segments: [{ start: "$43a8", end: "43BF", kind: "pointer_table", label: "tbl_all", comment: "screen row pointers" }],
    labels: [{ address: "0x4300", label: "core_init", comment: "cold entry" }],
    routines: [{ address: "4305", name: "copy_loop", comment: "copies the table to $0400" }],
  });
  check(existsSync(annPath),
    "W2 the file lands at <stem>_annotations.json beside the bytes — the one name the importer reads a stem off",
    existsSync(annPath) ? "" : `not written; the door answered:\n${wrote.split("\n").slice(0, 6).join("\n")}`);
  if (!existsSync(annPath)) {
    console.log(`\nRED  Spec 877 D6 writer: ${pass} pass, ${failCount + 1} fail (nothing to check past W2).`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(annPath, "utf8"));
  check(doc.segments?.[0]?.start === "43A8" && doc.labels?.[0]?.address === "4300" && doc.routines?.[0]?.address === "4305",
    "W3 `$43a8`, `0x4300` and `4305` all come out as bare uppercase hex — nothing downstream has to normalise",
    JSON.stringify({ seg: doc.segments?.[0]?.start, lbl: doc.labels?.[0]?.address, rt: doc.routines?.[0]?.address }));
  check(doc.version === 1 && typeof doc.binary === "string" && doc.binary.includes("core_4300"),
    "W3 …and the file carries the version + which bytes it annotates",
    JSON.stringify({ version: doc.version, binary: doc.binary }));
  check(/\bcore_4300_annotations\.json\b/.test(wrote) && /1 segment/.test(wrote) && /1 label/.test(wrote) && /1 routine/.test(wrote),
    "W2 …and the answer names the path it wrote and what went into it",
    wrote.split("\n").filter(Boolean).slice(0, 4).join("\n"));

  // ── W4 a bad entry is refused before the file exists ─────────────────────
  head("W4 refused on the way in, not skipped afterwards");
  const gone = (p) => !existsSync(join(proj, "artifacts", "prg", p));

  {
    const out = await call("write_annotations", {
      output_path: "artifacts/prg/dup_annotations.json",
      binary: "dup.prg",
      segments: [
        { start: "43A8", end: "43AF", kind: "data", label: "tbl_lo" },
        { start: "43A8", end: "43BF", kind: "pointer_table", label: "tbl_all" },
      ],
      labels: [], routines: [],
    });
    check(/refus/i.test(out), "W4a two segments on one start are REFUSED", out.split("\n").filter(Boolean).slice(0, 2).join("\n"));
    check(/43A8/i.test(out) && /43AF/i.test(out) && /43BF/i.test(out) && /tbl_lo/.test(out) && /tbl_all/.test(out),
      "W4a …naming BOTH entries — one start, each of the two ends, both labels",
      out.split("\n").filter((l) => /43A8|tbl_/i.test(l)).slice(0, 4).join("\n"));
    check(gone("dup_annotations.json"), "W4a …and no file is left behind for the importer to choke on later");
  }

  {
    const out = await call("write_annotations", {
      output_path: "artifacts/prg/noname_annotations.json",
      binary: "noname.prg",
      segments: [], labels: [],
      routines: [{ address: "4305", comment: "a routine entry that forgot the one required field" }],
    });
    check(/refus/i.test(out) && /4305/i.test(out) && /name/i.test(out),
      "W4b a routine with no `name` is refused, by address and by the field it is missing",
      out.split("\n").filter(Boolean).slice(0, 4).join("\n"));
    check(gone("noname_annotations.json"), "W4b …and nothing is written");
  }

  {
    const long = "a_very_long_routine_name_indeed";
    const out = await call("write_annotations", {
      output_path: "artifacts/prg/toolong_annotations.json",
      binary: "toolong.prg",
      segments: [], labels: [],
      routines: [{ address: "4305", name: long }],
    });
    check(/refus/i.test(out) || /longer than 20/.test(out),
      "W4c a name past the project's limit is refused HERE — `disasm` refuses such a file, so writing one is writing a dud",
      out.split("\n").filter(Boolean).slice(0, 4).join("\n"));
    check(out.includes(long), "W4c …and the refusal quotes the offending name", out.split("\n").find((l) => l.includes(long)) ?? "");
    check(gone("toolong_annotations.json"), "W4c …and nothing is written");
  }

  {
    const out = await call("write_annotations", {
      output_path: "artifacts/prg/core.json",
      binary: "core.prg",
      segments: [], labels: [{ address: "4300", label: "core_init" }], routines: [],
    });
    check(/refus/i.test(out) && /_annotations\.json/.test(out),
      "W4d an output path the importer cannot read a stem off is refused, naming the shape it needs",
      out.split("\n").filter(Boolean).slice(0, 3).join("\n"));
    check(gone("core.json"), "W4d …and nothing is written");
  }

  // ── W5 the round trip ────────────────────────────────────────────────────
  head("W5 the round trip: written here, accepted there");
  await call("analyze_prg", { prg_path: rel, entry_points: ["4300"] });
  const listing = await call("disasm_prg", { prg_path: rel });
  check(!/refus/i.test(listing),
    "W5 the listing door accepts the file this writer produced",
    listing.split("\n").filter(Boolean).slice(0, 3).join("\n"));
  check(/Graph: imported 1 routines?, 1 labels?, 1 segments?/.test(listing),
    "W5 …the real importer takes all three entries into the graph",
    listing.split("\n").find((l) => l.startsWith("Graph:")) ?? "(no Graph: line)");
  check(!/Annotations import: FAILED/.test(listing),
    "W5 …with no import failure hiding under a green verdict",
    listing.split("\n").find((l) => /Annotations import/.test(l)) ?? "");
  check(/\[annotations\] applied \d+, skipped 0/.test(listing) || !/skipped [1-9]/.test(listing),
    "W5 …and nothing is tolerantly skipped — the writer refused what would have been skipped",
    listing.split("\n").find((l) => /\[annotations\]/.test(l)) ?? "");
  const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
  if (!existsSync(jar)) {
    skip(`W5 byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — skipped, not passed`);
  } else {
    check(/rebuild verified byte-identical/.test(listing),
      "W5 …and the listing that consumes it rebuilds byte-identical",
      listing.split("\n").find((l) => /rebuild/.test(l)) ?? "(no rebuild line)");
  }
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  the gate itself could not run: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  proc.kill();
}

console.log(`\nproject: ${proj}`);
console.log(`${failCount ? "RED" : "GREEN"}  Spec 877 D6 writer: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
