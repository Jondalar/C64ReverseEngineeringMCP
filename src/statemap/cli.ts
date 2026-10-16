// `c64re state map <file.json>` — the same function the MCP tool `runtime_state_map` calls (run.ts), so a script
// and the LLM get the same answer. The file holds the tool's inputs as JSON.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectRoot } from "../project-root.js";
import { Refusal } from "./describe.js";
import { answerJson, renderAnswer } from "./render.js";
import { runStateMap } from "./run.js";

const USAGE = [
  "c64re state map <file.json> [--project <dir>] [--json]",
  "",
  "  Maps a game by its moves: from an anchor, every move in every state it finds, on a machine of its own.",
  "  The file holds the inputs of the MCP tool runtime_state_map:",
  '    { "anchor": "maze_loop", "key": ["$02","$03"], "actions": ["L","R","U","D","F","N"],',
  '      "goal": "$03 == 1", "frames": 6, "release_frames": 4, "max_states": 400 }',
  "  Optional: port, dead[], continue_after_goal, max_runs, max_depth, budget_minutes, save_states, name, edges.",
  "  The map is saved in the project's graph; the same file again answers from the graph.",
  "",
  "  --project <dir>  the project the anchor lives in (default: found by walking up from the file, else the current directory)",
  "  --json           the answer as one JSON document",
  "  Exit 0 when the map is complete or the goal was reached, 1 when a cap stopped it or the key follows time (not a usable map), 2 when the description was refused or the run failed.",
];

export async function runStateCli(argv: string[]): Promise<void> {
  if (argv[0] !== "map" || argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE.join("\n"));
    if (argv[0] !== "map" && !argv.includes("--help") && !argv.includes("-h")) process.exitCode = 2;
    return;
  }
  const args = argv.slice(1);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const projectArg = opt("--project");
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const unknown = rest.find((a) => a.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  if (rest.length !== 1) throw new Error("give one .json file");
  const file = resolve(rest[0]!);
  let input: Record<string, unknown>;
  try { input = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch (e) { throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`); }
  const projectDir = projectArg ? resolve(projectArg) : findProjectRoot(resolve(file, "..")) ?? process.cwd();
  try {
    const answer = await runStateMap(input, { projectDir });
    console.log(json ? JSON.stringify(answerJson(answer), null, 2) : renderAnswer(answer));
    process.exitCode = answer.result.outcome.kind === "stopped" || answer.result.keyFollowsTime ? 1 : 0;
  } catch (e) {
    if (e instanceof Refusal) { console.log(e.message); process.exitCode = 2; return; }
    throw e;
  }
}
