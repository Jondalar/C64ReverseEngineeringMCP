#!/usr/bin/env node
// `slot_record`'s title cap, in the tool's own voice.
//
// The same tool produced the best refusal of an entire autonomous run:
//
//     `answer` came through at 2533 characters and `evidence` did not, which is the
//     shape of a tool call that was cut short as it was written … send it again with
//     `evidence` written BEFORE `answer`.
//
// Actionable on the first try. The title cap was the opposite: a `max(120)` in the
// schema, so it surfaced as the SDK's own validation dump AFTER the whole call had been
// composed — and a slot answer is long. The caller is told a string is too long and
// nothing else: not by how much, not that the answer is kept whole regardless, not that
// omitting `title` produces a headline by itself.
//
// What the cap must do:
//
//   1 the limit is stated where the caller reads it BEFORE composing the call
//   2 the door checks it itself — no `maxLength` left in the schema to fire first
//   3 the refusal is the tool's voice: the cap, the actual length, and a way past it
//   4 it hands back the headline that omitting `title` would have produced
//   5 nothing is written — the slot is still empty afterwards
//   6 at the cap it is accepted, and omitting `title` still works
//   7 the evidence refusal — the good one — is untouched
//
// Hermetic: a temp project over stdio. Exit 0 = pass, 1 = fail.
//   npm run e2e:060-slot-title

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
const head = (n, title) => console.log(`\n── §${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/ is not built — run npm run build"); process.exit(2); }

console.log("slot_record — the title cap, said where it can be acted on\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-slottitle-"));
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
/** Whatever came back, as text — an SDK schema error included, because that is the
 *  shape this gate exists to rule out. */
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return `# transport error\n${JSON.stringify(r.error)}`;
  const text = (r.result?.content || []).map((c) => c.text).join("\n");
  return r.result?.isError ? `# tool error\n${text}` : text;
};
const report = (t) => t.split(/\n---\n\*\*Project rule/)[0];

// A slot answer, the length a real one runs to.
const ANSWER = [
  "The boot chain is three stages. Stage 1 is the BASIC stub at $0801 which SYSes",
  "into $080D; that copies 62 bytes of stage 2 down to $0334 and jumps there.",
  "Stage 2 installs the $DD00 fastloader, patches the IRQ vector at $0314 and",
  "pulls the resident engine from track 18 sector 4 onwards into $4000-$7FFF.",
  "Stage 3 is the engine's own init at $4000, which clears the screen, sets the",
  "VIC bank and enters the main loop at $4103.",
].join(" ");
const EVIDENCE = "artifacts/boot_disasm.asm lines 12-180; the $0334 copy loop is at $0812-$0826.";

const LONG_TITLE =
  "The three-stage boot chain: a BASIC stub at $0801 that SYSes to $080D, a relocated "
  + "stage 2 at $0334 that installs the fastloader, and the resident engine at $4000";

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-060-slot-title", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { name: "slot-title" });
  await call("agent_onboard", {});

  // ── §1 the limit is readable before the call is composed ──────────────────
  head(1, "the limit is stated where the caller reads it, before composing");
  let titleSchema = {};
  {
    const tools = (await rpc("tools/list", {})).result.tools;
    const tool = tools.find((t) => t.name === "slot_record");
    check(!!tool, "slot_record is on the surface");
    titleSchema = tool?.inputSchema?.properties?.title ?? {};
    check(/120/.test(titleSchema.description ?? ""),
      "`title`'s own description names the number",
      (titleSchema.description ?? "(none)").slice(0, 110));
    check(/omit|leave .*out/i.test(titleSchema.description ?? ""),
      "…and says what happens if you leave it out");
    check(/120/.test(tool?.description ?? ""),
      "the tool's own description names it too — that is the line a caller reads first",
      (tool?.description ?? "").slice(0, 140));
  }

  // ── §2 the schema does not fire first ─────────────────────────────────────
  head(2, "the door checks it, not the schema");
  {
    check(titleSchema.maxLength === undefined,
      "`title` carries no maxLength — a schema cap answers with a validation dump, not a remedy",
      `maxLength=${JSON.stringify(titleSchema.maxLength)}`);
  }

  // ── §3 the refusal is the tool's voice ────────────────────────────────────
  head(3, "an over-long title is refused in the tool's own voice");
  const refused = report(await call("slot_record", {
    slot: "S3", answer: ANSWER, evidence: EVIDENCE, title: LONG_TITLE,
  }));
  {
    check(/^# slot_record refused/m.test(refused),
      "it is slot_record refusing, by name",
      refused.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(!/Invalid arguments/i.test(refused) && !/at most/i.test(refused) && !/"path":\s*\[/.test(refused),
      "…and not the SDK's schema validation dump",
      refused.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(new RegExp(`${LONG_TITLE.length}`).test(refused),
      "it says how long the title ACTUALLY is", `title is ${LONG_TITLE.length} chars`);
    check(/120/.test(refused), "…and what the cap is");
    check(/answer/.test(refused) && /(whole|full|in full|body)/i.test(refused),
      "…and that the ANSWER is not capped — it is kept whole either way");
  }

  // ── §4 it hands back a headline ───────────────────────────────────────────
  head(4, "it hands back the headline that omitting `title` would produce");
  {
    const quoted = /"([^"]{20,120})"/.exec(refused)?.[1];
    check(!!quoted, "the refusal quotes a ready-made headline", (quoted ?? "(none)").slice(0, 100));
    check(!!quoted && quoted.length <= 120, "…that is itself within the cap", `${quoted?.length ?? 0} chars`);
    check(!!quoted && LONG_TITLE.startsWith(quoted.replace(/…$/, "").trim()),
      "…and is made from the title the caller wrote, not from thin air",
      (quoted ?? "").slice(0, 90));
  }

  // ── §5 nothing was written ────────────────────────────────────────────────
  head(5, "nothing was written");
  {
    check(/[Nn]othing was written/.test(refused), "the refusal says so");
    const slots = report(await call("project_slots", {}));
    check(/[·✗] S3/.test(slots), "…and S3 really is still empty",
      slots.split("\n").find((l) => /S3/.test(l))?.slice(0, 110));
  }

  // ── §6 at the cap, and without a title ────────────────────────────────────
  head(6, "at the cap it is accepted, and omitting it still works");
  {
    const atCap = "x".repeat(120);
    const ok = report(await call("slot_record", { slot: "S3", answer: ANSWER, evidence: EVIDENCE, title: atCap }));
    check(!/refused/.test(ok), "a title of exactly 120 characters is accepted",
      ok.split("\n").filter(Boolean)[0]?.slice(0, 110));
    const none = report(await call("slot_record", { slot: "S1", answer: ANSWER, evidence: EVIDENCE }));
    check(!/refused/.test(none) && /^Title: /m.test(none),
      "omitting `title` still takes a headline from the answer",
      none.split("\n").find((l) => /^Title:/.test(l))?.slice(0, 110));
    check((/^Title: (.+)$/m.exec(none)?.[1] ?? "").length <= 120,
      "…and that headline obeys the same cap",
      `${(/^Title: (.+)$/m.exec(none)?.[1] ?? "").length} chars`);
  }

  // ── §7 the good refusal is untouched ──────────────────────────────────────
  head(7, "the evidence refusal — the best one of the run — is unchanged");
  {
    const long = `${ANSWER} `.repeat(6).trim();
    const out = report(await call("slot_record", { slot: "S5", answer: long }));
    check(/^# slot_record refused — evidence did not arrive/m.test(out),
      "a missing evidence still refuses by cause, not by schema",
      out.split("\n").filter(Boolean)[0]?.slice(0, 140));
    check(new RegExp(`\`answer\` came through at ${long.length} characters`).test(out),
      "…still measuring the prose that DID arrive", `answer is ${long.length} chars`);
    check(/written BEFORE `answer`/.test(out), "…and still naming the one remedy in the caller's control");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-060-slot-title: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
