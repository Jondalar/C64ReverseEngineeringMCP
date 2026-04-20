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
}

export interface ServerToolContext {
  projectDir(hintPath?: string, requireWritable?: boolean): string;
  toolsDir(): string;
  readTextFile(path: string, maxBytes?: number): string;
  cliResultToContent(result: { stdout: string; stderr: string; exitCode: number }): ToolTextResult;
  tryRegisterKnowledgeArtifacts(projectRoot: string, input: KnowledgeRegistrationInput): KnowledgeRegistrationResult;
}

export type ToolRegistrar = (server: McpServer, context: ServerToolContext) => void;
