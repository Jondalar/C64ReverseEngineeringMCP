#!/usr/bin/env node
// Issue #87 — a hand-written knowledge/NEXT.md survives every step record.
//   hand-written NEXT.md : byte-identical after recordAgentStepFromCode (the sandbox-end path) and after
//                          the real agent_record_step / agent_set_role tools; the step is in agent-state.json
//   no NEXT.md           : created
//   generated NEXT.md    : rewritten
// Hermetic: temp project, stdio MCP server, no daemon.   npm run e2e:issue87-next-md-guard
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { recordAgentStepFromCode, NEXT_MD_GENERATED_FOOTER } = await import("../dist/server-tools/agent-workflow.js");

const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "c64re-87-"));
const nextPath = join(dir, "knowledge", "NEXT.md");
const statePath = join(dir, "knowledge", "agent-state.json");
const history = () => JSON.parse(readFileSync(statePath, "utf8")).history.map((h) => h.step);
let client;
try {
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  new ProjectKnowledgeService(dir).initProject({ name: "guard87" });

  recordAgentStepFromCode(dir, "step-created");
  check("no NEXT.md: created", existsSync(nextPath) && readFileSync(nextPath, "utf8").includes(NEXT_MD_GENERATED_FOOTER));

  recordAgentStepFromCode(dir, "step-regenerated");
  check("generated NEXT.md: rewritten", readFileSync(nextPath, "utf8").includes("step-regenerated"));

  const hand = "# Closed 2026-10-15\n\nrelease abc123, open: nothing\n";
  writeFileSync(nextPath, hand);
  recordAgentStepFromCode(dir, "sandbox-end-step");
  check("hand-written NEXT.md byte-identical after the sandbox-end record", readFileSync(nextPath, "utf8") === hand);
  check("sandbox-end step is in agent-state.json history", history().includes("sandbox-end-step"));

  client = new Client({ name: "e2e87", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist", "cli.js")],
    env: { ...process.env, C64RE_PROJECT_DIR: dir }, stderr: "ignore",
  }));
  const text = (r) => r.content.map((c) => c.text).join("\n");
  await client.callTool({ name: "agent_onboard", arguments: {} });
  const hand0 = readFileSync(nextPath, "utf8");
  check("agent_onboard leaves a hand-written NEXT.md alone", hand0 === hand);
  const rec = text(await client.callTool({ name: "agent_record_step", arguments: { step: "tool-step", next_action: "x" } }));
  check("hand-written NEXT.md byte-identical after agent_record_step", readFileSync(nextPath, "utf8") === hand);
  check("agent_record_step step is in history", history().includes("tool-step"), rec.slice(0, 300));
  check("agent_record_step says the file was kept", rec.includes("kept: hand-written"));
  const role = text(await client.callTool({ name: "agent_set_role", arguments: { role: "analyst" } }));
  check("hand-written NEXT.md byte-identical after agent_set_role", readFileSync(nextPath, "utf8") === hand);
  check("agent_set_role says the file was kept", role.includes("kept: hand-written"));
} finally {
  try { await client?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
