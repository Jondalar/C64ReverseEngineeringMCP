import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { graphFirstVerdict, noteListingRead, LARGE_LISTING_LINES } from "../contract/graph-first.js";

export function registerArtifactTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "read_artifact",
    "Read a generated artifact (ASM, JSON, SYM, MD) into context — C64 disassemblies are ≤64 KB and fit whole. Use to inspect a disassembly, analysis JSON, or report. Not for raw disk/cart media (use extract_disk / extract_crt) or directory peeks (use inspect_disk). Inputs: artifact path/id. Returns: file contents.",
    {
      path: z.string().describe("Path to the artifact (relative to project dir or absolute)"),
    },
    async ({ path: filePath }) => {
      const pd = context.projectDir(filePath);
      const absPath = resolve(pd, filePath);
      const text = context.readTextFile(absPath, 10 * 1024 * 1024);

      // Spec 881 D1 — a large listing waits until the graph has been asked something this
      // session. Counted and decided after the read, because the line count is the
      // measure and the file is small enough to have read either way; nothing is hidden,
      // the text simply is not handed over yet.
      const lines = text.length ? text.split("\n").length : 0;
      const verdict = graphFirstVerdict(pd, absPath, lines);
      if (verdict.refusal) return { content: [{ type: "text" as const, text: verdict.refusal }] };
      if (lines >= LARGE_LISTING_LINES) noteListingRead(pd, relative(resolve(pd), absPath) || filePath);

      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "list_artifacts",
    "List analysis artifacts (PRG, ASM, JSON, SYM, MD) in the project. Use to see what files exist before reading one. Not for payload entities (use list_payloads) or knowledge records (use list_findings). Inputs: optional subdir. Returns: artifact paths + types.",
    {
      subdir: z.string().optional().describe("Subdirectory to list (default: analysis)"),
    },
    async ({ subdir }) => {
      const pd = context.projectDir(subdir);
      const dir = resolve(pd, subdir ?? "analysis");
      if (!existsSync(dir)) {
        return { content: [{ type: "text" as const, text: `[directory not found: ${dir}]` }] };
      }
      const extensions = new Set([".prg", ".asm", ".json", ".sym", ".md", ".bin"]);
      const results: string[] = [];

      function walk(d: string, prefix: string) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(join(d, entry.name), rel);
          } else {
            const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
            if (extensions.has(ext)) {
              const stat = statSync(join(d, entry.name));
              const kb = (stat.size / 1024).toFixed(1);
              results.push(`${rel}  (${kb} KB)`);
            }
          }
        }
      }

      walk(dir, "");
      return { content: [{ type: "text" as const, text: results.join("\n") || "[no artifacts found]" }] };
    },
  );

  server.tool(
    "build_tools",
    "Compile the TRXDis pipeline (npm run build) in a source checkout or a C64RE_TOOLS_DIR tree, after its source changed. An installed package ships the pipeline built and has nothing to compile.",
    {},
    async () => {
      const td = context.toolsDir();
      // An installed package carries dist/ and no TypeScript: `npm run build` there has no
      // tsconfig to read and fails with a compiler error that says nothing useful.
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!existsSync(join(td, "tsconfig.json"))) {
        return { content: [{ type: "text" as const, text:
          `build_tools: nothing to compile in ${td} — it has no tsconfig.json, which is what an installed package looks like; the pipeline there is already built. Set C64RE_TOOLS_DIR to a source tree to rebuild one.` }] };
      }
      const { execFile } = await import("node:child_process");
      return new Promise((resolveResult) => {
        execFile("npm", ["run", "build"], { cwd: td, timeout: 30_000 }, (error, stdout, stderr) => {
          resolveResult(context.cliResultToContent({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? 1 : 0,
          }));
        });
      });
    },
  );
}
