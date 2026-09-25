// Spec 848 — the contract's doors.
//
// `contract_show` prints it and, when there is none, prints the questions a kickoff
// asks. `contract_set` writes it.
//
// C64RE supplies the questions; the HARNESS conducts the dialog. Same division as Spec
// 846 D5 — handing over a question is not driving a model, and it is the only reason this
// is allowed to exist next to Spec 773 decision #1.
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
import { loadContract, saveContract, formatContract, KICKOFF_QUESTIONS, type ProjectContract } from "../contract/contract.js";
import { formatWaivers } from "../contract/standing.js";

export function registerContractTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "contract_show",
    "What this project owes: the human's stated expectations — which of the 15 slots apply here, what must be annotated, what must be written up, and the thresholds. With no contract set, returns the questions a kickoff should ask. Use at session start and before calling anything done. Not for writing the expectations down (use contract_set). Inputs: optional project_dir. Returns: the contract or the questions.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
    },
    async ({ project_dir }) => {
      const pd = context.projectDir(project_dir);
      const { contract, present } = loadContract(pd);
      const lines = [formatContract(contract, present)];
      // Spec 877 D2 — a waiver nobody can see from outside is not a record. It prints
      // here, under the promise it releases, for as long as it holds.
      const waived = formatWaivers(pd);
      if (waived) lines.push("", waived);
      if (!present) {
        lines.push("", "Kickoff questions — ask the human, then write the answers with `contract_set`.");
        lines.push("Every one asks for a DELIVERABLE. None asks what is true about the game: at a");
        lines.push("kickoff that is unknown, and a guessed answer later reads like a finding.", "");
        for (const q of KICKOFF_QUESTIONS) {
          lines.push(`  ${q.field}`);
          lines.push(`    ${q.ask}`);
          lines.push(`    (${q.note})`);
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  server.tool(
    "contract_set",
    "Write the project contract: what the human expects delivered. Use once at kickoff, or when the expectation changes. It may demand FEWER slots than the default fifteen — a game with no save owes no S10. Also the human's override: `waive` releases an owed promise so the publishing doors open again, and records who waived what and why. Not for reading back what the project owes (use contract_show). Inputs: goal + deliverables + optional limits, or waive + waive_reason + waived_by. Returns: the stored contract, or the recorded waiver.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      goal: z.string().min(10).optional().describe("What this job is for, in one sentence. The frame, not a checkable. Required unless this call only waives."),
      slots: z.array(z.string()).optional().describe("Which Spec 844 slots THIS game owes, e.g. [\"S1\",\"S3\",\"S4\"]. Omit for all fifteen."),
      named_ratio: z.number().min(0).max(1).optional().describe("Fraction of meaning-bearing nodes that must carry a HUMAN name. Machine names (unknown_3E00, addr_0006) do not count."),
      coverage_ratio: z.number().min(0).max(1).optional().describe("Fraction of bytes that must sit inside a known address range (S12)."),
      annotate: z.array(z.string()).optional().describe("Payloads that must be semantically annotated, not merely disassembled."),
      documents: z.array(z.object({
        covers: z.string().describe("Address range ($4300-$73FC) or artifact name the document must cover"),
        why: z.string().optional(),
      })).optional().describe("Synthesis that must exist and declare itself (Spec 847)."),
      runtime_ratchet: z.number().int().min(0).optional().describe("Gated runtime calls allowed with no durable record (844 D5). 0 disables."),
      orphan_ratio: z.number().min(0).max(1).optional().describe("Fraction of nodes allowed outside every named boundary (846)."),
      waive: z.array(z.string()).optional().describe("Spec 877: promise ids to release, e.g. [\"namedRatio\"]. The refusal names the id. The measurement is unchanged — this opens the publishing doors, it does not mark the promise met."),
      waive_reason: z.string().optional().describe("Why this project ships short of the promise, in the words the decision was made in. Required with waive."),
      waived_by: z.string().optional().describe("Who is overruling. Required with waive, recorded verbatim, never defaulted — this is a human's decision and the server cannot tell a human's call from a run's."),
    },
    async (a) => {
      const pd = context.projectDir(a.project_dir, true);

      // Spec 877 D2. A waiver is its own act: it must not be able to arrive as a side
      // effect of rewriting the contract, and a call that only waives does not need a
      // goal — the contract it releases already has one.
      if (a.waive?.length) {
        const { waivePromises } = await import("../contract/waive.js");
        const result = await waivePromises(pd, {
          promises: a.waive,
          reason: a.waive_reason ?? "",
          by: a.waived_by ?? "",
        });
        if (!result.ok || a.goal === undefined) {
          return { content: [{ type: "text" as const, text: result.message }] };
        }
        // goal given as well: fall through and write the contract too, then say both.
        const written = writeContract(pd, a);
        return { content: [{ type: "text" as const, text: `${result.message}\n\n---\n\n${written}` }] };
      }

      if (a.goal === undefined || a.goal.trim().length < 10) {
        return { content: [{ type: "text" as const, text: [
          "# contract_set refused — a contract needs a goal.",
          "",
          "One sentence saying what this job is for. It is the frame a human reads, not a",
          "checkable. `contract_show` prints the kickoff questions.",
          "",
          "(Only a call that just waives — `waive` + `waive_reason` + `waived_by` — may omit it.)",
        ].join("\n") }] };
      }
      return { content: [{ type: "text" as const, text: writeContract(pd, a) }] };
    },
  );

  function writeContract(pd: string, a: {
    goal?: string; slots?: string[]; named_ratio?: number; coverage_ratio?: number;
    annotate?: string[]; documents?: Array<{ covers: string; why?: string }>;
    runtime_ratchet?: number; orphan_ratio?: number;
  }): string {
    const contract: ProjectContract = {
      goal: a.goal!,
      deliver: {
        ...(a.slots ? { slots: a.slots } : {}),
        ...(a.named_ratio !== undefined ? { namedRatio: a.named_ratio } : {}),
        ...(a.coverage_ratio !== undefined ? { coverageRatio: a.coverage_ratio } : {}),
        ...(a.annotate ? { annotate: a.annotate } : {}),
        ...(a.documents ? { documents: a.documents } : {}),
      },
      limits: {
        ...(a.runtime_ratchet !== undefined ? { runtimeRatchet: a.runtime_ratchet } : {}),
        ...(a.orphan_ratio !== undefined ? { orphanRatio: a.orphan_ratio } : {}),
      },
    };
    const path = saveContract(pd, contract);
    return `${formatContract(contract, true)}\n\nWritten: ${path}`;
  }
}
