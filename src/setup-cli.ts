// Spec 044: `c64re setup <agent>` writes the c64re process discipline
// block into the target agent's config so c64re_whats_next is called
// after every user turn. Idempotent via marker comments.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MARKER_START = "<!-- c64re-setup-start -->";
const MARKER_END = "<!-- c64re-setup-end -->";

const SETUP_BLOCK = `${MARKER_START}
## c64re — Permanent Nudger Convention

This project uses the c64re MCP server. After every user turn, call
\`c64re_whats_next\` to receive the phase-aware next required action.
The output stays under ~30 lines and is meant to be parsed every turn.

Session start checklist:

1. Load the doctrine prompts: \`c64re_re_phases\` (seven-phase RE
   workflow) and \`c64re_agent_doctrine\` (general operating
   doctrine). For cracker work also call
   \`c64re_cracker_doctrine\`.
2. Run \`agent_onboard\` to load persistent project state.
3. From here, every cycle is:
   user turn → \`c64re_whats_next\` → execute the recommended action
   (often via a Task subagent spawned with
   \`c64re_worker_phase(phase, artifact_id, role)\`) →
   \`agent_record_step(...)\` → next turn.

Do not skip phases without an explicit
\`agent_advance_phase(... evidence=...)\` call. Do not call
phase-bound tools out of order; the phase gate refuses politely
when \`projectProfile.phaseGateStrict\` is on.
${MARKER_END}`;

interface SetupOptions {
  agent: string;
  projectDir: string;
  mode?: "config" | "skill";
}

function parseArgs(args: string[]): SetupOptions {
  if (args.length === 0) {
    throw new Error("Usage: c64re setup <agent> [--project <path>] [--mode config|skill]\nAgents: claude, print");
  }
  const agent = args[0]!;
  let projectDir = process.cwd();
  let mode: "config" | "skill" | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--project") {
      projectDir = resolve(args[++i] ?? process.cwd());
    } else if (arg.startsWith("--project=")) {
      projectDir = resolve(arg.slice("--project=".length));
    } else if (arg === "--mode") {
      mode = args[++i] as "config" | "skill" | undefined;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length) as "config" | "skill";
    }
  }
  return { agent, projectDir, mode };
}

function patchClaudeMd(projectDir: string): { path: string; mode: "created" | "updated" | "unchanged" } {
  const claudePath = resolve(projectDir, "CLAUDE.md");
  let original = "";
  if (existsSync(claudePath)) {
    original = readFileSync(claudePath, "utf8");
  }
  const startIdx = original.indexOf(MARKER_START);
  const endIdx = original.indexOf(MARKER_END);
  let next: string;
  let mode: "created" | "updated" | "unchanged";
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = original.slice(0, startIdx);
    const after = original.slice(endIdx + MARKER_END.length);
    const candidate = `${before}${SETUP_BLOCK}${after}`.trimEnd() + "\n";
    if (candidate === original) {
      mode = "unchanged";
      next = original;
    } else {
      mode = "updated";
      next = candidate;
    }
  } else {
    const sep = original.endsWith("\n") || original.length === 0 ? "" : "\n";
    next = `${original}${sep}\n${SETUP_BLOCK}\n`;
    mode = original.length === 0 ? "created" : "updated";
  }
  if (mode !== "unchanged") {
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, next, "utf8");
  }
  return { path: claudePath, mode };
}

export async function runSetup(rawArgs: string[]): Promise<void> {
  const opts = parseArgs(rawArgs);
  switch (opts.agent) {
    case "claude": {
      const result = patchClaudeMd(opts.projectDir);
      process.stdout.write(`c64re setup: CLAUDE.md ${result.mode} at ${result.path}\n`);
      return;
    }
    case "print": {
      process.stdout.write(SETUP_BLOCK + "\n");
      return;
    }
    default:
      throw new Error(`Unsupported agent '${opts.agent}'. Supported: claude, print.`);
  }
}
