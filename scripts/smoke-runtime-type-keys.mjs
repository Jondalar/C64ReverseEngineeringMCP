// C64RE #62 + #64 — runtime_type key tokens and the still-booting guard.
//
// A daemon of our own (never the shared one):
//   (b) right after session start the KERNAL is in its memory test; runtime_type(settle) must
//       wait for BASIC's input loop, so `PRINT 1+1` + RETURN lands (screen shows the echo and
//       the answer " 2"). Without settle on a booting machine the answer carries a WARNING.
//   (a) {F1} / {F2} are pressed in the CIA1 matrix: a 6502 loop at $C000 (SEI, scans columns 0
//       and 1 itself, no KERNAL) accumulates the PB bits it ever read low. F1 = col0/row4,
//       F2 = SHIFT (col1/row7) + F1. An unknown token and an unclosed brace are refused and
//       press nothing.
// Needs a TRX64 daemon: the sibling release build, or C64RE_TRX64_BIN.
//
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const bin = process.env.C64RE_TRX64_BIN || join(ROOT, "..", "TRX64", "target", "release", "trx64-daemon");
if (!existsSync(bin)) { console.error(`no daemon at ${bin} — set C64RE_TRX64_BIN`); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (url) => new Promise((res, rej) => { const w = new WebSocket(url); w.once("open", () => res(w)); w.once("error", rej); });

async function withDaemon(port, body) {
  const daemon = spawn(bin, ["--port", String(port)], { stdio: "ignore" });
  let server;
  try {
    for (let i = 0; i < 50; i++) { try { (await open(`ws://127.0.0.1:${port}?av=0`)).close(); break; } catch { await sleep(200); } }
    const proj = mkdtempSync(join(tmpdir(), "c64re-type-keys-"));
    server = spawn(process.execPath, [cli], {
      cwd: tmpdir(),
      env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${port}`, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = ""; const pending = new Map();
    server.stdout.on("data", (d) => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    let nextId = 1;
    const rpc = (method, params, ms = 120000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, ms);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    // Returns { text, isError } — a refusal is a result, not an exception.
    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) return { text: r.error.message, isError: true };
      return { text: (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: !!r.result?.isError || /^# Tool Error/.test(r.result?.content?.[0]?.text ?? "") };
    };
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-runtime-type-keys", version: "1" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: proj, name: "type-keys" });
    await call("agent_onboard", { project_dir: proj });
    await call("runtime_session_start", { project_dir: proj });
    await body(call);
  } finally { server?.kill(); daemon.kill(); }
}

const screenText = async (call) => {
  const r = await call("runtime_monitor", { session_id: "shared", command: "m 0400 07e7" });
  const bytes = r.text.split("\n").flatMap((l) => { const m = /^>C:[0-9a-fA-F]{4}\s+((?:[0-9a-fA-F]{2} ){1,32})/.exec(l); return m ? m[1].trim().split(" ").map((h) => parseInt(h, 16)) : []; });
  const ch = (b) => { b &= 0x7f; return b === 0 ? "@" : b <= 26 ? String.fromCharCode(64 + b) : String.fromCharCode(b); };
  const rows = []; for (let i = 0; i < 25; i++) rows.push(bytes.slice(i * 40, i * 40 + 40).map(ch).join("").trimEnd());
  return rows;
};
const mem = async (call, addr, n) => {
  const r = await call("runtime_monitor", { session_id: "shared", command: `m ${addr} ${(parseInt(addr, 16) + n - 1).toString(16)}` });
  const m = /^>C:[0-9a-fA-F]{4}\s+((?:[0-9a-fA-F]{2} ){1,32})/m.exec(r.text);
  return m ? m[1].trim().split(" ").slice(0, n).map((h) => parseInt(h, 16)) : [];
};

console.log("C64RE #62/#64 — runtime_type key tokens + still-booting guard\n");

// (b1) no settle on a booting machine: queued, with a warning.
await withDaemon(47741, async (call) => {
  const r = await call("runtime_type", { session_id: "shared", text: "A" });
  check(!r.isError && /Queued/.test(r.text) && /WARNING: the machine is still booting/.test(r.text), "no settle on a booting machine: queued + warning", r.text.split("\n").slice(0, 3).join(" | ").slice(0, 160));
});

// (b2) settle immediately after the session start: the line lands.
await withDaemon(47742, async (call) => {
  const r = await call("runtime_type", { session_id: "shared", text: "PRINT 1+1\r", settle: true });
  check(!r.isError && /still booting: advanced \d+ cycles/.test(r.text), "settle waits for BASIC's input loop first", r.text.split("\n").slice(0, 3).join(" | ").slice(0, 200));
  const rows = await screenText(call);
  const i = rows.findIndex((x) => /^PRINT 1\+1$/.test(x));
  check(i >= 0 && /^ ?2$/.test(rows[i + 1] ?? ""), "PRINT 1+1 landed and answered 2", `rows: ${JSON.stringify(rows.slice(0, 8))}`);
  check(rows.some((x) => x === "READY."), "READY. on screen");
});

// (a) key tokens in the matrix.
await withDaemon(47743, async (call) => {
  const prog = "78 a9 ff 8d 00 c1 8d 01 c1 a9 fe 8d 00 dc ad 01 dc 2d 00 c1 8d 00 c1 a9 fd 8d 00 dc ad 01 dc 2d 01 c1 8d 01 c1 4c 09 c0";
  await call("runtime_monitor", { session_id: "shared", command: `wr c000 ${prog}` });
  await call("runtime_monitor", { session_id: "shared", command: "r pc=c000" });
  await call("runtime_session_run", { session_id: "shared", max_instructions: 5000, cycle_budget: 5000 });
  const reset = async () => { await call("runtime_monitor", { session_id: "shared", command: "wr c100 ff ff" }); };
  const peek = () => mem(call, "c100", 2);

  let [p0, p1] = await peek();
  check(p0 === 0xff && p1 === 0xff, "matrix idle before any key", `c100=${p0?.toString(16)} c101=${p1?.toString(16)}`);

  await reset();
  let r = await call("runtime_type", { session_id: "shared", text: "{F1}" });
  check(!r.isError && /Key tokens pressed in the CIA1 matrix: \{F1\}/.test(r.text), "{F1} accepted and played out without settle", r.text.split("\n")[0]);
  [p0, p1] = await peek();
  check(((p0 >> 4) & 1) === 0 && p1 === 0xff, "{F1}: col0/row4 read low, SHIFT (col1/row7) did not", `c100=${p0?.toString(16)} c101=${p1?.toString(16)}`);

  await reset();
  await call("runtime_type", { session_id: "shared", text: "{F2}" });
  [p0, p1] = await peek();
  check(((p0 >> 4) & 1) === 0 && ((p1 >> 7) & 1) === 0, "{F2} = SHIFT + F1 in the matrix", `c100=${p0?.toString(16)} c101=${p1?.toString(16)}`);

  await reset();
  r = await call("runtime_type", { session_id: "shared", text: "{CRSR UP}" });
  [p0, p1] = await peek();
  check(((p0 >> 7) & 1) === 0 && ((p1 >> 7) & 1) === 0, "{CRSR UP} = SHIFT + CRSR DOWN (col0/row7)", `c100=${p0?.toString(16)} c101=${p1?.toString(16)}`);

  await reset();
  r = await call("runtime_type", { session_id: "shared", text: "{FOO}" });
  [p0, p1] = await peek();
  check(r.isError && /unknown key token \{FOO\}/.test(r.text) && /Known tokens:.*F1-F8/.test(r.text) && p0 === 0xff && p1 === 0xff, "unknown token refused with the list, nothing pressed", r.text.slice(0, 100));
  r = await call("runtime_type", { session_id: "shared", text: "x{F1" });
  check(r.isError && /unclosed/.test(r.text), "unclosed brace refused", r.text.slice(0, 80));
  r = await call("runtime_type", { session_id: "shared", text: "{RESTORE}" });
  check(r.isError && /RESTORE is not on the matrix/.test(r.text), "{RESTORE} refused, said why");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
