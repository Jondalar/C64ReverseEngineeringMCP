import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assembleSource } from "../assemble-source.js";
import { assembleUnits, UnitBuildRefusal } from "../assemble-units.js";
import { dialectLabel, dialectOfPath, listingFormat } from "../lib/dialect.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { ServerToolContext } from "./types.js";

export function registerAssemblyTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "assemble_source",
    "Assemble a .asm (KickAssembler) or .tas (64tass) file to a binary, optionally byte-comparing the rebuild against the original PRG. Use to verify a disassembly rebuilds correctly. Not for generating the source (use disasm). Also writes the build's symbol file (`<output>.vs`, VICE label format) and registers it, so the live monitor names the build's addresses ([b]) while that build's bytes are in memory. The output folder is created when missing. SOURCES OF DIFFERENT DIALECTS BUILD TOGETHER: pass `units` (instead of source_path) — each is built by its own assembler, in dependency order, and the symbols a unit exports become equates of the dialect of the unit that lists it in `uses` (loader.tas built by 64tass, main.asm calling its `load_file` built by KickAssembler). No source is edited or translated; a unit marked `foreign` is registered with its dialect, hashed before and after, and only ever read. A label a unit uses that none of its `uses` exports is refused by name. Inputs: source path or units, optional original PRG. Returns: assembled binary path + cmp result + symbol file (per unit for units).",
    {
      source_path: z.string().optional().describe("Path to the .asm or .tas source file (or use units)"),
      units: z.array(z.object({
        path: z.string().describe("The source, absolute or project-relative."),
        assembler: z.enum(["auto", "kickassembler", "64tass"]).optional().describe("Default auto: .asm KickAssembler, .tas/.tass 64tass."),
        uses: z.array(z.string()).optional().describe("Paths (as given in this list) of the units whose exported symbols this one uses. It is built after them, and sees their symbols as equates."),
        compare_to: z.string().optional().describe("Original PRG to compare this unit's build against."),
        foreign: z.boolean().optional().describe("A file you did not render (a reporter's loader, a template): registered with its dialect, never written, its sha256 checked unchanged after the build."),
      })).optional().describe("Several sources built together; instead of source_path."),
      output_dir: z.string().optional().describe("With units: where the PRGs, label tables and generated equates go. Default analysis/build."),
      assembler: z.enum(["auto", "kickassembler", "64tass"]).optional().describe("Assembler to use. auto selects KickAssembler for .asm and 64tass for .tas"),
      output_path: z.string().optional().describe("Optional output PRG path"),
      compare_to: z.string().optional().describe("Optional original PRG path to compare byte-for-byte"),
    },
    async ({ source_path, units, output_dir, assembler, output_path, compare_to }) => {
      try {
        if (units && source_path) {
          return context.cliResultToContent({ stdout: "", stderr: "Give source_path OR units, not both.", exitCode: 1 });
        }
        if (units) {
          const pd = context.projectDir({ fileHint: units[0]?.path }, true);
          try {
            const run = await assembleUnits({
              projectDir: pd,
              units: units.map((u) => ({
                path: u.path,
                ...(u.assembler ? { assembler: u.assembler } : {}),
                ...(u.uses ? { uses: u.uses } : {}),
                ...(u.compare_to ? { compareTo: u.compare_to } : {}),
                ...(u.foreign ? { foreign: true } : {}),
              })),
              ...(output_dir ? { outputDir: output_dir } : {}),
            });
            const service = new ProjectKnowledgeService(pd);
            const lines: string[] = [`Built ${run.built.length} unit${run.built.length === 1 ? "" : "s"} into ${run.outputDir}`];
            for (const unit of run.built) {
              lines.push("", `Unit: ${unit.path}`, `  Assembler: ${unit.assembler} (${dialectLabel(unit.dialect)})`, `  Output: ${unit.outputPath}`, `  Exit code: ${unit.exitCode}`,
                `  Symbols defined: ${unit.symbols.filter((s) => s.scope === "").length} global${unit.symbols.some((s) => s.scope !== "") ? `, ${unit.symbols.filter((s) => s.scope !== "").length} scoped` : ""}`);
              if (unit.imported.length > 0) lines.push(`  Equates from: ${unit.imported.join(", ")} (${unit.equatesPath})`);
              if (unit.foreign) lines.push(`  Foreign: ${unit.sourceHashBefore === unit.sourceHashAfter ? "unchanged on disk (sha256 equal before and after)" : "CHANGED ON DISK"}`);
              if (unit.compareTo) lines.push(`  Match: ${unit.compareMatches ? "yes" : "no"} (compared ${unit.comparedBytes} bytes${unit.firstDiffOffset !== undefined ? `, first diff at ${unit.firstDiffOffset}` : ""})`);
              if (unit.exitCode !== 0 && unit.stdout.trim()) lines.push("  [stdout]", unit.stdout.trim().split("\n").slice(-12).map((l) => `  ${l}`).join("\n"));
              if (unit.exitCode !== 0 && unit.stderr.trim()) lines.push("  [stderr]", unit.stderr.trim().split("\n").slice(-12).map((l) => `  ${l}`).join("\n"));
              // A source we were handed is registered with the dialect it is written in, so a later reader knows what it is.
              if (unit.foreign) {
                try {
                  const dialect = dialectOfPath(unit.sourcePath) ?? unit.dialect;
                  service.saveArtifact({
                    kind: "other", scope: "input", title: `Foreign source: ${unit.path}`, path: unit.sourcePath,
                    role: "foreign-source", format: listingFormat(dialect), producedByTool: "assemble_source",
                    tags: ["foreign", "read-only"], assembler: dialect,
                  });
                } catch { /* a source outside the project stays unregistered */ }
              }
            }
            const failed = run.built.find((u) => u.exitCode !== 0);
            if (failed) return context.cliResultToContent({ stdout: lines.join("\n"), stderr: "", exitCode: 1 });
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          } catch (error) {
            if (error instanceof UnitBuildRefusal) {
              return { content: [{ type: "text" as const, text: `# assemble_source refused\n\n${error.message}` }] };
            }
            throw error;
          }
        }
        if (!source_path) {
          return context.cliResultToContent({ stdout: "", stderr: "Give source_path (one source) or units (several, possibly of different dialects).", exitCode: 1 });
        }
        const pd = context.projectDir({ fileHint: source_path }, true);
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
