import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

/**
 * BASIC V2 tooling (829 D7).
 *
 * `src/` is ESM and `pipeline/src/` is CommonJS and the two cannot import each
 * other (817 §1), so both tools reach the detokenizer the only way anything
 * here reaches pipeline code: by spawning the pipeline CLI through runCli.
 * The verbs are `basic-list` and `basic-tokenize`.
 */
export function registerBasicTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "basic_list",
    "List a tokenized BASIC V2 program from a PRG and extract its SYS / USR / LOAD facts — the listing, plus the address the BASIC boot jumps into and the address of the token byte that jumps there. Use on any PRG that loads at $0801 BEFORE disassembling it: a stock BASIC boot is token bytes, not 6502, and its SYS target is the real entry point into the machine code. Not for machine-code PRGs — on one it answers NOT BASIC and names the byte offset where the line chain broke, instead of half-rendering it (use analyze / disasm for those) — and not for writing BASIC (use basic_tokenize). Inputs: prg_path, optional project_dir, optional json. Returns: the listing, the program's address range and end, and each SYS/USR/LOAD with its line number, its resolved target (or the unresolved expression) and the address of its token byte.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project dir)"),
      json: z.boolean().optional().describe("Return machine-readable JSON (listing + facts) instead of the rendered listing"),
    },
    safeHandler("basic_list", async ({ project_dir, prg_path, json }) => {
      const pd = context.projectDir(project_dir ?? prg_path, false);
      const prgAbs = resolve(pd, prg_path);
      const result = await runCli("basic-list", [prgAbs, ...(json ? ["--json"] : [])], { projectDir: pd });
      return context.cliResultToContent(result);
    }),
  );

  server.tool(
    "basic_tokenize",
    "Tokenize BASIC V2 source text into a .prg — the inverse of basic_list. Use to build a loader stub, or to turn an edited listing back into bytes; the round trip is byte-identical, which is what makes a listing worth trusting. Not for assembling 6502 source (use assemble_source), and not for reading a program that already exists (use basic_list). Inputs: text, output_path, optional project_dir and load_address (default $0801). Returns: the written PRG path, its load address, its byte count, and the knowledge run the PRG was registered under.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from output_path to knowledge/phase-plan.json."),
      text: z.string().describe("BASIC V2 source, one line per line, each starting with its line number (e.g. \"10 SYS 2080\"). Control codes by name: {CLR}, {RVS ON}, {CYAN}."),
      output_path: z.string().describe("Path to write the .prg to (absolute or relative to project dir)"),
      load_address: z.string().optional().describe("Hex load address, e.g. \"0801\" or \"$0801\". Default $0801 (BASIC start)."),
    },
    safeHandler("basic_tokenize", async ({ project_dir, text, output_path, load_address }) => {
      const pd = context.projectDir(project_dir ?? output_path, true);
      const outAbs = resolve(pd, output_path);
      // The source is passed as a FILE, never as an argv string: a listing is
      // multi-line and carries quotes, braces and PETSCII control names, none
      // of which survive an argument vector intact.
      const scratch = mkdtempSync(join(tmpdir(), "c64re-basic-"));
      const textAbs = join(scratch, "source.bas");
      try {
        writeFileSync(textAbs, text, "utf8");
        const args = [textAbs, outAbs];
        if (load_address) {
          args.push("--load-address", load_address);
        }
        const result = await runCli("basic-tokenize", args, { projectDir: pd });
        const answer = context.cliResultToContent(result);
        // The PRG is registered from HERE, by the door that was called, the way
        // every other tool that produces a file does it. It used to be registered
        // by the pipeline child instead — the child reaching into the project's
        // knowledge store on its own — which made `basic_tokenize` the one MCP
        // door whose output landed in the store from the far side of a process
        // boundary, with no way for the parent to say what failed.
        if (result.exitCode === 0 && existsSync(outAbs)) {
          const reg = context.tryRegisterKnowledgeArtifacts(pd, {
            toolName: "basic_tokenize",
            title: `${basename(outAbs)} (tokenized BASIC V2)`,
            parameters: { output_path, ...(load_address ? { load_address } : {}) },
            outputs: [{
              path: outAbs,
              kind: "prg",
              scope: "generated",
              role: "basic_program",
              format: "prg",
              producedByTool: "basic_tokenize",
            }],
          });
          const last = answer.content[answer.content.length - 1]!;
          if (reg.runPath) last.text = `${last.text}\nKnowledge run: ${reg.runPath}`;
          // A registration that failed leads the answer; it never trails a success.
          else if (reg.failed && reg.message) last.text = `${reg.message}\n\n${last.text}`;
        }
        return answer;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );
}
