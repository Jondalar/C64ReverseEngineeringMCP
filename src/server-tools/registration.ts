import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { listCandidateFiles, matchesGlob, scanRegistrationDelta, statSafe } from "../lib/registration-delta.js";
import type { ServerToolContext } from "./types.js";

const KIND_VALUES = [
  "prg", "crt", "d64", "g64", "raw",
  "analysis-run", "report", "generated-source",
  "manifest", "extract", "preview", "listing",
  "trace", "view-model", "checkpoint", "other",
] as const;

const SCOPE_VALUES = ["input", "generated", "analysis", "knowledge", "view", "session"] as const;

const patternSchema = z.object({
  glob: z.string().describe("Glob relative to the project root, e.g. 'analysis/disasm/**/*.asm'. * matches within a path component, ** matches across components."),
  kind: z.enum(KIND_VALUES).describe("Artifact kind for matched files."),
  scope: z.enum(SCOPE_VALUES).describe("Artifact scope for matched files."),
  role: z.string().optional().describe("Optional role tag (e.g. 'disasm', 'analysis', 'preview')."),
  format: z.string().optional().describe("Optional format hint (e.g. 'asm', 'json', 'png')."),
  produced_by_tool: z.string().optional().describe("Optional 'producedByTool' value. Default 'register_existing_files'."),
  title_template: z.string().optional().describe("Optional title template; defaults to the filename. Future: support placeholders like {{stem}}."),
  tags: z.array(z.string()).optional(),
});

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerRegistrationTools(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "register_existing_files",
    "Walk the project filesystem and register files that match one or more glob patterns into knowledge/artifacts.json. Idempotent: files already registered (by relativePath) are skipped. Use this after bulk operations that bypassed MCP — direct pipeline CLI loops, Node imports of bwc-bitstream-ts / graphics-render, hand-emitted reports — to bring the artifact store in sync with the filesystem. dry_run=true previews the work without writing.",
    {
      project_dir: z.string().optional(),
      patterns: z.array(patternSchema).min(1).describe("One or more glob+metadata patterns. Each matched file becomes a save_artifact call with the pattern's kind/scope/role/format."),
      dry_run: z.boolean().optional().describe("If true, return the planned registrations without writing. Default false."),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const candidates = listCandidateFiles(projectRoot);
      // Already-registered set so we count "skipped" too.
      const existing = new Set<string>(
        service.listArtifacts().map((a) => a.relativePath),
      );

      const planned: Array<{ pattern: number; relativePath: string; kind: string; scope: string }> = [];
      const skippedAlreadyRegistered: string[] = [];
      const unmatched: string[] = [];

      for (const rel of candidates) {
        let matchedAny = false;
        for (let pi = 0; pi < args.patterns.length; pi++) {
          if (matchesGlob(rel, args.patterns[pi]!.glob)) {
            matchedAny = true;
            if (existing.has(rel)) {
              skippedAlreadyRegistered.push(rel);
              break;
            }
            planned.push({ pattern: pi, relativePath: rel, kind: args.patterns[pi]!.kind, scope: args.patterns[pi]!.scope });
            // Mark to avoid double-adding when multiple patterns match.
            existing.add(rel);
            break;
          }
        }
        if (!matchedAny) unmatched.push(rel);
      }

      if (args.dry_run) {
        const lines: string[] = [];
        lines.push(`register_existing_files (dry run)`);
        lines.push(`Project: ${projectRoot}`);
        lines.push(`Candidates scanned: ${candidates.length}`);
        lines.push(`Would register: ${planned.length}`);
        lines.push(`Already registered (skipped): ${skippedAlreadyRegistered.length}`);
        lines.push(`No-match (no pattern covers them): ${unmatched.length}`);
        lines.push(``);
        lines.push(`Planned by pattern:`);
        for (let pi = 0; pi < args.patterns.length; pi++) {
          const cnt = planned.filter((p) => p.pattern === pi).length;
          lines.push(`  [${pi}] glob=${args.patterns[pi]!.glob} kind=${args.patterns[pi]!.kind} scope=${args.patterns[pi]!.scope} → ${cnt} files`);
        }
        if (unmatched.length > 0) {
          lines.push(``);
          lines.push(`Unmatched samples (first 10):`);
          for (const u of unmatched.slice(0, 10)) lines.push(`  ${u}`);
        }
        return textContent(lines.join("\n"));
      }

      // Live run: invoke saveArtifact for each planned entry.
      const summaryByKind: Record<string, number> = {};
      for (const p of planned) {
        const pat = args.patterns[p.pattern]!;
        const absPath = resolve(projectRoot, p.relativePath);
        const stat = statSafe(absPath);
        const stem = p.relativePath.split("/").pop()!;
        const title = pat.title_template ?? stem;
        try {
          service.saveArtifact({
            kind: pat.kind,
            scope: pat.scope,
            title,
            path: absPath,
            format: pat.format,
            role: pat.role,
            producedByTool: pat.produced_by_tool ?? "register_existing_files",
            tags: pat.tags,
          });
          summaryByKind[pat.kind] = (summaryByKind[pat.kind] ?? 0) + 1;
          void stat;
        } catch (e) {
          // Continue on errors but record. saveArtifact only throws on
          // schema-level issues, which we can swallow per-file.
          summaryByKind[`${pat.kind}:error`] = (summaryByKind[`${pat.kind}:error`] ?? 0) + 1;
        }
      }
      const lines: string[] = [];
      lines.push(`register_existing_files complete.`);
      lines.push(`Project: ${projectRoot}`);
      lines.push(`Registered: ${planned.length}`);
      lines.push(`Already registered (skipped): ${skippedAlreadyRegistered.length}`);
      lines.push(`Unmatched (no pattern covers them): ${unmatched.length}`);
      lines.push(``);
      lines.push(`By kind:`);
      for (const [kind, n] of Object.entries(summaryByKind)) {
        lines.push(`  ${kind}: ${n}`);
      }
      return textContent(lines.join("\n"));
    },
  );

  server.tool(
    "scan_registration_delta",
    "Read-only: scan the project filesystem for files that match c64re's known artifact extensions but are not registered in knowledge/artifacts.json. Surfaces the gap that opens up when bulk operations bypass the MCP layer. Use this before agent_record_step or before sealing a checkpoint.",
    {
      project_dir: z.string().optional(),
      cap: z.number().int().positive().max(500).optional().describe("Maximum example file paths to return (default 50)."),
    },
    async ({ project_dir, cap }) => {
      const projectRoot = ctx.projectDir(project_dir);
      const delta = scanRegistrationDelta(projectRoot, cap ?? 50);
      const lines: string[] = [];
      lines.push(`# Registration Delta`);
      lines.push(`Project: ${projectRoot}`);
      lines.push(``);
      lines.push(`Candidates scanned: ${delta.totalCandidates}`);
      lines.push(`Already registered: ${delta.alreadyRegistered}`);
      lines.push(`Unregistered: ${delta.unregisteredCount}`);
      lines.push(``);
      if (delta.unregisteredCount > 0) {
        lines.push(`By extension:`);
        const sorted = Object.entries(delta.unregisteredByExt).sort((a, b) => b[1] - a[1]);
        for (const [ext, n] of sorted) lines.push(`  ${ext}: ${n}`);
        lines.push(``);
        lines.push(`Examples (first ${delta.unregistered.length}):`);
        for (const f of delta.unregistered) lines.push(`  ${f}`);
      } else {
        lines.push(`✓ No unregistered files. Artifact store is in sync.`);
      }
      return textContent(lines.join("\n"));
    },
  );

  void existsSync; // tree-shake guard
}
