import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export interface KnowledgeArtifactDescriptor {
  path: string;
  title?: string;
  kind?: "prg" | "crt" | "d64" | "g64" | "raw" | "analysis-run" | "report" | "generated-source" | "manifest" | "extract" | "preview" | "listing" | "trace" | "view-model" | "checkpoint" | "other";
  scope?: "input" | "generated" | "analysis" | "knowledge" | "view" | "session";
  role?: string;
  format?: string;
  producedByTool?: string;
  sourceArtifactIds?: string[];
  tags?: string[];
}

export interface KnowledgeRegistrationInput {
  toolName: string;
  title: string;
  parameters?: Record<string, string | number | boolean | null | string[]>;
  notes?: string[];
  inputs?: KnowledgeArtifactDescriptor[];
  outputs?: KnowledgeArtifactDescriptor[];
}

export interface KnowledgeRegistrationResult {
  runPath?: string;
  inputArtifacts?: string[];
  outputArtifacts?: string[];
  message?: string;
  /** The store refused the write. `message` is the banner that says so; the run's
   *  files are on disk and nothing in the project knows about them. */
  failed?: boolean;
}

/**
 * What a call tells the resolver about its project. `projectDir` is a project the caller
 * NAMED (`project_dir`): honoured or refused, never swapped. `fileHint` is a file or
 * directory the call works on (`prg_path`, `image_path`, ...): it is not a project name
 * and only decides when no project is named.
 */
export interface ProjectHint {
  projectDir?: string;
  fileHint?: string;
}

export interface ServerToolContext {
  projectDir(hint?: ProjectHint, requireWritable?: boolean): string;
  toolsDir(): string;
  readTextFile(path: string, maxBytes?: number): string;
  cliResultToContent(result: { stdout: string; stderr: string; exitCode: number }): ToolTextResult;
  tryRegisterKnowledgeArtifacts(projectRoot: string, input: KnowledgeRegistrationInput): KnowledgeRegistrationResult;
}

export type ToolRegistrar = (server: McpServer, context: ServerToolContext) => void;
