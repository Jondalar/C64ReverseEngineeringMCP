// Spec 845 — the two doors onto the model layer.
//
// `model_assert` states a boundary. `model_read` is D6: the one call a session makes
// after a /new, returning the model, what is open, and what was already refuted.
//
// There is deliberately no `model_build`. Nothing here derives boundaries from the graph
// by heuristic: "the engine lives at $0200-$437E" is a judgement, and a heuristic that
// guessed it would produce exactly the confident-and-wrong record this spec exists to
// stop. Membership underneath the boundary IS derived, and that is the whole split
// (D2) — a dozen judgements index eleven thousand nodes.
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
import { MODEL_LEVELS } from "../model/types.js";
import { assertBoundary, listBoundaries, removeBoundary, ModelBoundaryError } from "../model/store.js";
import { modelReport, formatModel, membersInRangeBySpace } from "../model/rollup.js";
import { reentryPackage, formatReentry } from "../model/reentry.js";
import { missingRequiredText } from "./truncated-call.js";

export function registerModelTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "model_assert",
    "State one boundary of the project's model: a named address range at a level (system/container/component) with the evidence for it. Use when you have established what a region IS. Membership underneath is computed, never passed. Not for a claim about behaviour (use save_finding). Inputs: name, level, range, description, evidence. Returns: the boundary + what now falls inside it.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      name: z.string().min(2).describe("What this region is called, e.g. \"resident engine\" or \"stage 2 loader\""),
      level: z.enum(MODEL_LEVELS).describe("system = the whole thing; container = a deployable unit (a file, a resident image, a bank); component = a part inside one"),
      address_start: z.number().int().min(0).max(0xffff).describe("First address of the range"),
      address_end: z.number().int().min(0).max(0xffff).describe("Last address, inclusive"),
      description: z.string().min(10).describe("What it IS and what it owns, in your words"),
      // REQUIRED, checked in the handler — see src/server-tools/truncated-call.ts.
      evidence: z.array(z.string().min(3)).min(1).optional().describe("REQUIRED: what you read that establishes this boundary — a file header, a listing line, a routine. A boundary without a citation is the claim the next session inherits and cannot check. Write this BEFORE `description` when the description runs long."),
      space: z.enum(["ram", "crt", "drv"]).default("ram").describe("Address space this boundary lives in"),
      owner: z.string().optional().describe("Bind the boundary to ONE artifact owner (e.g. \"07_game\"). Omit to span everything in the space at that range."),
      bank: z.number().int().min(0).optional().describe("Cartridge bank, for space=crt"),
    },
    async (args) => {
      const pd = context.projectDir(args.project_dir, true);
      if (args.evidence === undefined || args.evidence.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: missingRequiredText({
              tool: "model_assert",
              missing: "evidence",
              what: "what you read that establishes this boundary — a file header, a listing line, a routine. "
                + "A boundary without a citation is the claim the next session inherits and cannot check (Spec 845 D3).",
              prose: [{ name: "description", value: args.description }],
            }),
          }],
        };
      }
      try {
        const node = await assertBoundary(pd, {
          name: args.name, level: args.level,
          start: args.address_start, end: args.address_end,
          description: args.description, evidence: args.evidence,
          space: args.space, owner: args.owner, bank: args.bank,
        });
        const report = await modelReport(pd);
        const mine = report.membership.find((m) => m.containerId === node.id);
        const kinds = mine && mine.members > 0
          ? Object.entries(mine.byKind).map(([k, v]) => `${v} ${k}`).join(", ")
          : "nothing yet — no analysed nodes fall in this range";
        // An empty boundary used to stop at that sentence, and it is the wrong
        // sentence whenever the bytes exist under a different address space.
        // `$0300-$07FF` is the C64's and the 1541's at once, which is the case
        // `space` exists for — and a drive-side listing only lands in `drv` if
        // something recorded that its owner runs on the 1541.
        const elsewhere: string[] = [];
        if (!mine || mine.members === 0) {
          const inRange = (await membersInRangeBySpace(pd, node.start, node.end))
            .filter((r) => r.space !== node.space || (node.owner !== null && r.owner !== node.owner));
          if (inRange.length > 0) {
            const total = inRange.reduce((n, r) => n + r.count, 0);
            elsewhere.push(
              `  but $${hex(node.start)}-$${hex(node.end)} holds ${total} node(s) this boundary does not claim: `
              + inRange.slice(0, 4).map((r) => `${r.count} in ${r.space}${r.owner ? `/${r.owner}` : ""}`).join(", ")
              + (inRange.length > 4 ? `, …` : ""),
            );
            if (inRange.some((r) => r.space !== node.space)) {
              elsewhere.push(
                `  This boundary is in space "${node.space}". A node's space comes from the machine its owner runs on:`,
                `  drive code lands in "drv" once that is recorded — pass platform="c1541" to disasm_prg (it records it`,
                `  for the owner), or declare it once with \`c64re graph machine <owner> c1541\` and re-import.`,
              );
            } else {
              elsewhere.push(`  This boundary is bound to owner "${node.owner}"; omit owner to span the whole space at that range.`);
            }
          }
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              `${node.level} "${node.name}" $${hex(node.start)}-$${hex(node.end)} [${node.space}${node.owner ? `/${node.owner}` : ""}]`,
              `  contains: ${kinds}`,
              ...elsewhere,
              `  model now: ${report.nodes.length} boundaries, ${report.memberTotal - report.orphans.length}/${report.memberTotal} nodes placed, ${report.orphans.length} orphaned`,
            ].join("\n"),
          }],
        };
      } catch (e) {
        if (e instanceof ModelBoundaryError) {
          return { content: [{ type: "text" as const, text: `# model_assert refused\n\n${e.message}` }] };
        }
        throw e;
      }
    },
  );

  server.tool(
    "model_read",
    "The re-entry read: the whole project model in one call — boundaries with citations, the edges between them, what is still open, and what was ALREADY REFUTED so it is not re-derived. Use at the start of a session, after a compact, or whenever the thread is lost. Not for which of the 15 required relationships are still empty (use project_slots). Inputs: optional project_dir. Returns: the model as text.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      model_only: z.boolean().default(false).describe("Only the boundaries and their edges, without the open/refuted sections"),
    },
    async ({ project_dir, model_only }) => {
      const pd = context.projectDir(project_dir);
      if (model_only) {
        const r = await modelReport(pd);
        return { content: [{ type: "text" as const, text: formatModel(r) }] };
      }
      const p = await reentryPackage(pd);
      return {
        content: [{ type: "text" as const, text: formatReentry(p) }],
      };
    },
  );

  server.tool(
    "model_remove",
    "Remove one asserted boundary. Use when a boundary turns out to be wrong — the members underneath are untouched, they simply become orphans again. Not for a boundary that is merely imprecise — assert it again instead (use model_assert). Inputs: boundary id (from model_read). Returns: what changed.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      id: z.string().min(3).describe("The boundary id, as model_read prints it"),
    },
    async ({ project_dir, id }) => {
      const pd = context.projectDir(project_dir, true);
      const before = (await listBoundaries(pd)).length;
      const gone = await removeBoundary(pd, id);
      const after = await modelReport(pd);
      return {
        content: [{
          type: "text" as const,
          text: gone
            ? `Removed ${id}. ${before} -> ${after.nodes.length} boundaries, ${after.orphans.length} orphans.\nIf it was wrong rather than redundant, record WHY as a refutation — that is what stops the next session re-deriving it.`
            : `No asserted boundary with id ${id}.`,
        }],
      };
    },
  );
}

function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
