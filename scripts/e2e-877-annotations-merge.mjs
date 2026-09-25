#!/usr/bin/env node
// Spec 877 D6, second half — ONE door merges fragments, and the judgement survives.
//
// Measured, from a run watched live: five subagents each produced a fragment, and the
// script that combined them carried the JUDGEMENTS as Python literals in a scratchpad
// that dies with the session —
//
//     order   = ["C","D","B","E","A"]      # whose reading wins a tie
//     segpref = {"82E6": "E"}              # two agents disagreed here; E won
//     rename  = {("D","64BF"): "exit_door_probe"}
//
// Who was right at $82E6 and why is exactly what the project exists to remember. It was
// lost. The graph received the merged result and never learned the merge was contested.
//
// What this gate holds the door to:
//
//   M1  the door is on the DEFAULT surface.
//   M2  CONTROL: two fragments saying the SAME thing merge without a word. Five readers
//       annotating one entry point is normal and is not a contradiction.
//   M3  a contradiction is REFUSED by naming BOTH sides — which fragment claimed what —
//       and nothing is written and nothing is recorded.
//   M4  a resolution resolves it: the winner's claim is in the file, the loser's is not.
//   M5  and the resolution is RECORDED as a finding in the project: who claimed what,
//       which one won, and why. This is the whole point of the door.
//   M6  a resolution for a key nothing disputes is refused, and so is a winner that
//       claimed nothing — a judgement about a dispute that does not exist is rot.
//   M7  resolving one of two contradictions still refuses, naming only the other.
//   M8  a resolution may name a value NEITHER fragment proposed (the `rename` table).
//   M9  one spelling comes out whatever the fragments used.
//   M10 the round trip: fragments in, one file out, the real importer accepts it, and
//       the listing that consumes it rebuilds byte-identical.
//   M11 dry_run reports and writes nothing — not the file, not the findings.
//
// Hermetic: a temp project, synthetic bytes, one MCP session over stdio. The
// byte-identity half of M10 needs KickAssembler and SKIPS LOUDLY without it.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:877-merge

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

console.log("Spec 877 D6 — the annotations MERGER\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-877-merge-"));
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
  if (r.error) return `TOOL-ERROR ${name}: ${JSON.stringify(r.error)}`;
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// The payload: a copy loop at $8200 reading a table at $82E6.
//
//   8200  a9 00      lda #$00
//   8202  8d 20 d0   sta $d020
//   8205  a2 00      ldx #$00        <- copy_loop
//   8207  bd e6 82   lda $82E6,x     <- the indexed instruction the dispute is about
//   820A  9d 00 04   sta $0400,x
//   820D  e8         inx
//   820E  d0 f7      bne $8207
//   8210  60         rts             <- the address A and C disagree about
//   8211..82E5       filler
//   82E6..8305       the table
const LOAD = 0x8200;
const BODY = [
  0xa9, 0x00, 0x8d, 0x20, 0xd0,
  0xa2, 0x00, 0xbd, 0xe6, 0x82,
  0x9d, 0x00, 0x04, 0xe8, 0xd0, 0xf7,
  0x60,
  ...Array.from({ length: 0xd5 }, () => 0xea),
  ...Array.from({ length: 0x20 }, (_, i) => i + 1),
];
mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
const PRG = "artifacts/prg/core_8200.prg";
writeFileSync(join(proj, PRG), Buffer.from([LOAD & 0xff, LOAD >> 8, ...BODY]));
const MERGED = join(proj, "artifacts", "prg", "core_8200_annotations.json");

// The five readings, deliberately spelling addresses three different ways.
const FRAG_A = {
  name: "A",
  labels: [{ address: "8200", label: "core_init" }, { address: "8210", label: "exit_probe" }],
  routines: [{ address: "$8205", name: "copy_loop", comment: "copies the table to $0400" }],
};
const FRAG_B = {
  name: "B",
  // the same claim A made, word for word: normal, and not a contradiction
  labels: [{ address: "$8200", label: "core_init" }],
};
const FRAG_C = {
  name: "C",
  labels: [{ address: "0x8210", label: "door_probe" }],
};
const FRAG_D = {
  name: "D",
  segments: [{ start: "82e6", end: "82F5", kind: "data", label: "score_tbl", comment: "16 score digits" }],
};
const FRAG_E = {
  name: "E",
  segments: [{ start: "$82E6", end: "0x8305", kind: "pointer_table", label: "score_ptrs", comment: "32 bytes read by the loop at $8207" }],
};

const WHY_SEG = "the loop at $8207 runs x to $1F, so the range is 32 bytes, not 16";
const WHY_LBL = "both readings are half of it: the rts is reached from the door probe AND the exit";

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-877-merge", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "877-merge" });
  await call("agent_onboard", {});

  // ── M1 ───────────────────────────────────────────────────────────────────
  head("M1 the door is on the default surface");
  {
    const listed = await rpc("tools/list", {});
    const names = new Set((listed.result?.tools ?? []).map((t) => t.name));
    check(names.has("merge_annotations"),
      "M1 merge_annotations is registered on the DEFAULT surface",
      names.has("merge_annotations") ? "" : `${names.size} tools listed, merge_annotations is not one of them`);
  }

  // ── M2 CONTROL: agreement is not a contradiction ─────────────────────────
  head("M2 CONTROL: two fragments saying the same thing");
  {
    const out = await call("merge_annotations", {
      output_path: "artifacts/prg/agree_annotations.json",
      binary: "agree.prg",
      fragments: [FRAG_A, FRAG_B],
    });
    check(!/refus/i.test(out),
      "M2 A and B both name $8200 `core_init` — one claim, twice, merges without a word",
      out.split("\n").filter(Boolean).slice(0, 3).join("\n"));
    const merged = existsSync(join(proj, "artifacts/prg/agree_annotations.json"))
      ? JSON.parse(readFileSync(join(proj, "artifacts/prg/agree_annotations.json"), "utf8")) : { labels: [] };
    check(merged.labels?.filter((l) => l.address === "8200").length === 1,
      "M2 …and the agreed claim appears ONCE in the file, not twice",
      JSON.stringify(merged.labels ?? []));
  }

  // ── M3 the refusal ───────────────────────────────────────────────────────
  head("M3 a contradiction is refused by naming both sides");
  let refusal = "";
  {
    refusal = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
    });
    check(/refus/i.test(refusal), "M3 the merge is REFUSED", refusal.split("\n").filter(Boolean).slice(0, 2).join("\n"));
    check(/segment:82E6/i.test(refusal) && /label:8210/i.test(refusal),
      "M3 …and every contested key is named, by the key a resolution takes",
      refusal.split("\n").filter((l) => /82E6|8210/i.test(l)).slice(0, 6).join("\n"));
    check(/\bD\b/.test(refusal) && /\bE\b/.test(refusal) && /score_tbl/.test(refusal) && /score_ptrs/.test(refusal),
      "M3 …naming BOTH claimants at $82E6 and what each of them claimed",
      refusal.split("\n").filter((l) => /score_/.test(l)).slice(0, 4).join("\n"));
    check(/exit_probe/.test(refusal) && /door_probe/.test(refusal),
      "M3 …and both names offered for $8210",
      refusal.split("\n").filter((l) => /_probe/.test(l)).slice(0, 4).join("\n"));
    check(/resolutions/.test(refusal) && /why/.test(refusal),
      "M3 …and says how to resolve it, including that a reason is required",
      refusal.split("\n").filter((l) => /resolutions|why/.test(l)).slice(0, 4).join("\n"));
    check(!existsSync(MERGED), "M3 …nothing is written", existsSync(MERGED) ? "the merged file exists after a refusal" : "");
    const findings = await call("list_findings", {});
    check(/No findings matched/.test(findings) || !/82E6/i.test(findings),
      "M3 …and nothing is recorded — a refused merge makes no judgement to remember",
      findings.split("\n").slice(0, 3).join("\n"));
  }

  // ── M6 a resolution nothing disputes ─────────────────────────────────────
  head("M6 a judgement about a dispute that does not exist");
  {
    const out = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
      resolutions: [
        { key: "segment:82E6", winner: "E", why: WHY_SEG },
        { key: "label:8210", winner: "A", why: WHY_LBL },
        { key: "label:8200", winner: "A", why: "nobody disagreed about this one" },
      ],
    });
    check(/refus/i.test(out) && /label:8200/.test(out),
      "M6 a resolution for an uncontested key is refused, naming it",
      out.split("\n").filter((l) => /8200/.test(l)).slice(0, 3).join("\n"));
    check(!existsSync(MERGED), "M6 …and nothing is written");
  }
  {
    const out = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
      resolutions: [
        { key: "segment:82E6", winner: "B", why: WHY_SEG },
        { key: "label:8210", winner: "A", why: WHY_LBL },
      ],
    });
    check(/refus/i.test(out) && /\bB\b/.test(out) && /\bD\b/.test(out) && /\bE\b/.test(out),
      "M6b a winner that claimed nothing there is refused, naming who actually claimed it",
      out.split("\n").filter((l) => /82E6|claimant|claimed/i.test(l)).slice(0, 4).join("\n"));
    check(!existsSync(MERGED), "M6b …and nothing is written");
  }

  // ── M7 half-resolved is still refused ────────────────────────────────────
  head("M7 one of two resolved");
  {
    const out = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
      resolutions: [{ key: "segment:82E6", winner: "E", why: WHY_SEG }],
    });
    check(/refus/i.test(out) && /label:8210/.test(out) && !/segment:82E6/.test(out),
      "M7 the one still open is named and the one already settled is not repeated",
      out.split("\n").filter((l) => /82E6|8210/.test(l)).slice(0, 4).join("\n"));
    check(!existsSync(MERGED), "M7 …and nothing is written");
  }

  // ── M3b one name at two addresses ────────────────────────────────────────
  //
  // The other contradictions are two claims about one address. This one is the
  // opposite and is the only annotation defect that fails in the ASSEMBLER rather than
  // quietly in the listing, so it is its own contest — and resolving it must take the
  // name away from the losing SITE only, not from whatever else sits at that address.
  head("M3b one name at two addresses");
  const NAME_OUT = join(proj, "artifacts", "prg", "namefight_annotations.json");
  const FRAG_F = { name: "F", labels: [{ address: "8205", label: "core_init" }] };
  {
    const out = await call("merge_annotations", {
      output_path: "artifacts/prg/namefight_annotations.json",
      binary: "core_8200.prg",
      fragments: [FRAG_A, FRAG_F],
    });
    check(/refus/i.test(out) && /name:core_init/.test(out),
      "M3b one identifier at two addresses is its own contest, keyed by the name",
      out.split("\n").filter((l) => /core_init/.test(l)).slice(0, 4).join("\n"));
    check(/label \$8200/.test(out) && /label \$8205/.test(out),
      "M3b …naming both sites and which fragment put the name there",
      out.split("\n").filter((l) => /\$820/.test(l)).slice(0, 4).join("\n"));
    const ok2 = await call("merge_annotations", {
      output_path: "artifacts/prg/namefight_annotations.json",
      binary: "core_8200.prg",
      fragments: [FRAG_A, FRAG_F],
      resolutions: [{ key: "name:core_init", winner: "A", why: "$8200 is the load address and the cold entry; $8205 is the loop head" }],
    });
    check(!/refus/i.test(ok2) && existsSync(NAME_OUT), "M3b picking the site that keeps the name resolves it",
      ok2.split("\n").filter(Boolean).slice(0, 3).join("\n"));
    if (existsSync(NAME_OUT)) {
      const nf = JSON.parse(readFileSync(NAME_OUT, "utf8"));
      check((nf.labels ?? []).length === 2 && !(nf.labels ?? []).some((l) => l.address === "8205"),
        "M3b …F's label at $8205 is dropped, A's at $8200 kept",
        JSON.stringify(nf.labels ?? []));
      check((nf.routines ?? []).some((r) => r.address === "8205" && r.name === "copy_loop"),
        "M3b …and the ROUTINE that happens to sit at $8205 is untouched — the contest was about a name, not an address",
        JSON.stringify(nf.routines ?? []));
    }
  }

  // ── M11 dry run ──────────────────────────────────────────────────────────
  head("M11 dry run");
  {
    const out = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
      resolutions: [
        { key: "segment:82E6", winner: "E", why: WHY_SEG },
        { key: "label:8210", value: { label: "exit_door_probe" }, why: WHY_LBL },
      ],
      dry_run: true,
    });
    check(!/refus/i.test(out) && /\b2\b/.test(out),
      "M11 a dry run reports the merge it would make",
      out.split("\n").filter(Boolean).slice(0, 4).join("\n"));
    check(!existsSync(MERGED), "M11 …and writes no file");
    const findings = await call("list_findings", {});
    check(/No findings matched/.test(findings) || !/82E6/i.test(findings),
      "M11 …and records no finding — a dry run decides nothing",
      findings.split("\n").slice(0, 3).join("\n"));
  }

  // ── M4/M8/M9 the merge ───────────────────────────────────────────────────
  head("M4/M8/M9 the resolved merge");
  let merged = {};
  {
    const out = await call("merge_annotations", {
      prg_path: PRG,
      fragments: [FRAG_A, FRAG_B, FRAG_C, FRAG_D, FRAG_E],
      resolutions: [
        { key: "segment:82E6", winner: "E", why: WHY_SEG },
        // the scratchpad's `rename` table: a value NEITHER side proposed
        { key: "label:8210", value: { label: "exit_door_probe" }, why: WHY_LBL },
      ],
    });
    check(!/refus/i.test(out) && existsSync(MERGED),
      "M4 with both resolutions the merge is written",
      out.split("\n").filter(Boolean).slice(0, 4).join("\n"));
    if (!existsSync(MERGED)) {
      console.log(`\nRED  Spec 877 D6 merger: ${pass} pass, ${failCount + 1} fail (nothing to check past M4).`);
      process.exit(1);
    }
    merged = JSON.parse(readFileSync(MERGED, "utf8"));
    const seg = (merged.segments ?? []).filter((s) => s.start === "82E6");
    check(seg.length === 1 && seg[0].kind === "pointer_table" && seg[0].end === "8305",
      "M4 E's reading of $82E6 is what the file carries — one entry, the winner's",
      JSON.stringify(seg));
    check(!JSON.stringify(merged).includes("score_tbl"),
      "M4 …and D's losing claim is not also in there, quietly overlaying it",
      JSON.stringify(merged.segments ?? []));
    const lbl = (merged.labels ?? []).filter((l) => l.address === "8210");
    check(lbl.length === 1 && lbl[0].label === "exit_door_probe",
      "M8 a resolution may name a value neither fragment proposed — the `rename` table, as an argument",
      JSON.stringify(lbl));
    check((merged.segments ?? []).every((s) => /^[0-9A-F]{4,}$/.test(s.start) && /^[0-9A-F]{4,}$/.test(s.end))
      && (merged.labels ?? []).every((l) => /^[0-9A-F]{4,}$/.test(l.address))
      && (merged.routines ?? []).every((r) => /^[0-9A-F]{4,}$/.test(r.address)),
      "M9 `82e6`, `$82E6` and `0x8210` all come out as bare uppercase hex — the merge normalises nothing afterwards",
      JSON.stringify({ segs: (merged.segments ?? []).map((s) => s.start), lbls: (merged.labels ?? []).map((l) => l.address) }));
  }

  // ── M5 the judgement is in the project ───────────────────────────────────
  head("M5 who was right at $82E6, and why");
  {
    const findings = await call("list_findings", {});
    const line = findings.split("\n").find((l) => /82E6/i.test(l));
    check(!!line, "M5 a finding exists for the contested segment", findings.split("\n").slice(0, 6).join("\n"));
    if (line) {
      const id = line.split("|")[0].trim();
      const rec = await call("read_finding", { id });
      check(/\bD\b/.test(rec) && /score_tbl/.test(rec) && /82F5/i.test(rec),
        "M5 the record says what D claimed — the LOSING reading survives, which is the point",
        rec.split("\n").filter((l) => /D|score_tbl/.test(l)).slice(0, 4).join("\n"));
      check(/\bE\b/.test(rec) && /score_ptrs/.test(rec) && /8305/i.test(rec),
        "M5 …and what E claimed",
        rec.split("\n").filter((l) => /score_ptrs/.test(l)).slice(0, 3).join("\n"));
      check(/won|winner|WON/i.test(rec) && /score_ptrs/.test(rec),
        "M5 …and which one won",
        rec.split("\n").filter((l) => /won|winner/i.test(l)).slice(0, 3).join("\n"));
      check(rec.includes(WHY_SEG),
        "M5 …and WHY, in the words the caller gave — the `segpref = {\"82E6\": \"E\"}` that used to die with the session",
        rec.split("\n").filter((l) => /\$8207/.test(l)).slice(0, 3).join("\n"));
    }
    const line2 = findings.split("\n").find((l) => /8210/i.test(l));
    check(!!line2, "M5 …and the renamed label got its own record", findings.split("\n").slice(0, 8).join("\n"));
    if (line2) {
      const rec2 = await call("read_finding", { id: line2.split("|")[0].trim() });
      check(/exit_probe/.test(rec2) && /door_probe/.test(rec2) && /exit_door_probe/.test(rec2) && rec2.includes(WHY_LBL),
        "M5 …naming both rejected readings, the name that replaced them, and why",
        rec2.split("\n").filter((l) => /probe/.test(l)).slice(0, 5).join("\n"));
    }
  }

  // ── M10 the round trip ───────────────────────────────────────────────────
  head("M10 the round trip: merged here, accepted there");
  await call("analyze_prg", { prg_path: PRG, entry_points: ["8200"] });
  const listing = await call("disasm_prg", { prg_path: PRG });
  check(!/refus/i.test(listing),
    "M10 the listing door accepts the merged file",
    listing.split("\n").filter(Boolean).slice(0, 3).join("\n"));
  check(/Graph: imported \d+ routines?, \d+ labels?, [1-9]\d* segments?/.test(listing),
    "M10 …the real importer takes it into the graph",
    listing.split("\n").find((l) => l.startsWith("Graph:")) ?? "(no Graph: line)");
  check(!/Annotations import: FAILED/.test(listing),
    "M10 …with no import failure hiding under a green verdict",
    listing.split("\n").find((l) => /Annotations import/.test(l)) ?? "");
  const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
  if (!existsSync(jar)) {
    skip(`M10 byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — skipped, not passed`);
  } else {
    check(/rebuild verified byte-identical/.test(listing),
      "M10 …and the listing rebuilds byte-identical",
      listing.split("\n").find((l) => /rebuild/.test(l)) ?? "(no rebuild line)");
  }
} catch (e) {
  failCount += 1;
  console.log(`  FAIL  the gate itself could not run: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  proc.kill();
}

console.log(`\nproject: ${proj}`);
console.log(`${failCount ? "RED" : "GREEN"}  Spec 877 D6 merger: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
