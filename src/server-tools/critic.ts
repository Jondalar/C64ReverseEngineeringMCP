// Spec 846 — the critic's door.
//
// `project_critique` is on demand and nowhere else (D7). It is deliberately NOT on a
// timer and not in the background: a critic that runs unasked either burns budget or
// trains the session to scroll past it, and both end with it being ignored exactly when
// it matters.
//
// It writes nothing. A critic that files its own findings is arguing with itself two runs
// later, and the one thing it must never become is another source of unverified claims.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { critique, verdict, formatCritique } from "../critic/run.js";
import { CHECKS } from "../critic/checks.js";

export function registerCriticTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "project_critique",
    "Adversarial pass over the project's own records: negative claims the graph contradicts, refutations that invalidated nothing, findings without evidence, overlapping or empty boundaries, orphans, unreachable routines. Each finding carries the proof. Use before calling analysis done, and after a long unattended run. Inputs: optional project_dir, severity filter. Returns: findings + the ready verdict.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      min_severity: z.enum(["blocking", "important", "nice-to-have"]).default("nice-to-have")
        .describe("Report only findings at or above this severity"),
      verdict_only: z.boolean().default(false).describe("Just the ready/not-ready answer and its blockers"),
    },
    async ({ project_dir, min_severity, verdict_only }) => {
      const pd = context.projectDir(project_dir);
      const v = await verdict(pd);

      if (verdict_only) {
        return {
          content: [{
            type: "text" as const,
            text: v.ready
              ? "READY — every required slot is filled, no blocking critic finding stands, coverage is at threshold."
              : `NOT READY — ${v.blockers.length} blocker(s):\n${v.blockers.map((b) => `  - ${b}`).join("\n")}`,
          }],
          structuredContent: { ready: v.ready, blockers: v.blockers },
        };
      }

      const rank = { blocking: 3, important: 2, "nice-to-have": 1 } as const;
      const report = await critique(pd);
      const filtered = {
        ...report,
        findings: report.findings.filter((f) => rank[f.severity] >= rank[min_severity]),
      };

      const text = [
        formatCritique(filtered),
        "",
        v.ready
          ? "Verdict: READY."
          : `Verdict: NOT READY — ${v.blockers.length} blocker(s):\n${v.blockers.map((b) => `  - ${b}`).join("\n")}`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          ready: v.ready,
          blockers: v.blockers,
          counts: report.counts,
          findings: filtered.findings,
          handover: report.handover,
        },
      };
    },
  );

  server.tool(
    "critic_checks",
    "List the critic's checks and what each one's severity MEANS. Use when a critic finding looks mis-ranked — severity is a property of the check, declared once, and this is that table. Inputs: none. Returns: the checks with their severity and rationale.",
    {},
    async () => {
      const lines = CHECKS.map((c) =>
        [
          `${c.severity.padEnd(13)} ${c.id}`,
          `              finds:     ${c.finds}`,
          `              settle by: ${c.settleBy}`,
          ...(c.because ? [`              why:       ${c.because}`] : []),
        ].join("\n"));
      return {
        content: [{
          type: "text" as const,
          text: [
            "Severity belongs to the CHECK, not to the instance (Spec 846 D3).",
            "blocking = a downstream claim is unsafe while it stands.",
            "important = the model is weaker than it looks.  nice-to-have = hygiene.",
            "",
            ...lines,
          ].join("\n"),
        }],
        structuredContent: { checks: CHECKS },
      };
    },
  );
}
