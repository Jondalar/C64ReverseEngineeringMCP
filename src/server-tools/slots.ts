// Spec 844 — the two doors onto the slot list.
//
// `project_slots` answers the COMPLETENESS question: for this disk set, these
// relationships are unnamed, here they are. That is not the same question
// `agent_next_step` answers — that one is a TO-DO ("what do I do now"), derived from
// project state and useful, but it cannot tell you what was never asked.
//
// `slot_record` fills one. It exists rather than leaning on a raw `save_finding` tag
// because a slot claim has a required shape: which slot, the answer, and the evidence
// for it. S11 additionally demands the METHOD, because four corpus projects claimed free
// RAM from reading and all four were corrected by running.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { SLOTS, SLOT_BY_ID, CONTAINER_SLOTS, type SlotId } from "../slots/schema.js";
import { slotReport, formatSlotReport } from "../slots/state.js";

const SLOT_IDS = SLOTS.map((s) => s.id) as [SlotId, ...SlotId[]];

export function registerSlotTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "project_slots",
    "Completeness check: which of the 14 required relationships (Spec 844) this project has named and which are still empty. Use before calling a project mapped, and whenever a door refuses on a slot. Not a to-do list (use agent_next_step). Inputs: optional project_dir, verbose. Returns: per-slot status + measured byte coverage.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      verbose: z.boolean().default(false).describe("Also print what each open slot asks and what would fill it"),
    },
    async ({ project_dir, verbose }) => {
      const pd = context.projectDir(project_dir);
      const report = await slotReport(pd);
      let text = formatSlotReport(report);
      if (verbose && report.missing.length > 0) {
        text += "\n\nOpen slots in full:\n";
        for (const s of report.missing) {
          text += `\n${s.slot.id} — ${s.slot.name}\n`;
          text += `  asks: ${s.slot.question}\n`;
          text += `  fill: ${s.slot.fills}\n`;
          if (s.slot.because) text += `  why:  ${s.slot.because}\n`;
        }
      }
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          coverage: report.coverage,
          slots: report.states.map((s) => ({ id: s.slot.id, name: s.slot.name, status: s.status, detail: s.detail })),
          missing: report.missing.map((s) => s.slot.id),
        },
      };
    },
  );

  server.tool(
    "slot_record",
    "Fill one Spec 844 slot: the answer to a required question, with the evidence for it. Use when a door refuses on an empty slot, or when you have just established one of the 14. Inputs: slot id, answer, evidence, optional address range; S11 also requires method. Returns: the finding written + the updated slot line.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      slot: z.enum(SLOT_IDS).describe("Which slot — see project_slots for the list and what each asks"),
      answer: z.string().min(10).describe("The answer itself, stated plainly. This becomes the finding's title."),
      evidence: z.string().min(10).describe("What you read or ran that establishes it — a listing, an address, a routine, a run"),
      address_start: z.number().int().nonnegative().optional().describe("Start of the address range this answer covers, if it has one"),
      address_end: z.number().int().nonnegative().optional().describe("End of that range (inclusive)"),
      method: z.enum(["read", "run"]).optional().describe("REQUIRED for S11 (free RAM): was this established by READING (a hypothesis) or by RUNNING (settled)? Four corpus projects got this wrong in the same direction."),
      boundary_name: z.string().optional().describe("For S3, S5 and S8 — the container this answer names, e.g. \"stage 2 loader\" or \"resident engine\". Given together with an address range it also asserts the Spec 845 model boundary, so the model fills as a side effect of answering this question (845 D7)."),
      space: z.enum(["ram", "crt", "drv"]).default("ram").describe("Address space, when a boundary is being asserted alongside"),
      owner: z.string().optional().describe("Bind the boundary to ONE artifact owner; omit to span the space"),
    },
    async ({ project_dir, slot, answer, evidence, address_start, address_end, method, boundary_name, space, owner }) => {
      const pd = context.projectDir(project_dir, true);
      const def = SLOT_BY_ID.get(slot)!;

      if (slot === "S11" && !method) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "# slot_record refused — S11 needs its method.",
              "",
              "Free RAM is the one slot where HOW you know is part of the answer. Pass",
              "method=\"run\" if a run established it, method=\"read\" if you derived it from",
              "the listing — a read-derived claim is recorded as a hypothesis and does not",
              "open the doors that allocate.",
              "",
              "In the corpus of seven projects, four claimed free RAM from reading and all",
              "four were corrected by running. That is why this is asked rather than assumed.",
            ].join("\n"),
          }],
        };
      }

      const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
      const rec = new KnowledgeRecords(pd);
      const tags = [`slot:${slot}`, ...(method ? [`method:${method}`] : [])];
      const finding = rec.saveFinding({
        kind: slot === "S11" ? "memory-map" : "observation",
        title: answer,
        summary: `${def.name} (Spec 844 ${slot}). Evidence: ${evidence}`,
        tags,
        ...(address_start !== undefined && address_end !== undefined
          ? { addressRange: { start: address_start, end: address_end } }
          : {}),
      });

      // 845 D7 — a container-shaped slot also draws its boundary, when the caller gave
      // enough to draw it. Not refused when they did not: S3 can be answered for a stage
      // whose extent is not yet known, and demanding the range would push the answer out
      // of the graph and into prose, which is the failure both specs exist to stop.
      let boundary = "";
      const level = CONTAINER_SLOTS.get(slot);
      if (level && boundary_name && address_start !== undefined && address_end !== undefined) {
        const { assertBoundary } = await import("../model/store.js");
        const node = await assertBoundary(pd, {
          name: boundary_name, level,
          start: address_start, end: address_end,
          description: answer, evidence: [evidence], slot,
          space, owner,
        });
        boundary = `Boundary asserted: ${level} "${node.name}" $${node.start.toString(16).padStart(4, "0")}-$${node.end.toString(16).padStart(4, "0")}`;
      } else if (level && !boundary_name) {
        boundary = `Note: ${slot} is container-shaped. Pass boundary_name with a range and it also lands in the model (model_read).`;
      }

      const report = await slotReport(pd);
      const line = report.states.find((s) => s.slot.id === slot);
      return {
        content: [{
          type: "text" as const,
          text: [
            `Recorded ${slot} — ${def.name}: ${finding.id}`,
            boundary,
            line ? `Slot is now: ${line.status} — ${line.detail}` : "",
            "",
            report.missing.length > 0
              ? `Still open: ${report.missing.map((s) => `${s.slot.id} ${s.slot.name}`).join(", ")}`
              : "Every required slot is now filled.",
          ].filter(Boolean).join("\n"),
        }],
        structuredContent: { findingId: finding.id, slot, status: line?.status ?? "unknown" },
      };
    },
  );
}
