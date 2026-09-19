import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assembleSource } from "../assemble-source.js";
import type { ServerToolContext } from "./types.js";

export function registerAssemblyTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "assemble_source",
    "Assemble a .asm (KickAssembler) or .tas (64tass) file to a binary, optionally byte-comparing the rebuild against the original PRG. Use to verify a disassembly rebuilds correctly. Not for generating the source (use disasm_prg). Also writes the build's symbol file (`<output>.vs`, VICE label format) and registers it, so the live monitor names the build's addresses ([b]) while that build's bytes are in memory. Inputs: source path, optional original PRG. Returns: assembled binary path + cmp result + symbol file.",
    {
      source_path: z.string().describe("Path to the .asm or .tas source file"),
      assembler: z.enum(["auto", "kickassembler", "64tass"]).optional().describe("Assembler to use. auto selects KickAssembler for .asm and 64tass for .tas"),
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
          symbols: true,
        });
        const lines = [
          `Assembler: ${result.assembler}`,
          `Source: ${result.sourcePath}`,
          `Output: ${result.outputPath}`,
          `Exit code: ${result.exitCode}`,
        ];
        if (result.symbolsPath) {
          // Spec 804 — the build layer: registered so the resolver finds it, never
          // copied into the graph (a build's names are a fact about ITS bytes).
          const reg = context.tryRegisterKnowledgeArtifacts(pd, {
            toolName: "assemble_source",
            title: `Build symbols: ${result.symbolsPath.replace(/^.*\//u, "")}`,
            parameters: { source_path, output_path: result.outputPath },
            outputs: [
              { path: result.outputPath, kind: "prg", scope: "generated", role: "build-output", producedByTool: "assemble_source" },
              { path: result.symbolsPath, kind: "other", scope: "generated", role: "build-symbols", format: "vice-labels", producedByTool: "assemble_source" },
            ],
          });
          lines.push(`Symbols: ${result.symbolsPath}${reg.message ? ` (${reg.message})` : ""}`);
        }
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
