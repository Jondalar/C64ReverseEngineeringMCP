import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";

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
    "Compile the TRXDis pipeline (npm run build). Must be called before analysis if source has changed.",
    {},
    async () => {
      const td = context.toolsDir();
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
