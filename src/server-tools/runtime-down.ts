// Spec 902 D2 — `runtime_down`: `c64re down` as a tool, for the owner who asks for it.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

export function registerRuntimeDownTool(server: McpServer, _context: ServerToolContext): void {
  server.tool(
    "runtime_down",
    "OWNER ACTION — shut C64RE down: the workbench UI, the C64 Ultimate bridges, the sandboxes and the runtime daemon, every one of them recorded in the process ledger, in that order; then the selection and the bridge registry are removed and a hold is written, so nothing starts again by itself until `c64re up`, `c64re ui`, runtime_session_start or selecting a C64 Ultimate. THIS ENDS THE SHARED MACHINE THE HUMAN CO-DRIVES: its sessions, mounted media, checkpoints and rewind history are gone. Use it only when the owner has just asked for C64RE to be shut down. Not for cleaning up after your own work (a sandbox you started ends itself; use runtime_session_close to release a session), not for recovering from a stalled call, not as a step of a plan. A process whose pid no longer matches its record is dropped, never signalled; a process on a known port that C64RE did not start is named and left alone, and the answer then says what is left. Inputs: project_dir (end only that project's processes; no hold is written, the selection stays), keep (leave one kind running: ui, bridge, sandbox or daemon). Returns: one line per process (pid, port, what happened) and what, if anything, is still there. To see what runs without ending it: project_status, or `c64re status` in a terminal.",
    {
      project_dir: z.string().optional().describe("End only this project's processes. No hold is written and the selection stays."),
      keep: z.array(z.enum(["ui", "bridge", "sandbox", "daemon"])).optional().describe("Leave these kinds running, e.g. [\"daemon\"] stops only the UI."),
    },
    safeHandler("runtime_down", async ({ project_dir, keep }) => {
      const { runDown } = await import("../runtime/down.js");
      const r = await runDown({ by: "runtime_down (the assistant, at the owner's request)", project: project_dir, keep });
      return { content: [{ type: "text" as const, text: r.text }] };
    }),
  );
}
