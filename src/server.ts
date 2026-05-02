import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDir } from "./project-root.js";
import { registerProjectKnowledgeTools } from "./project-knowledge/mcp-tools.js";
import { registerToolKnowledge } from "./project-knowledge/integration.js";
import { registerAgentWorkflowTools } from "./server-tools/agent-workflow.js";
import { registerAnalysisWorkflowTools } from "./server-tools/analysis-workflow.js";
import { registerMediaTools } from "./server-tools/media.js";
import { registerArtifactTools } from "./server-tools/artifacts.js";
import { registerAssemblyTools } from "./server-tools/assembly.js";
import { registerBwcBitstreamTools } from "./server-tools/bwc-bitstream.js";
import { registerCompressionTools } from "./server-tools/compression.js";
import { registerGraphicsRenderTools } from "./server-tools/graphics-render.js";
import { registerInspectRangeTools } from "./server-tools/inspect-range.js";
import { registerDiskG64Tools } from "./server-tools/disk-g64.js";
import { registerHeadlessTools } from "./server-tools/headless.js";
import { registerReferenceTools } from "./server-tools/reference.js";
import { registerPromptTools } from "./server-tools/prompts.js";
import { registerPayloadTools } from "./server-tools/payloads.js";
import { registerRegistrationTools } from "./server-tools/registration.js";
import { registerSandboxTools } from "./server-tools/sandbox.js";
import { registerSandboxDepackTool } from "./server-tools/sandbox-depack.js";
import { phaseForTool, PHASE_TITLES } from "./agent-orchestrator/phase-tools.js";
import { registerViceTools } from "./server-tools/vice.js";
import type { KnowledgeRegistrationInput, KnowledgeRegistrationResult, ServerToolContext } from "./server-tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectDir(hintPath?: string, requireWritable = false): string {
  return resolveProjectDir({
    cwd: process.cwd(),
    repoDir: repoDir(),
    hintPath,
    requireWritable,
  });
}

function toolsDir(): string {
  return process.env.C64RE_TOOLS_DIR ?? repoDir();
}

function repoDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readTextFile(path: string, maxBytes = 2 * 1024 * 1024): string {
  if (!existsSync(path)) {
    return `[file not found: ${path}]`;
  }
  const stat = statSync(path);
  if (stat.size > maxBytes) {
    return readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, maxBytes) + `\n\n[… truncated at ${maxBytes} bytes, total ${stat.size}]`;
  }
  return readFileSync(path, "utf8");
}

function cliResultToContent(result: { stdout: string; stderr: string; exitCode: number }) {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode}]`);
  const text = parts.join("\n\n") || "[no output]";
  return { content: [{ type: "text" as const, text }] };
}

function tryRegisterKnowledgeArtifacts(
  projectRoot: string,
  input: KnowledgeRegistrationInput,
): KnowledgeRegistrationResult {
  try {
    const registration = registerToolKnowledge(projectRoot, input);
    return registration;
  } catch (error) {
    return {
      message: `Knowledge registration skipped: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Spec 039: wrap server.tool() so descriptions get an auto-injected
// `[Phase N]` (or `[Phase agnostic]`) prefix sourced from
// src/agent-orchestrator/phase-tools.ts. Tools without a registered
// phase keep their original description unchanged.
function applyPhaseTagInjector(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "string") {
      const toolName = args[0];
      const description = args[1];
      const tag = phaseForTool(toolName);
      if (tag !== undefined) {
        const prefix = tag === "agnostic" ? "[Phase agnostic]" : `[Phase ${tag}: ${PHASE_TITLES[tag]}]`;
        if (!description.startsWith("[Phase")) {
          args[1] = `${prefix} ${description}`;
        }
      }
    }
    return original(...args);
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "c64-reverse-engineering",
    version: "0.1.0",
  }, {
    capabilities: { logging: {} },
  });

  // Spec 039: phase-tag prefix injection on every server.tool() call.
  applyPhaseTagInjector(server);

  const toolContext: ServerToolContext = {
    projectDir,
    toolsDir,
    readTextFile,
    cliResultToContent,
    tryRegisterKnowledgeArtifacts,
  };

  registerAgentWorkflowTools(server, toolContext);
  registerAnalysisWorkflowTools(server, toolContext);
  registerMediaTools(server, toolContext);
  registerArtifactTools(server, toolContext);
  registerAssemblyTools(server, toolContext);
  registerBwcBitstreamTools(server, toolContext);
  registerCompressionTools(server, toolContext);
  registerGraphicsRenderTools(server, toolContext);
  registerInspectRangeTools(server, toolContext);
  registerDiskG64Tools(server, toolContext);
  registerHeadlessTools(server, toolContext);
  registerReferenceTools(server, toolContext, repoDir());
  registerPromptTools(server, { readTextFile, repoRoot: repoDir() });
  registerPayloadTools(server, toolContext);
  registerRegistrationTools(server, toolContext);
  registerSandboxTools(server, toolContext);
  registerSandboxDepackTool(server, toolContext);
  registerViceTools(server, toolContext);
  registerProjectKnowledgeTools(server, { repoDir: repoDir() });

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
