import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDir } from "./project-root.js";
import { SERVER_INSTRUCTIONS } from "./server-instructions.js";
import { registerProjectKnowledgeTools } from "./project-knowledge/mcp-tools.js";
import { registerToolKnowledge } from "./project-knowledge/integration.js";
import { registerAgentWorkflowTools } from "./server-tools/agent-workflow.js";
import { registerAnalysisWorkflowTools } from "./server-tools/analysis-workflow.js";
import { registerMediaTools } from "./server-tools/media.js";
import { registerArtifactTools } from "./server-tools/artifacts.js";
import { registerSlotTools } from "./server-tools/slots.js";
import { registerModelTools } from "./server-tools/model.js";
import { registerCriticTools } from "./server-tools/critic.js";
import { registerDocTools } from "./server-tools/docs.js";
import { registerContractTools } from "./server-tools/contract.js";
import { registerAssemblyTools } from "./server-tools/assembly.js";
import { registerBasicTools } from "./server-tools/basic.js";
import { registerCompressionTools } from "./server-tools/compression.js";
import { registerGraphicsRenderTools } from "./server-tools/graphics-render.js";
import { registerInspectRangeTools } from "./server-tools/inspect-range.js";
import { registerGraphTools } from "./server-tools/graph-tools.js";
import { ORIENTATION_TOOLS, gateDisabled, isOnboarded, onboardingMessage } from "./server-tools/onboarding-gate.js";
import { isProjectInitialised, nextStepError } from "./server-tools/error-helpers.js";
import { registerDiskG64Tools } from "./server-tools/disk-g64.js";
import { registerHeadlessTools } from "./server-tools/headless.js";
import { registerRuntimeTools } from "./server-tools/runtime.js";
import { registerReferenceTools } from "./server-tools/reference.js";
import { registerPromptTools } from "./server-tools/prompts.js";
import { registerPayloadTools } from "./server-tools/payloads.js";
import { registerRegistrationTools } from "./server-tools/registration.js";
import { registerInventorySyncTool } from "./server-tools/inventory-sync.js";
import { registerArtifactVersionTools } from "./server-tools/artifact-version-tools.js";
import { registerProjectSearchTools } from "./server-tools/project-search-tools.js";
import { registerAgentStepTools } from "./server-tools/agent-step.js";
import { registerSandboxTools } from "./server-tools/sandbox.js";
import { registerSceneReelTool } from "./server-tools/scene-reel.js";
import { registerRuntimeSandboxTool } from "./server-tools/runtime-sandbox.js";
import { registerSandboxDepackTool } from "./server-tools/sandbox-depack.js";
import { registerTraceStoreTools } from "./server-tools/trace-store.js";
import { phaseForTool, PHASE_TITLES } from "./agent-orchestrator/phase-tools.js";
import { ruleFooterForTool } from "./project-rules/deliver.js";
import { standingFooter } from "./contract/standing.js";
import { tierForTool, fullToolsEnabled } from "./server-tools/tier-tools.js";
import { phaseGatedHandler } from "./server-tools/phase-gate-handler.js";
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

type ToolHandler = (...a: unknown[]) => Promise<{ content?: unknown[] }> | { content?: unknown[] };

/**
 * Doctrine rule 8 — a session inside an RE project onboards before it works.
 *
 * The refusal sits outside every other wrapper, so a tool that has not been
 * cleared never runs at all. Orientation tools and a directory that is not a
 * project pass straight through; see `onboarding-gate.ts` for what this cost
 * when nothing checked it.
 */
function onboardingGateHandler(toolName: string, inner: ToolHandler): ToolHandler {
  return async (...a: unknown[]) => {
    if (ORIENTATION_TOOLS.has(toolName) || gateDisabled()) return inner(...a);
    const first = a[0] as { project_dir?: string } | undefined;
    const dir = (() => { try { return projectDir(first?.project_dir); } catch { return undefined; } })();
    if (!dir || !isProjectInitialised(dir) || isOnboarded(dir)) return inner(...a);
    return nextStepError(toolName, onboardingMessage(toolName, dir), `agent_onboard(project_dir="${dir}")`);
  };
}

/**
 * Spec 849 D5 — append the project rule this tool carries to its own result.
 *
 * Appends to the LAST text block rather than adding one, so a caller that reads
 * `content[0].text` still sees the tool's own answer first. Never throws and never
 * changes a result it has nothing to add to: a rule is advice, and advice may not cost a
 * tool call.
 */
function ruleFooterHandler(toolName: string, inner: ToolHandler): ToolHandler {
  return async (...a: unknown[]) => {
    const result = await inner(...a);
    try {
      const first = a[0] as { project_dir?: string } | undefined;
      const dir = (() => { try { return projectDir(first?.project_dir); } catch { return undefined; } })();
      const parts = [
        ruleFooterForTool(dir, toolName),
        // Spec 849 §8 — and what the contract still owes, on the write path, as a delta.
        await standingFooter(dir, toolName),
      ].filter((x): x is string => !!x);
      if (parts.length === 0 || !result || !Array.isArray(result.content)) return result;
      const last = [...result.content].reverse().find(
        (b): b is { type: "text"; text: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "text",
      );
      if (last) last.text = `${last.text}\n${parts.join("\n")}`;
    } catch { /* a footer is never a reason for a tool to fail */ }
    return result;
  };
}

// Spec 039: wrap server.tool() so descriptions get an auto-injected
// `[Phase N]` (or `[Phase agnostic]`) prefix sourced from
// src/agent-orchestrator/phase-tools.ts. Tools without a registered
// phase keep their original description unchanged.
//
// Spec 049: also wrap the handler in phaseGatedHandler. Default
// behavior unchanged because phaseGatedHandler short-circuits to
// the inner handler when projectProfile.phaseGateStrict !== true.
function applyPhaseTagInjector(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const fullTools = fullToolsEnabled();
  (server as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "string") {
      const toolName = args[0];
      const description = args[1];
      // Spec 722.3a — tool tier gate. Façade-first: skip ADVANCED tools unless
      // C64RE_FULL_TOOLS is set. One choke-point; no register* module changes.
      if (!fullTools && tierForTool(toolName) === "advanced") {
        return undefined;
      }
      const tag = phaseForTool(toolName);
      if (tag !== undefined) {
        const prefix = tag === "agnostic" ? "[Phase agnostic]" : `[Phase ${tag}: ${PHASE_TITLES[tag]}]`;
        if (!description.startsWith("[Phase")) {
          args[1] = `${prefix} ${description}`;
        }
      }
      // Spec 849 D5 — the rule footer. The moment belongs to the TOOL, not to the
      // harness: `.claude/rules/` globs fire on a native READ, and an RE session reads
      // through the MCP tools, so a measured 102-turn run fired not one rule. The tool
      // that IS the moment appends it to its own result instead, once per session.
      if (args.length >= 4) {
        const handler = args[args.length - 1];
        if (typeof handler === "function") {
          args[args.length - 1] = onboardingGateHandler(toolName, ruleFooterHandler(toolName, handler as ToolHandler));
        }
      }
      // Spec 049: phase gate. Wrap the last arg (the handler) only
      // if the tool is registered in PHASE_TOOLS (non-agnostic).
      // This keeps agnostic tools unwrapped and avoids polluting the
      // hot path for tools that never apply.
      if (tag !== undefined && tag !== "agnostic" && args.length >= 4) {
        const handler = args[args.length - 1];
        if (typeof handler === "function") {
          args[args.length - 1] = phaseGatedHandler(toolName, { projectDir }, handler as (a: unknown, extra?: unknown) => Promise<{ content: unknown[] }>);
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
    // Always-in-context pointer (this server is a global MCP): on a C64 project / bare
    // /init, get the canonical static-first workflow from THIS server, do not cargo-cult a
    // sibling project's superseded trace-first CLAUDE.md. See src/server-instructions.ts.
    instructions: SERVER_INSTRUCTIONS,
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
  registerSlotTools(server, toolContext);
  registerModelTools(server, toolContext);
  registerCriticTools(server, toolContext);
  registerDocTools(server, toolContext);
  registerContractTools(server, toolContext);
  registerAssemblyTools(server, toolContext);
  registerBasicTools(server, toolContext);
  registerCompressionTools(server, toolContext);
  registerGraphicsRenderTools(server, toolContext);
  registerInspectRangeTools(server, toolContext);
  registerGraphTools(server, toolContext);
  registerDiskG64Tools(server, toolContext);
  registerHeadlessTools(server, toolContext);
  registerRuntimeTools(server, toolContext);
  registerTraceStoreTools(server, toolContext);
  registerReferenceTools(server, toolContext, repoDir());
  registerPromptTools(server, { readTextFile, repoRoot: repoDir() });
  registerPayloadTools(server, toolContext);
  registerRegistrationTools(server, toolContext);
  registerInventorySyncTool(server, toolContext);
  registerArtifactVersionTools(server, toolContext);
  registerProjectSearchTools(server, toolContext);
  registerAgentStepTools(server, toolContext);
  registerSandboxTools(server, toolContext);
  registerSceneReelTool(server, toolContext);
  registerRuntimeSandboxTool(server, toolContext);
  registerSandboxDepackTool(server, toolContext);
  registerProjectKnowledgeTools(server, { repoDir: repoDir() });

  return server;
}

// ---------------------------------------------------------------------------
// Tool inventory — the LIVE surface, for the tool-surface probe + doc gen.
// ---------------------------------------------------------------------------

/** Enumerate every registered tool's { name, description, file } straight from the
 *  register* functions — the RAW description (no phase-tag prefix) and the FULL surface
 *  (advanced included), so the probe/gen never drift from a frozen inventory JSON. Runs the
 *  same registration path as createServer() but with `.tool` overridden to capture instead
 *  of register (handlers never execute); `file` is the source module of each register group. */
export function collectToolInventory(): { name: string; description: string; file: string; schema?: Record<string, unknown> }[] {
  // `schema` is the raw ZodRawShape a tool was registered with (undefined for a
  // no-argument tool). Spec 833 D5(b): the path-portability gate walks it for
  // path parameters at ANY depth — `sandbox_6502_run` takes its paths NESTED
  // (`loads[].prg_path`), so a top-level-only view read it as taking none.
  const inv: { name: string; description: string; file: string; schema?: Record<string, unknown> }[] = [];
  let currentFile = "";
  const server = new McpServer({ name: "c64-re-inventory", version: "0.0.0" }, { capabilities: {} });
  (server as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]): unknown => {
    if (typeof args[0] === "string" && typeof args[1] === "string") {
      const shape = (args[2] && typeof args[2] === "object" && !Array.isArray(args[2]) && typeof args[2] !== "function")
        ? args[2] as Record<string, unknown>
        : undefined;
      inv.push({ name: args[0], description: args[1], file: currentFile, schema: shape });
    }
    return { update() {}, remove() {}, enable() {}, disable() {} };
  };
  const toolContext: ServerToolContext = {
    projectDir, toolsDir, readTextFile, cliResultToContent, tryRegisterKnowledgeArtifacts,
  };
  const group = (file: string, run: () => void): void => { currentFile = file; run(); };
  group("server-tools/agent-workflow.ts", () => registerAgentWorkflowTools(server, toolContext));
  group("server-tools/analysis-workflow.ts", () => registerAnalysisWorkflowTools(server, toolContext));
  group("server-tools/media.ts", () => registerMediaTools(server, toolContext));
  group("server-tools/artifacts.ts", () => registerArtifactTools(server, toolContext));
  group("server-tools/slots.ts", () => registerSlotTools(server, toolContext));
  group("server-tools/model.ts", () => registerModelTools(server, toolContext));
  group("server-tools/critic.ts", () => registerCriticTools(server, toolContext));
  group("server-tools/docs.ts", () => registerDocTools(server, toolContext));
  group("server-tools/contract.ts", () => registerContractTools(server, toolContext));
  group("server-tools/assembly.ts", () => registerAssemblyTools(server, toolContext));
  group("server-tools/basic.ts", () => registerBasicTools(server, toolContext));
  group("server-tools/compression.ts", () => registerCompressionTools(server, toolContext));
  group("server-tools/graphics-render.ts", () => registerGraphicsRenderTools(server, toolContext));
  group("server-tools/inspect-range.ts", () => registerInspectRangeTools(server, toolContext));
  group("server-tools/graph-tools.ts", () => registerGraphTools(server, toolContext));
  group("server-tools/disk-g64.ts", () => registerDiskG64Tools(server, toolContext));
  group("server-tools/headless.ts", () => registerHeadlessTools(server, toolContext));
  group("server-tools/runtime.ts", () => registerRuntimeTools(server, toolContext));
  group("server-tools/trace-store.ts", () => registerTraceStoreTools(server, toolContext));
  group("server-tools/reference.ts", () => registerReferenceTools(server, toolContext, repoDir()));
  group("server-tools/prompts.ts", () => registerPromptTools(server, { readTextFile, repoRoot: repoDir() }));
  group("server-tools/payloads.ts", () => registerPayloadTools(server, toolContext));
  group("server-tools/registration.ts", () => registerRegistrationTools(server, toolContext));
  group("server-tools/inventory-sync.ts", () => registerInventorySyncTool(server, toolContext));
  group("server-tools/artifact-version-tools.ts", () => registerArtifactVersionTools(server, toolContext));
  group("server-tools/project-search-tools.ts", () => registerProjectSearchTools(server, toolContext));
  group("server-tools/agent-step.ts", () => registerAgentStepTools(server, toolContext));
  group("server-tools/sandbox.ts", () => registerSandboxTools(server, toolContext));
  group("server-tools/scene-reel.ts", () => registerSceneReelTool(server, toolContext));
  group("server-tools/runtime-sandbox.ts", () => registerRuntimeSandboxTool(server, toolContext));
  group("server-tools/sandbox-depack.ts", () => registerSandboxDepackTool(server, toolContext));
  group("project-knowledge/mcp-tools.ts", () => registerProjectKnowledgeTools(server, { repoDir: repoDir() }));
  return inv;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
