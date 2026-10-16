// runtime_state_map — a game mapped by its moves: every state reachable from an anchor, the moves between them,
// the crashes, and the shortest way to a goal, kept in the project's graph. `c64re state map <file.json>` calls
// the same function (src/statemap/run.ts), so a script and the LLM get the same answer.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerStateMapTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_state_map",
    "Map a game by its moves, with no stepping and no per-move calls on your side: from an anchor, try every move in every state it finds, on a private machine of its own (the shared machine is not touched, and the machine is gone before the answer is read). "
    + "You say what a state is (`key`: the bytes the game's own code indexes rooms, screens or levels with, e.g. [\"$02\",\"$03\"], \"$0400:2\", \"$D020@io\" - read from the code, never a timer, a frame counter or a sprite position), which moves exist (`actions`: L R U D F N, combinations such as \"UF\", keys as key:SPACE), and what counts as dead or as the goal (`goal`: \"$03 == 1\", also != < > <= >= and a mask \"$03 & $80 == $80\"). "
    + "Each state is reached by restoring its checkpoint, never by replay from boot. A JAM is a crash state with its PC. "
    + "Answers: complete / stopped at a cap (and which) / goal reached; the states with their key values and first path, the moves that change the state, the crashes and, with a goal, the shortest path to it with its frame count (a goal stops the search at the first, shortest path; continue_after_goal maps on). "
    + "The map is saved in the project's graph (a state_map node, a game_state node per state, a MOVES_TO edge per move, STARTS_FROM the anchor) and found again by project_search and graph_find; the same call again answers from the graph and starts no machine. "
    + "The goal state is written as an anchor `<name>.goal` (save_states: every state, as `<name>.s<N>`), so a .feature file (runtime_feature_run) or the next map can start there: solve a game in segments. "
    + "Use for structure questions (which rooms exist, how to reach the last one, what crashes and how to get there). Never drive a game by hand with one runtime call per move, and never write your own explorer. Not for a search over timing, analogue paddles or random seeds, and not for trying a fix (use runtime_feature_run). "
    + "Inputs: anchor (a name from runtime_anchor_set, set at the loop where the game waits for input), key[], actions[], port? (default 2), frames? (held, default 6), release_frames? (default 4), dead[]?, goal?, continue_after_goal?, max_states? (400), max_runs? (3000), max_depth? (64), budget_minutes? (10), save_states?, name? (default: the anchor's name), edges? (\"all\" lists every move tried), json?, project_dir?. "
    + "Returns: the outcome first, then states, moves, crashes, the goal path and what was saved.",
    {
      anchor: z.string().describe("A 911 anchor by name: the file knowledge/anchors/<name>.c64re"),
      key: z.array(z.string()).describe('The bytes that make a state: "$02", "$0400:2" (2 bytes), "$D020@io" (a lens: cpu, ram, io, rom, cart)'),
      actions: z.array(z.string()).describe('The moves: L R U D F N, combinations like "UF", keys like "key:SPACE"'),
      port: z.number().optional().describe("Joystick port (default 2)"),
      frames: z.number().optional().describe("Frames a move is held (default 6)"),
      release_frames: z.number().optional().describe("Frames run after it is released (default 4)"),
      dead: z.array(z.string()).optional().describe('Conditions that end a branch, e.g. "$05 == 0"'),
      goal: z.string().optional().describe('The goal, e.g. "$03 == 1"; the search stops at the first, shortest way there'),
      continue_after_goal: z.boolean().optional().describe("Keep mapping after the goal is found"),
      max_states: z.number().optional().describe("Default 400"),
      max_runs: z.number().optional().describe("Default 3000"),
      max_depth: z.number().optional().describe("Default 64"),
      budget_minutes: z.number().optional().describe("The machine's wall-clock budget; default 10"),
      save_states: z.boolean().optional().describe("Write every state as an anchor file <name>.s<N>"),
      name: z.string().optional().describe("The map's name (and the stem of the anchors it writes); default: the anchor's name"),
      edges: z.enum(["changes", "all"]).optional().describe('"all" lists every move tried, the ones that leave the state as it was too'),
      json: z.boolean().optional().describe("Return the JSON document instead of the text"),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_state_map", async ({ json, project_dir, ...input }) => {
      const projectDir = context.projectDir(project_dir ? { projectDir: project_dir } : undefined, true);
      const { Refusal, describeSearch } = await import("../statemap/describe.js");
      try {
        // Refused before any machine: the description first, then the key against what the project has read.
        const spec = describeSearch(input);
        const { resolveCitation } = await import("./citation-resolver.js");
        const cite = await resolveCitation(spec.key.map((k) => `$${k.addr.toString(16).padStart(4, "0")}`).join(" "), projectDir);
        if (!cite.resolved) {
          throw new Refusal("key", `${cite.detail}. A key is the bytes the game's own code indexes rooms or levels with: read that code first (disasm / graph_find), then name those addresses`);
        }
        const { runStateMap } = await import("../statemap/run.js");
        const { renderAnswer, answerJson } = await import("../statemap/render.js");
        const answer = await runStateMap(input, { projectDir });
        return text(json ? JSON.stringify(answerJson(answer), null, 2) : renderAnswer(answer));
      } catch (e) {
        if (e instanceof Refusal) return text(e.message);
        throw e;
      }
    }),
  );
}
