import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assembleSource } from "../assemble-source.js";
import type { ServerToolContext } from "./types.js";

export function registerAssemblyTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "assemble_source",
    "Assemble a generated KickAssembler .asm or 64tass .tass file and optionally compare the rebuilt binary against an original PRG.",
    {
      source_path: z.string().describe("Path to the .asm or .tass source file"),
      assembler: z.enum(["auto", "kickassembler", "64tass"]).optional().describe("Assembler to use. auto selects KickAssembler for .asm and 64tass for .tass"),
      output_path: z.string().optional().describe("Optional output PRG path"),
      compare_to: z.string().optional().describe("Optional original PRG path to compare byte-for-byte"),
    },
    async ({ source_path, assembler, output_path, compare_to }) => {
      try {
        const pd = context.projectDir(source_path, true);
        const result = await assembleSource({
          projectDir: pd,
          sourcePath: source_path,
          assembler: assembler ?? "auto",
          outputPath: output_path,
          compareToPath: compare_to,
        });
        const lines = [
          `Assembler: ${result.assembler}`,
          `Source: ${result.sourcePath}`,
          `Output: ${result.outputPath}`,
          `Exit code: ${result.exitCode}`,
        ];
        if (result.compareToPath) {
          lines.push(`Compare target: ${result.compareToPath}`);
          lines.push(`Match: ${result.compareMatches ? "yes" : "no"}`);
          if (result.comparedBytes !== undefined) {
            lines.push(`Compared bytes: ${result.comparedBytes}`);
          }
          if (result.firstDiffOffset !== undefined) {
            lines.push(`First diff offset: ${result.firstDiffOffset}`);
          }
        }
        if (result.stdout.trim()) {
          lines.push("");
          lines.push("[stdout]");
          lines.push(result.stdout.trim());
        }
        if (result.stderr.trim()) {
          lines.push("");
          lines.push("[stderr]");
          lines.push(result.stderr.trim());
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );
}
