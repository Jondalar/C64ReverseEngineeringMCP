import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { ProjectKnowledgeService } from "./service.js";
import type { ArtifactKind, ArtifactScope, JsonValue } from "./types.js";

export interface ToolArtifactDescriptor {
  path: string;
  title?: string;
  kind?: ArtifactKind;
  scope?: ArtifactScope;
  role?: string;
  format?: string;
  producedByTool?: string;
  sourceArtifactIds?: string[];
  tags?: string[];
}

export interface ToolKnowledgeIntegrationInput {
  toolName: string;
  title: string;
  parameters?: Record<string, JsonValue>;
  notes?: string[];
  inputs?: ToolArtifactDescriptor[];
  outputs?: ToolArtifactDescriptor[];
}

function inferArtifactKind(path: string): ArtifactKind {
  switch (extname(path).toLowerCase()) {
    case ".prg":
      return "prg";
    case ".crt":
      return "crt";
    case ".d64":
      return "d64";
    case ".g64":
      return "g64";
    case ".asm":
    case ".tass":
      return "generated-source";
    case ".md":
      return "report";
    case ".json":
      return basename(path).toLowerCase() === "manifest.json" ? "manifest" : "other";
    default:
      return "other";
  }
}

function inferScope(path: string): ArtifactScope {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/input/")) {
    return "input";
  }
  if (normalized.includes("/views/")) {
    return "view";
  }
  if (normalized.includes("/session/")) {
    return "session";
  }
  if (normalized.includes("/knowledge/")) {
    return "knowledge";
  }
  if (normalized.includes("/analysis/")) {
    return "analysis";
  }
  return "generated";
}

export function registerToolKnowledge(projectRoot: string, input: ToolKnowledgeIntegrationInput): {
  inputArtifacts: string[];
  outputArtifacts: string[];
  runPath: string;
} {
  const service = new ProjectKnowledgeService(projectRoot);

  const resolvedInputs = (input.inputs ?? [])
    .map((artifact) => ({ descriptor: artifact, absolutePath: resolve(projectRoot, artifact.path) }))
    .filter((entry) => existsSync(entry.absolutePath));

  const savedInputs = resolvedInputs
    .map(({ descriptor, absolutePath }) =>
      service.saveArtifact({
        kind: descriptor.kind ?? inferArtifactKind(absolutePath),
        scope: descriptor.scope ?? inferScope(absolutePath),
        title: descriptor.title ?? basename(absolutePath),
        path: absolutePath,
        role: descriptor.role,
        format: descriptor.format,
        producedByTool: descriptor.producedByTool,
        sourceArtifactIds: descriptor.sourceArtifactIds,
        tags: descriptor.tags ?? [input.toolName, "input"],
      }));

  const resolvedOutputs = (input.outputs ?? [])
    .map((artifact) => ({ descriptor: artifact, absolutePath: resolve(projectRoot, artifact.path) }))
    .filter((entry) => existsSync(entry.absolutePath));

  const savedOutputs = resolvedOutputs
    .map(({ descriptor, absolutePath }) =>
      service.saveArtifact({
        kind: descriptor.kind ?? inferArtifactKind(absolutePath),
        scope: descriptor.scope ?? inferScope(absolutePath),
        title: descriptor.title ?? basename(absolutePath),
        path: absolutePath,
        role: descriptor.role,
        format: descriptor.format,
        producedByTool: descriptor.producedByTool ?? input.toolName,
        sourceArtifactIds: uniqueIds(savedInputs.map((artifact) => artifact.id), descriptor.sourceArtifactIds),
        tags: descriptor.tags ?? [input.toolName, "output"],
      }));

  const { runPath } = service.registerToolRun({
    toolName: input.toolName,
    title: input.title,
    status: "completed",
    inputArtifactIds: savedInputs.map((artifact) => artifact.id),
    outputArtifactIds: savedOutputs.map((artifact) => artifact.id),
    parameters: input.parameters,
    notes: input.notes,
  });

  return {
    inputArtifacts: savedInputs.map((artifact) => artifact.id),
    outputArtifacts: savedOutputs.map((artifact) => artifact.id),
    runPath,
  };
}

function uniqueIds(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))].sort();
}
