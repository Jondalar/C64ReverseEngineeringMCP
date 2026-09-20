#!/usr/bin/env node
// Spec 861 §7.6 + §7.7 (the static half) — the code_cost door.
//
//  §7.6  `LDA $10 / CLC / ADC #$01 / STA $10` against `INC $10`: NOT EQUIVALENT
//        (A, C and the flags differ); the same pair with A, C, N, V and Z dead
//        afterwards: EQUIVALENT; and a pair that reorders a read of $DC0D: NOT
//        EQUIVALENT, because reading it changes the machine.
//  §7.7  `LDX #$27 / loop: … / DEX / BPL loop` resolves to 40 iterations, and
//        its cost is exact. The MEASURED half of §7.7 is in `smoke:861`, which
//        runs the same bytes on the machine under §7.1's conditions.
//
// Everything runs through the MCP tool over stdio, which is the product's own
// door. Hermetic: no ROM, no assembler, no media, no runtime daemon — so it
// runs in CI.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:861-static

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

console.log("Spec 861 §7.6 + §7.7 — equivalence with liveness, and a static loop bound\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) {
  console.error("dist/ is not built — run npm run build:mcp");
  process.exit(2);
}

const proj = mkdtempSync(join(tmpdir(), "c64re-861s-"));
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "" },
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
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 60000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// The two versions of §7.6, as bytes.
const ADD_ONE = "a5 10 18 69 01 85 10";   // lda $10 / clc / adc #$01 / sta $10
const INC_ONE = "e6 10";                  // inc $10

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-861-static", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = new Set(((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name));
  check(tools.has("code_cost"), "code_cost is on the default surface — a tool not in DEFAULT_TOOLS is hidden");
  check(tools.has("change_impact") && tools.has("trace_cost"), "so are change_impact and trace_cost (§8)");
  await call("project_init", { name: "cost861static" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});

  // ---- §3.1/§3.2: the cost itself ----------------------------------------
  {
    const t = await call("code_cost", { bytes: ADD_ONE, address: "$C000", listing: true });
    check(/bytes: 7 exact/.test(t), "the byte count is exact", t.split("\n").find((l) => l.includes("bytes:")));
    check(/cycles: 10 exact/.test(t), "lda $10 / clc / adc #$01 / sta $10 is 10 cycles, exact", t.split("\n").find((l) => l.includes("cycles:")));
    check(/\$C000  LDA \$10\s+3/.test(t), "the listing prices each instruction (lda zp = 3)");
    check(/\$C003  ADC #\$01\s+2/.test(t), "…and an immediate is 2");
    const inc = await call("code_cost", { bytes: INC_ONE, address: "$C000" });
    check(/cycles: 5 exact/.test(inc), "inc $10 is 5 cycles", inc.split("\n").find((l) => l.includes("cycles:")));
  }
  {
    // A page crossing is the span, and only the span.
    const t = await call("code_cost", { bytes: "bd f0 10", address: "$C000" });   // lda $10f0,x
    check(/cycles: 4–5/.test(t), "an indexed read with an unknown index is a span, not a number", t.split("\n").find((l) => l.includes("cycles:")));
  }

  // ---- §7.6 case 1: the flags differ -------------------------------------
  {
    const t = await call("code_cost", { bytes: ADD_ONE, address: "$C000", candidate_bytes: INC_ONE });
    check(/equivalence: NOT EQUIVALENT/.test(t), "§7.6 with everything live: NOT EQUIVALENT", t.split("\n").find((l) => l.includes("equivalence:")));
    check(/it differs in [ACNVZ]:/.test(t), "…and it names the differing effect as a counter-example", t.split("\n").find((l) => l.includes("it differs in")));
    check(/Δ bytes: -5/.test(t), "Δ bytes is -5");
    check(/Δ cycles: -5/.test(t), "Δ cycles is -5");
    check(/it rests on: no live-out was declared/.test(t), "…and it says what the verdict rests on (§3.5)");
  }

  // ---- §7.6 case 2: the same pair with A, C, N, V and Z dead --------------
  {
    const t = await call("code_cost", { bytes: ADD_ONE, address: "$C000", candidate_bytes: INC_ONE, live_out: ["X", "Y"] });
    check(/equivalence: EQUIVALENT/.test(t), "§7.6 with A, C, N, V and Z dead afterwards: EQUIVALENT", t.split("\n").find((l) => l.includes("equivalence:")));
    check(/compared:.*every memory cell either version writes/.test(t), "…having compared the memory both versions write");
    check(/the caller declared what is live after the range: X Y/.test(t), "…and it names the liveness it was given");
  }

  // ---- §7.6 case 3: a reordered read of $DC0D ----------------------------
  {
    // A: read $DC0D into $10, then $D012 into $11.   B: the same two, swapped.
    const A = "ad 0d dc 85 10 ad 12 d0 85 11";
    const B = "ad 12 d0 85 11 ad 0d dc 85 10";
    const t = await call("code_cost", { bytes: A, address: "$C000", candidate_bytes: B, live_out: [] });
    check(/equivalence: NOT EQUIVALENT/.test(t), "§7.6 a reordered read of $DC0D: NOT EQUIVALENT", t.split("\n").find((l) => l.includes("equivalence:")));
    check(/the I\/O accesses differ/.test(t), "…because the I/O accesses differ, not because a register does", t.split("\n").find((l) => l.includes("I/O accesses")));
    check(/read \$DC0D/.test(t) && /read \$D012/.test(t), "…and both orders are printed");
    // The same two reads in the same order ARE equivalent, so the rule is about ORDER.
    const same = await call("code_cost", { bytes: A, address: "$C000", candidate_bytes: A, live_out: [] });
    check(/equivalence: EQUIVALENT/.test(same), "…while the same order compares EQUIVALENT (the rule is order, not the mere presence of I/O)");
  }

  // ---- UNKNOWN is a real answer ------------------------------------------
  {
    const t = await call("code_cost", { bytes: "a5 10 4c 00 c0", address: "$C000", candidate_bytes: "e6 10" });
    check(/equivalence: UNKNOWN/.test(t), "code that is not straight-line is UNKNOWN, not a guess", t.split("\n").find((l) => l.includes("equivalence:")));
    check(/UNKNOWN because .*not straight-line/.test(t), "…and it says why");
    const indexed = await call("code_cost", { bytes: "a9 01 9d 00 04", address: "$C000", candidate_bytes: "a9 01 9d 00 04" });
    check(/equivalence: UNKNOWN/.test(indexed), "a write to an address that is not constant is UNKNOWN, even against itself");
    check(/X is not a constant here/.test(indexed), "…naming the register that makes it so");
  }

  // ---- §7.7: the static loop bound ---------------------------------------
  {
    //   C000  ldx #$27
    //   C002  lda $1000,x
    //   C005  sta $0400,x
    //   C008  dex
    //   C009  bpl $C002
    //   C00B  rts
    const LOOP = "a2 27 bd 00 10 9d 00 04 ca 10 f7 60";
    const t = await call("code_cost", { bytes: LOOP, address: "$C000", listing: true });
    check(/40 iterations/.test(t), "§7.7 ldx #$27 / dex / bpl resolves to 40 iterations", t.split("\n").find((l) => l.includes("iterations")));
    check(/ldx #\$27 at \$C000, dex \/ bpl/.test(t), "…and it names the three instructions it read that from");
    check(/the back edge is taken 39 times at 1 cycle more each/.test(t), "…the branch is charged taken 39 times and not-taken once");
    check(/crosses a page on 0 of the 40 iterations/.test(t), "…and the indexed read's page crossings are counted, not left as a span");
    check(/cycles: 567 exact/.test(t), "…so the whole range is 567 cycles, exact", t.split("\n").find((l) => l.includes("cycles:")));
    // The smoke runs these very bytes on the machine and asserts 567 measured.
    check(/loop at \$C002/.test(t), "the loop is reported at its head");
  }
  {
    // A loop whose bound is NOT constant says so instead of inventing one.
    //   C000  ldx $20 / C002 lda $1000,x / C005 dex / C006 bne $C002 / C008 rts
    const t = await call("code_cost", { bytes: "a6 20 bd 00 10 ca d0 fa 60", address: "$C000" });
    check(/bound UNKNOWN/.test(t), "a counter loaded from memory has no static bound, and the report says so", t.split("\n").find((l) => l.includes("UNKNOWN")));
    check(/no total —/.test(t), "…and then there is no total for the range");
    check(/cycles per iteration/.test(t), "…only a per-iteration cost");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-861-static: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
