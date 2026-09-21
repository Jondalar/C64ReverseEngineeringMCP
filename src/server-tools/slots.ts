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
//
// 2026-09-12 — these tools return TEXT ONLY, and that is deliberate.
//
// They used to pair the formatted report with a `structuredContent` summary, and the MCP
// client shows only the structured half: the report was dropped on the floor every time.
// A fresh session put through the re-entry test found it and named it the worst gap of
// the run — `model_read`, the one tool built for exactly that entry, was the only one
// that told it nothing, because all it ever saw was {"boundaries":9,"orphans":121,...}.
// Counters instead of the model.
//
// agent_onboard was unaffected throughout: it returns text and nothing else, which is
// why the handover worked while these did not. So the rule here is the same — the reader
// is a model, the report is the product, and a machine summary that hides it is worse
// than no machine summary.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { SLOTS, SLOT_BY_ID, CONTAINER_SLOTS, type SlotId } from "../slots/schema.js";
import { slotReport, formatSlotReport } from "../slots/state.js";
import { capExceededText, missingRequiredText } from "./truncated-call.js";

const SLOT_IDS = SLOTS.map((s) => s.id) as [SlotId, ...SlotId[]];

/** How long a finding's headline may be. A number, not a schema `max()` — see the
 *  cap refusal in src/server-tools/truncated-call.ts for why that distinction is the
 *  whole point: a schema cap fires before the handler and answers with a validation
 *  dump, after the caller has already composed a multi-paragraph answer. */
const TITLE_MAX = 120;

/** Slots whose answer is not a claim about bytes, so no extract can back them. */
const NON_ARTEFACT_SLOTS = new Set<SlotId>(["S1", "S13", "S14"]);

/** First sentence, or first clause, capped — a name for a paragraph-long answer. */
function headline(answer: string, max = 90): string {
  const flat = answer.trim().replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const sentence = /^(.{20,}?[.;!?])(\s|$)/.exec(flat);
  const candidate = sentence && sentence[1].length <= max ? sentence[1] : flat;
  if (candidate.length <= max) return candidate.replace(/[.;]$/, "");
  const cut = candidate.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[,;.\s]+$/, "")}…`;
}

export function registerSlotTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "project_slots",
    "Completeness check: which of the 15 required relationships this project has named and which are still empty. Use before calling a project mapped, and whenever a door refuses on a slot. Not a to-do list (use agent_next_step). Inputs: optional project_dir, verbose. Returns: per-slot status + measured byte coverage.",
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
      };
    },
  );

  server.tool(
    "slot_record",
    "Fill one required slot: the answer to a required question, with the evidence for it. Use when a door refuses on an empty slot, or when you have just established one of the 15. Not for seeing which slots are still empty (use project_slots). `answer` and `evidence` are uncapped and stored whole, however long they run; only `title` is capped, at 120 characters, because it is the headline every finding list prints where a name belongs — over that this door refuses by name and hands back the headline it would have taken from your answer, so leaving `title` out is always safe. Inputs: slot id, answer, evidence, optional title (≤120 characters) and address range; S11 and S15 also require method. Returns: the finding written + the updated slot line.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      slot: z.enum(SLOT_IDS).describe("Which slot — see project_slots for the list and what each asks"),
      answer: z.string().min(10).describe("The answer itself, stated plainly. As long as it needs to be — it is stored in full as the finding's body."),
      // CAPPED, and checked in the handler rather than by the schema — same reason as
      // `evidence` below. A `max(120)` here fires inside the SDK, after a
      // multi-paragraph `answer` has already been composed, and answers with
      // "String must contain at most 120 character(s)" and nothing else.
      title: z.string().optional().describe("A short headline for the finding, ≤120 characters — this door checks it itself and, over the cap, refuses with the headline it would have taken from your answer, rather than with a schema error. Omit it and that headline is used; the full answer is kept in the finding's body either way, so omitting it loses nothing."),
      // REQUIRED, and checked in the handler rather than by the schema — see
      // src/server-tools/truncated-call.ts. A schema-level `Required` is the
      // wrong answer when the cause is a tool call that was cut short after a
      // multi-paragraph `answer`, which is how this one actually fails.
      evidence: z.string().min(10).optional().describe("REQUIRED: what you read or ran that establishes it — a listing, an address, a routine, a run. Write this BEFORE `answer` when the answer runs long."),
      address_start: z.number().int().nonnegative().optional().describe("Start of the address range this answer covers, if it has one"),
      address_end: z.number().int().nonnegative().optional().describe("End of that range (inclusive)"),
      count: z.number().int().nonnegative().optional().describe("For S5 (runtime count): HOW MANY resident runtimes, as a number. S6/S7 applicability is decided from this. Give it rather than leaving the number in the prose — \"Two permanently resident images and twelve swappable windows\" is a fine answer and no parser should have to pick the right number out of it."),
      method: z.enum(["read", "run", "chains", "bam"]).optional().describe("REQUIRED for S11 (free RAM): READING (a hypothesis) or RUNNING (settled)? Four corpus projects got this wrong in the same direction. REQUIRED for S15 (writable space): \"chains\" (every chain on the medium walked and subtracted — settles it) or \"bam\" (read off the BAM's free list — a hypothesis, and on a track/sector-addressed disk usually an inverted one)."),
      boundary_name: z.string().optional().describe("For S3, S5 and S8 — the container this answer names, e.g. \"stage 2 loader\" or \"resident engine\". Given together with an address range it also asserts the Spec 845 model boundary, so the model fills as a side effect of answering this question (845 D7)."),
      space: z.enum(["ram", "crt", "drv"]).default("ram").describe("Address space, when a boundary is being asserted alongside"),
      owner: z.string().optional().describe("Bind the boundary to ONE artifact owner; omit to span the space"),
    },
    async ({ project_dir, slot, answer, title, evidence, address_start, address_end, method, count, boundary_name, space, owner }) => {
      const pd = context.projectDir(project_dir, true);
      const def = SLOT_BY_ID.get(slot)!;

      if (evidence === undefined || evidence.trim().length < 10) {
        return {
          content: [{
            type: "text" as const,
            text: missingRequiredText({
              tool: "slot_record",
              missing: "evidence",
              what: "what you read or ran that establishes the answer — a listing, an address, a routine, a run. "
                + "A slot claim with no citation is the record the next session inherits and cannot check.",
              prose: [{ name: "answer", value: answer }, { name: "title", value: title }],
            }),
          }],
        };
      }

      if (title !== undefined && title.trim().length > TITLE_MAX) {
        return {
          content: [{
            type: "text" as const,
            text: capExceededText({
              tool: "slot_record",
              field: "title",
              limit: TITLE_MAX,
              value: title.trim(),
              role: "A title is a HEADLINE: it is what project_slots, list_findings and every other "
                + "reader prints where a name belongs, which is why it alone is capped.",
              suggestion: headline(title, TITLE_MAX),
              uncapped: { name: "answer", where: "it is stored whole as the finding's body" },
            }),
          }],
        };
      }

      if (slot === "S15" && !method) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "# slot_record refused — S15 needs its method.",
              "",
              "Writable space is the other slot where HOW you know is part of the answer.",
              "Pass method=\"chains\" if you walked every chain on the medium and subtracted",
              "them, method=\"bam\" if you read the BAM's free list — which is recorded as a",
              "hypothesis, because the BAM does not have to be true.",
              "",
              "Measured on Crazy News side 1 (issue #24): all 30 blocks the BAM called free",
              "were in use by an asset, and all 78 genuinely spare blocks were marked",
              "allocated — disjoint in both directions. A patch step asked the BAM for a",
              "spare block, got T1/S1, and overwrote the chain head of another asset.",
            ].join("\n"),
          }],
        };
      }

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
      const tags = [`slot:${slot}`, ...(method ? [`method:${method}`] : []), ...(count !== undefined ? [`count:${count}`] : [])];
      // A slot answer that needs a sentence used to BECOME the title, and everything
      // that lists findings then printed a paragraph where a name belongs. The answer
      // is kept whole in the body — every reader that parses a slot claim reads title
      // and summary together — and the title is a headline.
      const finding = rec.saveFinding({
        kind: slot === "S11" ? "memory-map" : "observation",
        title: title?.trim() || headline(answer),
        summary: `${def.name} (Spec 844 ${slot}).\n\n${answer.trim()}\n\nEvidence: ${evidence}`,
        tags,
        // The evidence goes in evidence[], not only into the summary prose. The first
        // real session exposed this as an own goal: slot_record's own findings tripped
        // 846's `finding-without-evidence` check, because the text said "Evidence: ..."
        // where nothing machine-readable was looking.
        evidence: [{ kind: "note", title: `${def.name} (${slot})`, note: evidence, capturedAt: new Date().toISOString() }],
        // Spec 848 — Spec 752's L1 tags a finding `ungrounded` when it cites no backing
        // extract, and the first unattended run turned that into a deadlock: the agent
        // complied with the S4 gate, filled five slots, and every one of those became an
        // ungrounded finding that jammed the step recommender for the rest of the session.
        //
        // Part of the fix is here. L1 says "every finding ABOUT A FILE/PAYLOAD must cite a
        // backing extract" — and S1 (which game is this) and S13 (the evidence standard)
        // are not about a file. They are marked as such rather than left to look like
        // unfinished work, which is a carve-out in the rule's own words, not a loophole.
        ...(NON_ARTEFACT_SLOTS.has(slot) ? { tags: [...tags, "not-artifact-scoped"] } : {}),
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
            `Title: ${finding.title}`,
            ...(finding.title !== answer.trim()
              ? ["  (the full answer is the finding's body — pass `title` to choose your own headline)"]
              : []),
            boundary,
            line ? `Slot is now: ${line.status} — ${line.detail}` : "",
            "",
            report.missing.length > 0
              ? `Still open: ${report.missing.map((s) => `${s.slot.id} ${s.slot.name}`).join(", ")}`
              : "Every required slot is now filled.",
          ].filter(Boolean).join("\n"),
        }],
      };
    },
  );
}
