// Spec 848 — the contract's doors.
//
// `contract_show` prints it and, when there is none, prints the questions a kickoff
// asks. `contract_set` writes it.
//
// C64RE supplies the questions; the HARNESS conducts the dialog. Same division as Spec
// 846 D5 — handing over a question is not driving a model, and it is the only reason this
// is allowed to exist next to Spec 773 decision #1.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { loadContract, saveContract, formatContract, KICKOFF_QUESTIONS, type ProjectContract } from "../contract/contract.js";

export function registerContractTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "contract_show",
    "What this project owes: the human's stated expectations (Spec 848) — which of the 14 slots apply here, what must be annotated, what must be written up, and the thresholds. With no contract set, returns the questions a kickoff should ask. Use at session start and before calling anything done. Inputs: optional project_dir. Returns: the contract or the questions.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
    },
    async ({ project_dir }) => {
      const pd = context.projectDir(project_dir);
      const { contract, present } = loadContract(pd);
      const lines = [formatContract(contract, present)];
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
        structuredContent: { present, contract, questions: present ? [] : KICKOFF_QUESTIONS },
      };
    },
  );

  server.tool(
    "contract_set",
    "Write the project contract: what the human expects delivered (Spec 848). Use once at kickoff, or when the expectation changes. It may demand FEWER slots than the default fourteen — a game with no save owes no S10. Inputs: goal + deliverables + optional limits. Returns: the stored contract.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      goal: z.string().min(10).describe("What this job is for, in one sentence. The frame, not a checkable."),
      slots: z.array(z.string()).optional().describe("Which Spec 844 slots THIS game owes, e.g. [\"S1\",\"S3\",\"S4\"]. Omit for all fourteen."),
      named_ratio: z.number().min(0).max(1).optional().describe("Fraction of meaning-bearing nodes that must carry a HUMAN name. Machine names (unknown_3E00, addr_0006) do not count."),
      coverage_ratio: z.number().min(0).max(1).optional().describe("Fraction of bytes that must sit inside a known address range (S12)."),
      annotate: z.array(z.string()).optional().describe("Payloads that must be semantically annotated, not merely disassembled."),
      documents: z.array(z.object({
        covers: z.string().describe("Address range ($4300-$73FC) or artifact name the document must cover"),
        why: z.string().optional(),
      })).optional().describe("Synthesis that must exist and declare itself (Spec 847)."),
      runtime_ratchet: z.number().int().min(0).optional().describe("Gated runtime calls allowed with no durable record (844 D5). 0 disables."),
      orphan_ratio: z.number().min(0).max(1).optional().describe("Fraction of nodes allowed outside every named boundary (846)."),
    },
    async (a) => {
      const pd = context.projectDir(a.project_dir, true);
      const contract: ProjectContract = {
        goal: a.goal,
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
      return {
        content: [{ type: "text" as const, text: `${formatContract(contract, true)}\n\nWritten: ${path}` }],
        structuredContent: { path, contract },
      };
    },
  );
}
