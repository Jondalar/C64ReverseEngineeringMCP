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
  await call("project_init", { preferred_assembler: "kickass", name: "877-merge" });
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
  const FRAG_F = { name: "F", labels: [{ address: "8220", label: "core_init" }] };
  {
    const out = await call("merge_annotations", {
      output_path: "artifacts/prg/namefight_annotations.json",
      binary: "core_8200.prg",
      fragments: [FRAG_A, FRAG_F],
    });
    check(/refus/i.test(out) && /name:core_init/.test(out),
      "M3b one identifier at two addresses is its own contest, keyed by the name",
      out.split("\n").filter((l) => /core_init/.test(l)).slice(0, 4).join("\n"));
    check(/label \$8200/.test(out) && /label \$8220/.test(out),
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
      check((nf.labels ?? []).length === 2 && !(nf.labels ?? []).some((l) => l.address === "8220"),
        "M3b …F's label at $8220 is dropped, A's at $8200 kept",
        JSON.stringify(nf.labels ?? []));
      check((nf.routines ?? []).some((r) => r.address === "8205" && r.name === "copy_loop"),
        "M3b …and the routine at $8205 is untouched — the contest was about one name, not about every record near it",
        JSON.stringify(nf.routines ?? []));
    }
  }

  // ── N: the identity model ────────────────────────────────────────────────
  //
  // One address carries one name, one name lives at one address — across a segment's
  // label, labels[], routines[] and the immediates that point at them.
  const nout = (n) => join(proj, "artifacts", "prg", `${n}_annotations.json`);
  const mergeTo = (n, fragments, resolutions, extra = {}) => call("merge_annotations", {
    output_path: `artifacts/prg/${n}_annotations.json`, binary: "core_8200.prg", fragments, ...(resolutions ? { resolutions } : {}), ...extra,
  });
  const readOut = (n) => (existsSync(nout(n)) ? JSON.parse(readFileSync(nout(n), "utf8")) : null);

  head("N1 the same name at the same address is one claim (segment label / label / routine)");
  {
    const frag1 = { name: "P", segments: [{ start: "8205", end: "820F", kind: "code", label: "advance_anim", comment: "range comment" }],
      labels: [{ address: "8205", label: "advance_anim" }], routines: [{ address: "8205", name: "advance_anim", comment: "steps the frame" }] };
    const frag2 = { name: "Q", labels: [{ address: "$8205", label: "advance_anim", comment: "from Q" }], routines: [{ address: "8205", name: "advance_anim" }] };
    const out = await mergeTo("n1", [frag1, frag2]);
    check(!/refus/i.test(out) && existsSync(nout("n1")), "N1 the mix collapses without a word", out.split("\n").slice(0, 4).join(" | "));
    const m = readOut("n1");
    check(m && m.routines.length === 1 && m.routines[0].name === "advance_anim" && m.segments.length === 1 && m.segments[0].label === "advance_anim",
      "N1 …one routine, the segment keeps its label", JSON.stringify(m));
    check(m && m.labels.length === 1 && m.labels[0].comment === "from Q",
      "N1 …a label stays only where it carries prose of its own", JSON.stringify(m?.labels));
    // a single fragment, written on its own and merged on a second pass: no "already defined"
    const w = await call("write_annotations", { output_path: "artifacts/prg/n1w_annotations.json", binary: "core_8200.prg", ...frag1 });
    check(!/REFUSED/.test(w), "N1 write_annotations takes a label and a routine that repeat one name at one address", w.split("\n")[0]);
    const again = await mergeTo("n1b", [{ name: "pass1", path: nout("n1") }, { name: "pass2", path: nout("n1w") }]);
    check(!/refus|already defined/i.test(again) && existsSync(nout("n1b")), "N1 …and a second pass over the merged file is accepted", again.split("\n").slice(0, 4).join(" | "));
    const dup = await call("write_annotations", { output_path: "artifacts/prg/n1x_annotations.json", binary: "core_8200.prg",
      labels: [{ address: "8205", label: "same_name" }, { address: "8210", label: "same_name" }] });
    check(/REFUSED/.test(dup) && /already defined/.test(dup), "N1 CONTROL: one name at two addresses is still refused by the writer", dup.split("\n").slice(0, 3).join(" | "));
  }

  head("N2 two names at one address (label vs routine) are refused, resolved, and can be deleted");
  {
    const L = { name: "L", labels: [{ address: "8207", label: "kill_bit_locate_loop", comment: "loop head" }] };
    const R = { name: "R", routines: [{ address: "8207", name: "door_link_request", comment: "asks the door" }] };
    const out = await mergeTo("n2", [L, R]);
    check(/refus/i.test(out) && /label:8207/.test(out) && /label "kill_bit_locate_loop"/.test(out) && /routine "door_link_request"/.test(out),
      "N2 label vs routine at one address is a contradiction, naming both records", out.split("\n").filter((l) => /8207|kill|door/.test(l)).slice(0, 5).join(" | "));
    check(!existsSync(nout("n2")), "N2 …and nothing is written");
    const win = await mergeTo("n2", [L, R], [{ key: "label:8207", winner: "R", why: "the routine name says what it does" }]);
    const m = readOut("n2");
    check(!/refus/i.test(win) && m && m.labels.length === 0 && m.routines.length === 1 && m.routines[0].name === "door_link_request",
      "N2 the routine wins: the stale label is gone from the file", JSON.stringify(m) + win.split("\n")[0]);
    check(m && /asks the door/.test(m.routines[0].comment ?? "") && /loop head/.test(m.routines[0].comment ?? ""),
      "N2 …and the losing label's comment is kept on the surviving record, not dropped", JSON.stringify(m?.routines));
    const f1 = await call("list_findings", {});
    check(/label \$8207 — R over L/.test(f1), "N2 …and the answer is a recorded finding", f1.split("\n").filter((l) => /8207/.test(l)).join(" | "));
    const alias = await mergeTo("n2a", [L, R], [{ key: "routine:8207", winner: "L", why: "keep the older, tested name" }]);
    const ma = readOut("n2a");
    check(!/refus/i.test(alias) && ma && ma.labels.length === 1 && ma.labels[0].label === "kill_bit_locate_loop" && ma.routines.length === 0,
      "N2 the label wins and the routine goes; `routine:8207` answers the same contest", JSON.stringify(ma) + alias.split("\n")[0]);
    const del = await mergeTo("n2d", [L, R], [{ key: "label:8207", delete: true, why: "both names were guesses, the address is just a loop" }]);
    const md = readOut("n2d");
    check(!/refus/i.test(del) && md && md.labels.length === 0 && md.routines.length === 0,
      "N2 a resolution can DELETE: neither name stays", JSON.stringify(md) + del.split("\n")[0]);
    const f2 = await call("list_findings", {});
    check(/label \$8207 — removed/.test(f2), "N2 …and so is the deletion", f2.split("\n").filter((l) => /8207/.test(l)).join(" | "));
    const bad = await mergeTo("n2b", [L, R], [{ key: "label:8207", winner: "R", delete: true, why: "cannot be both at once" }]);
    check(/refus/i.test(bad) && /more than one of winner, value and delete/.test(bad), "N2 winner and delete together are refused");
    const same = await mergeTo("n2s", [{ name: "S", labels: [{ address: "8207", label: "a_name" }], routines: [{ address: "8207", name: "b_name" }] }]);
    check(/refus/i.test(same) && /label:8207/.test(same), "N2 one fragment contradicting itself is refused the same way", same.split("\n").slice(0, 4).join(" | "));
    const own = await mergeTo("n2o", [{ name: "S", labels: [{ address: "8207", label: "a_name" }], routines: [{ address: "8207", name: "b_name" }] }],
      [{ key: "label:8207", winner: "S:routine", why: "the routine name is the descriptive one" }]);
    const mo = readOut("n2o");
    check(!/refus/i.test(own) && mo && mo.labels.length === 0 && mo.routines[0]?.name === "b_name", "N2 `S:routine` picks the record when one fragment names the address twice", own.split("\n")[0]);
  }

  head("N3 resolving a name: keeps the other record's comment");
  {
    const A = { name: "A", labels: [{ address: "8200", label: "core_dup" }] };
    const B = { name: "B", routines: [{ address: "8220", name: "core_dup", comment: "keep me" }], segments: [{ start: "8220", end: "822F", kind: "code" }] };
    const out = await mergeTo("n3", [A, B], [{ key: "name:core_dup", winner: "A", why: "$8200 is the cold entry" }]);
    const m = readOut("n3");
    check(!/refus/i.test(out) && m && m.labels.length === 1 && m.labels[0].address === "8200", "N3 the name stays at $8200 only", JSON.stringify(m) + out.split("\n")[0]);
    check(m && m.routines.length === 0 && /keep me/.test(m.segments.find((x) => x.start === "8220")?.comment ?? ""), "N3 …and the comment of the dropped routine moved to the segment at $8220", JSON.stringify(m));
    const del = await mergeTo("n3d", [A, B], [{ key: "name:core_dup", delete: true, why: "neither site deserves the name" }]);
    const md = readOut("n3d");
    check(!/refus/i.test(del) && md && md.labels.length === 0 && md.routines.length === 0, "N3 a name: key can be deleted at every site", JSON.stringify(md) + del.split("\n")[0]);
  }

  head("N4 immediates: identical collapse, conflicting are refused, dangling ones follow the label");
  {
    const imm = (address, kind, label) => ({ address, kind, label });
    const same = await mergeTo("n4a", [{ name: "A", immediates: [imm("8207", "lo-of", "tbl")] }, { name: "B", immediates: [imm("$8207", "lo-of", "tbl")] }]);
    const ma = readOut("n4a");
    check(!/refus/i.test(same) && ma && ma.immediates.length === 1, "N4 two fragments with the same immediate give one row", JSON.stringify(ma?.immediates));
    const clash = await mergeTo("n4b", [{ name: "A", immediates: [imm("8207", "lo-of", "msg_a")] }, { name: "B", immediates: [imm("8207", "lo-of", "txt_b")] }]);
    check(/refus/i.test(clash) && /immediate:8207/.test(clash) && /msg_a/.test(clash) && /txt_b/.test(clash), "N4 two labels for one immediate are refused as immediate:8207, both named", clash.split("\n").slice(0, 6).join(" | "));
    const kinds = await mergeTo("n4k", [{ name: "A", immediates: [imm("8207", "lo-of", "t")] }, { name: "B", immediates: [imm("8207", "hi-of", "t")] }]);
    check(/refus/i.test(kinds) && /immediate:8207/.test(kinds), "N4 lo-of vs hi-of at one instruction is refused too");
    const win = await mergeTo("n4c", [{ name: "A", immediates: [imm("8207", "lo-of", "msg_a")] }, { name: "B", immediates: [imm("8207", "lo-of", "txt_b")] }],
      [{ key: "immediate:8207", winner: "B", why: "txt_b is the table the loop reads" }]);
    const mc = readOut("n4c");
    check(!/refus/i.test(win) && mc && mc.immediates.length === 1 && mc.immediates[0].label === "txt_b", "N4 the winner's row is the only one", JSON.stringify(mc?.immediates));
    const del = await mergeTo("n4d", [{ name: "A", immediates: [imm("8207", "lo-of", "msg_a")] }, { name: "B", immediates: [imm("8207", "lo-of", "txt_b")] }],
      [{ key: "immediate:8207", delete: true, why: "the operand is a plain byte, not an address half" }]);
    const md = readOut("n4d");
    check(!/refus/i.test(del) && md && !(md.immediates ?? []).length, "N4 an immediate can be deleted", JSON.stringify(md));
    // the #73 shape: the label loses, the immediates pointing at it must follow, not dangle
    const A = { name: "A", labels: [{ address: "82C0", label: "msg_ring" }], immediates: [imm("8207", "lo-of", "msg_ring"), imm("820A", "hi-of", "msg_ring")] };
    const B = { name: "B", labels: [{ address: "82C0", label: "txt_ring" }], immediates: [imm("8207", "lo-of", "txt_ring")] };
    const first = await mergeTo("n4e", [A, B]);
    check(/refus/i.test(first) && /label:82C0/.test(first) && !/immediate:8207/.test(first),
      "N4 the label dispute is listed; the immediate dispute it causes is not (it dissolves with the answer)", first.split("\n").filter((l) => /label:|immediate:/.test(l)).join(" | "));
    const res = await mergeTo("n4e", [A, B], [{ key: "label:82C0", winner: "B", why: "txt_ring is what the table is called in the text pass" }]);
    const me = readOut("n4e");
    check(!/refus/i.test(res) && me && (me.immediates ?? []).length === 2 && me.immediates.every((r) => r.label === "txt_ring"),
      "N4 the losing label's immediates are rewritten to the winner — none left pointing at msg_ring", JSON.stringify(me?.immediates) + res.split("\n").slice(0, 3).join(" | "));
    check(/Note: .*msg_ring.*txt_ring/.test(res), "N4 …and the rewrite is said, not silent", res.split("\n").filter((l) => /Note:/.test(l)).join(" | "));
    const dl = await mergeTo("n4f", [A, B], [{ key: "label:82C0", delete: true, why: "the table has no name worth keeping" }]);
    const mf = readOut("n4f");
    check(!/refus/i.test(dl) && mf && (mf.immediates ?? []).length === 0 && /dropped/.test(dl), "N4 a deleted label takes the immediates that pointed at it with it, and says so", JSON.stringify(mf?.immediates));
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
