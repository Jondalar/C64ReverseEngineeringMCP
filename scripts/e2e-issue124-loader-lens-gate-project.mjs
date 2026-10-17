#!/usr/bin/env node
// Issue #124 — the discipline gate of a call that names project_dir=<B> checks B, whatever project the server was started for.
// The server is bound to A (C64RE_PROJECT_DIR); every call names B. runtime_loader_lens is headless: the capture path does not
// exist, the gate runs before the capture is read.
//   1  a citation that only A's records can resolve is refused as unresolved (checked against B)
//   2  B's ratchet is B/knowledge/runtime-ratchet.json and counts B's records; nothing is written into A
//   3  the sixth call is refused by the ratchet; a second finding in B releases it (the substrate refusal answers instead)
// Hermetic: two temp projects, stdio MCP server, no daemon.   npm run e2e:issue124-loader-lens-gate-project
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  if (cond) passes++; else failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n        ${detail}` : ""}`);
};

const walk = (dir) => {
  const out = new Map();
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  rec(dir);
  return out;
};
const changes = (before, after) => {
  const c = [];
  for (const [k, v] of after) if (!before.has(k)) c.push(`+ ${k}`); else if (before.get(k) !== v) c.push(`M ${k}`);
  for (const k of before.keys()) if (!after.has(k)) c.push(`- ${k}`);
  return c;
};

const base = mkdtempSync(join(tmpdir(), "c64re-124-"));
const A = join(base, "A"), B = join(base, "B");
let client;
try {
  mkdirSync(A); mkdirSync(B);
  client = new Client({ name: "e2e124", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist", "cli.js")],
    env: { ...process.env, C64RE_PROJECT_DIR: A, C64RE_RUNTIME_AUTOSTART: "0" }, stderr: "ignore",
  }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  await call("project_init", { preferred_assembler: "kickass", name: "proj-a", project_dir: A });
  await call("project_init", { preferred_assembler: "kickass", name: "proj-b", project_dir: B });
  await call("agent_onboard", { project_dir: B });
  await call("save_finding", { project_dir: B, kind: "classification", title: "synthetic routine at $1000", address_range: { start: 4096, end: 4111 } });
  await call("save_finding", { project_dir: A, kind: "classification", title: "synthetic routine at $2000 in A only", address_range: { start: 8192, end: 8207 } });
  const before = walk(A);

  const lens = (hypothesis) => call("runtime_loader_lens", { project_dir: B, capture_path: "captures/none.c64retrace", hypothesis });
  const citeA = await lens('Checking $2000: the finding "synthetic routine at $2000 in A only" says the loader lands its first block there.');
  check("a citation only A can resolve is refused against B", /citation does not resolve/.test(citeA), citeA.slice(0, 200));

  const hyp = 'Checking $1000: the finding "synthetic routine at $1000" in this project says the loader lands its first block there.';
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await lens(hyp));
  const ratchetB = join(B, "knowledge", "runtime-ratchet.json");
  check("B has its own ratchet file", existsSync(ratchetB));
  const stB = existsSync(ratchetB) ? JSON.parse(readFileSync(ratchetB, "utf8")) : {};
  check("B's ratchet counts B's records", (stB.lastRecordTotal ?? 0) >= 1, JSON.stringify(stB).slice(0, 200));
  check("calls 1-4 reach the substrate gate", outs.slice(0, 4).every((o) => /characterize the medium first/.test(o)), outs.slice(0, 4).join("\n---\n").slice(0, 400));
  check("calls 5 and 6 are refused by the ratchet", outs.slice(4).every((o) => /runtime calls, nothing recorded/.test(o)), outs.slice(4).join("\n---\n").slice(0, 400));
  const mid = changes(before, walk(A));
  check("nothing is written into A", mid.length === 0 && !existsSync(join(A, "knowledge", "runtime-ratchet.json")), mid.join(", "));

  await call("save_finding", { project_dir: B, kind: "observation", title: "second finding at $1000 (the record the refusal asks for)", address_range: { start: 4096, end: 4111 } });
  const after = await lens(hyp);
  check("a finding saved in B releases the ratchet", !/nothing recorded/.test(after) && /characterize the medium first/.test(after), after.slice(0, 300));
  check("still nothing written into A", changes(before, walk(A)).length === 0, changes(before, walk(A)).join(", "));
} finally {
  try { await client?.close(); } catch {}
  rmSync(base, { recursive: true, force: true });
}
console.log(`\n${failures ? "RED" : "GREEN"} issue 124: ${passes} pass, ${failures} fail`);
process.exit(failures ? 1 : 0);
