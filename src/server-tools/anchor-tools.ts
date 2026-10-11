// Anchors — named instants in the checkpoint ring, as doors.
//
// The ring (TRX64) holds the machine state; a name on one of its checkpoints is a mark
// (`mark/set|list|drop|goto`, 32 at most). These four tools are the LLM's way to say "this
// instant" and come back to it. Set, list and drop disturb nothing; goto moves the shared machine.
// When a project is open, what an anchor MEANT (name, cycle, frame, why) is also written into its
// graph, so it outlives the ring. `runtime_mark` is a different thing and stays: a phase label
// written into a running trace.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

interface MarkRow { name: string; anchorId: string; cycle: number; frame?: number | null; secondsBack?: number }

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** The project an anchor is recorded in: the one the call names or the session works in; none when there is none. */
function projectOf(context: ServerToolContext, project_dir?: string): string | undefined {
  try { return context.projectDir(project_dir ? { projectDir: project_dir } : undefined, false); } catch { return undefined; }
}

async function daemon() {
  const { runtimeDaemon } = await import("../runtime/backend.js");
  return runtimeDaemon;
}

/** The daemon's refusal text, verbatim, as the answer — never an empty success. */
function refusal(tool: string, e: unknown): ReturnType<typeof text> {
  const msg = e instanceof Error ? e.message : String(e);
  return text(`${tool}: refused by the runtime — ${msg}`);
}

export function registerAnchorTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_anchor_set",
    "Name the instant the shared machine is at NOW, so you can come back to it and start sandbox runs from it. "
    + "Captures a fresh checkpoint of the shared session and puts the name on it (so the anchor is the instant you saw, not an auto-capture up to 20 ms old). "
    + "Does not move, pause or change the machine. Only at the head of the ring: after a goto (replay) it is refused until the transport is back at the head, because the runtime would name the older checkpoint under the cursor and replace its name. 32 anchors at most; a 33rd, or a name already taken, is refused with the runtime's own text. "
    + "In an open project the anchor is also recorded in the graph (name, cycle, frame, why) and outlives the ring. "
    + "Use before the interesting thing happens: just before a level loads, the frame before a sprite goes wrong. "
    + "Not a trace label (use runtime_mark) and not a plain checkpoint (use runtime_checkpoint_capture). "
    + "Inputs: name, why?, session_id?, project_dir?. Returns: the anchor with its cycle and frame, and how many of the 32 are used.",
    {
      name: z.string().min(1).describe("The anchor's name, e.g. vor_level3"),
      why: z.string().optional().describe("What this instant is for — kept in the project graph"),
      session_id: z.string().optional().describe("Session; default \"shared\""),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_anchor_set", async ({ name, why, session_id, project_dir }) => {
      const d = await daemon();
      const sid = session_id ?? "shared";
      // The runtime names the checkpoint under the transport cursor. At the head that is the capture
      // below; scrubbed back (after a goto, say) it is an OLDER checkpoint, which may already carry a
      // name — and a second name REPLACES the first. So an anchor is only set at the head.
      try {
        const t = await d.call<{ atHead?: boolean; frameTotal?: number; frameIndex?: number }>("transport/status", {});
        if (t.atHead === false) {
          return text(`runtime_anchor_set: not set — the shared machine stands in replay (frame ${t.frameIndex ?? "?"} of ${t.frameTotal ?? "?"}), not at the head of the ring. The runtime names the checkpoint under the transport cursor, which is an older one and may already carry another name that this would replace. Return to the head first (runtime_monitor \`goto ${t.frameTotal ?? "<last frame>"}\`), then set the anchor.`);
        }
      } catch { /* a runtime without a transport answers the set itself */ }
      let cap: { ref?: { id?: string; cycles?: number } } | undefined;
      try { cap = await d.checkpointCapture<{ ref?: { id?: string; cycles?: number } }>(sid); } catch (e) { return refusal("runtime_anchor_set", e); }
      let r: { mark: MarkRow; used: number; cap: number; message?: string };
      try { r = await d.call("mark/set", { name }); } catch (e) { return refusal("runtime_anchor_set", e); }
      const lines = [`ANCHOR ${r.mark.name} — cycle ${r.mark.cycle}, frame ${r.mark.frame ?? "?"} (checkpoint ${r.mark.anchorId}); ${r.used} of ${r.cap} anchors used.`];
      if (cap?.ref?.id && cap.ref.id !== r.mark.anchorId) {
        lines.push(`Note: the transport cursor is not at the head of the ring, so the runtime marked the checkpoint under the cursor (${r.mark.anchorId}, cycle ${r.mark.cycle}), not the one just captured (${cap.ref.id}, cycle ${cap.ref.cycles}). Resume to the head and set again if you meant the live instant.`);
      }
      const proj = projectOf(context, project_dir);
      if (proj) {
        try {
          const { recordAnchor, projectHoldsGraph } = await import("../anchors/graph.js");
          if (!projectHoldsGraph(proj)) lines.push(`Not recorded: ${proj} is not an initialised project (no knowledge/project.json).`);
          else {
            const id = recordAnchor(proj, { name, anchorId: r.mark.anchorId, cycle: r.mark.cycle, frame: r.mark.frame ?? undefined, why, setAt: new Date().toISOString() });
            lines.push(`Recorded in the project graph as ${id}.`);
          }
        } catch (e) { lines.push(`Not recorded in the project graph: ${e instanceof Error ? e.message : String(e)}`); }
      } else {
        lines.push("No project open: the anchor lives in the ring only and ends with the daemon.");
      }
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_anchor_list",
    "List the named anchors of the shared machine: name, cycle, frame, how far back they are, and which are only remembered in the project because the ring no longer holds them. "
    + "Reads only — nothing moves. Use to see what you can start a candidate or a goto from. "
    + "Not the full checkpoint list (use runtime_checkpoint_list). Inputs: session_id?, project_dir?. Returns: the anchors, the 32-slot use, and the anchors recorded in the project but gone from the ring.",
    { session_id: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_anchor_list", async ({ project_dir }) => {
      const d = await daemon();
      let r: { marks: MarkRow[]; cap: number; used: number; windowSeconds?: number };
      try { r = await d.call("mark/list", {}); } catch (e) { return refusal("runtime_anchor_list", e); }
      const lines = [`${r.used} of ${r.cap} anchors in the ring:`];
      for (const m of r.marks) lines.push(`  ${m.name}  cycle ${m.cycle}  frame ${m.frame ?? "?"}  ${m.secondsBack !== undefined ? `${m.secondsBack.toFixed(1)} s back` : ""}  (${m.anchorId})`);
      if (r.marks.length === 0) lines.push("  (none)");
      const proj = projectOf(context, project_dir);
      if (proj) {
        const { listRecordedAnchors } = await import("../anchors/graph.js");
        const inRing = new Set(r.marks.map((m) => m.name));
        const gone = listRecordedAnchors(proj).filter((a) => !inRing.has(a.name));
        if (gone.length > 0) {
          lines.push("", "Recorded in the project, not in the ring any more (set the anchor again at that moment to use it):");
          for (const a of gone) lines.push(`  ${a.name}  cycle ${a.cycle ?? "?"}  frame ${a.frame ?? "?"}${a.droppedAt ? "  (dropped)" : ""}${a.why ? `  — ${a.why}` : ""}`);
        }
      }
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_anchor_drop",
    "Drop an anchor's name, freeing one of the 32 slots; the checkpoint itself ages out of the ring as usual. "
    + "Does not touch the machine. In an open project the recorded anchor stays, marked dropped, because candidates link to it. "
    + "Not for removing a checkpoint pin (use runtime_checkpoint_unpin). Inputs: name, session_id?, project_dir?. Returns: what was dropped, or the runtime's refusal.",
    { name: z.string().min(1), session_id: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_anchor_drop", async ({ name, project_dir }) => {
      const d = await daemon();
      let r: { dropped: string; cycles?: number };
      try { r = await d.call("mark/drop", { name }); } catch (e) { return refusal("runtime_anchor_drop", e); }
      const lines = [`DROPPED ${r.dropped} (it was at cycle ${r.cycles ?? "?"}).`];
      const proj = projectOf(context, project_dir);
      if (proj) {
        try {
          const { projectHoldsGraph, readAnchor, recordAnchor } = await import("../anchors/graph.js");
          if (projectHoldsGraph(proj) && readAnchor(proj, name)) {
            recordAnchor(proj, { name, droppedAt: new Date().toISOString() });
            lines.push("The project keeps the record, marked dropped.");
          }
        } catch { /* the drop is done; the record is a convenience */ }
      }
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_anchor_goto",
    "Go to an anchor: this MOVES the shared machine — the one the human is watching and co-driving — it jumps back (or forward) to the anchor's checkpoint and pauses there, and the human at the UI sees the same jump. "
    + "Use to return to a named instant and inspect it or continue from it. "
    + "Not for starting sandbox runs (a candidate or runtime_sandbox_run starts from an anchor without moving anything). "
    + "An anchor the ring no longer holds is said to be gone, with the cycle recorded for it. Inputs: name, session_id?, project_dir?. Returns: the transport line after the jump, or the runtime's refusal.",
    { name: z.string().min(1), session_id: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_anchor_goto", async ({ name, project_dir }) => {
      const d = await daemon();
      try {
        const r = await d.call<{ line?: string; cycles?: number; frame?: number }>("mark/goto", { name });
        return text(`AT ${name} — cycle ${r.cycles ?? "?"}. The shared machine is paused here.\n${r.line ?? ""}`.trim());
      } catch (e) {
        const proj = projectOf(context, project_dir);
        if (proj) {
          const { readAnchor } = await import("../anchors/graph.js");
          const rec = readAnchor(proj, name);
          if (rec) {
            return text(`runtime_anchor_goto: refused by the runtime — ${e instanceof Error ? e.message : String(e)}\nThe project remembers "${name}" (cycle ${rec.cycle ?? "?"}, frame ${rec.frame ?? "?"}${rec.why ? `, ${rec.why}` : ""}), but the ring no longer holds it. Bring the machine to that cycle and set the anchor again.`);
          }
        }
        return refusal("runtime_anchor_goto", e);
      }
    }),
  );
}
