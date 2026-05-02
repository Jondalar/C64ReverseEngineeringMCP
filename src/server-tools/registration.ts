import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { describeWalkRoots, findUnimportedAnalysisArtifacts, listCandidateFiles, matchesGlob, scanRegistrationDelta, statSafe } from "../lib/registration-delta.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

// Built-in glob set used when register_existing_files is called with no
// `patterns` arg (R4 in REQUIREMENTS.md). Covers every c64re-produced
// extension across input, analysis, generated, view, knowledge, and session
// scopes, and excludes rebuild-check PRGs (Bug 14).
const DEFAULT_PATTERNS: Array<{
  glob: string;
  kind: typeof KIND_VALUES[number];
  scope: typeof SCOPE_VALUES[number];
  role?: string;
  format?: string;
}> = [
  { glob: "input/disk/*.d64", kind: "d64", scope: "input", role: "source-disk" },
  { glob: "input/disk/*.g64", kind: "g64", scope: "input", role: "source-disk" },
  { glob: "input/cart/*.crt", kind: "crt", scope: "input", role: "source-cart" },
  { glob: "input/prg/*.prg", kind: "prg", scope: "input", role: "source-prg" },
  { glob: "analysis/disk/*/manifest.json", kind: "manifest", scope: "analysis", role: "disk-manifest", format: "json" },
  { glob: "analysis/disk/**/*_analysis.json", kind: "analysis-run", scope: "analysis", role: "prg-analysis", format: "json" },
  { glob: "analysis/disk/**/*_disasm.asm", kind: "listing", scope: "analysis", role: "disasm", format: "asm" },
  { glob: "analysis/disk/**/*_disasm.tass", kind: "generated-source", scope: "generated", role: "disasm-tass", format: "tass" },
  { glob: "analysis/disk/**/raw_sectors/**/*.bin", kind: "raw", scope: "analysis", role: "raw-sector", format: "bin" },
  { glob: "analysis/runtime/**/session.json", kind: "checkpoint", scope: "session", role: "vice-session", format: "json" },
  { glob: "analysis/runtime/**/trace/summary.json", kind: "report", scope: "session", role: "trace-summary", format: "json" },
  { glob: "analysis/runtime/**/trace/trace-analysis.json", kind: "report", scope: "session", role: "trace-analysis", format: "json" },
  { glob: "analysis/runtime/**/trace/events.jsonl", kind: "trace", scope: "session", role: "trace-events", format: "jsonl" },
  { glob: "views/*.json", kind: "view-model", scope: "view", format: "json" },
  { glob: "docs/**/*.md", kind: "other", scope: "knowledge", role: "doc", format: "md" },
];

// Files we never want to auto-register through default globs. Currently
// only rebuild-check PRGs (Bug 14) — they are byproducts of disasm_prg's
// verify step, not source assets.
const DEFAULT_EXCLUDE_GLOBS = ["**/*_disasm_rebuild_check.prg"];

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
    "Walk the project filesystem and register files that match one or more glob patterns into knowledge/artifacts.json. When called with no patterns, applies a built-in default set covering every c64re-produced extension (input/disk, analysis JSON, listing ASM, raw sectors, runtime traces, view models, docs). Glob semantics: patterns are relative to the project root, * matches within a single path component, ** matches across components. Idempotent: files already registered (by relativePath) are skipped. dry_run=true previews the work without writing.",
    {
      project_dir: z.string().optional(),
      patterns: z.array(patternSchema).optional().describe("Optional glob+metadata patterns. When omitted, the built-in default set is used."),
      dry_run: z.boolean().optional().describe("If true, return the planned registrations without writing. Default false."),
      include_excluded: z.boolean().optional().describe("If true, do not apply the default exclude list (e.g. *_disasm_rebuild_check.prg). Default false."),
    },
    safeHandler("register_existing_files", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const patterns = args.patterns && args.patterns.length > 0 ? args.patterns : DEFAULT_PATTERNS.map((p) => ({ ...p }));
      const usingDefaults = !args.patterns || args.patterns.length === 0;
      const allCandidates = listCandidateFiles(projectRoot);
      const excludeGlobs = args.include_excluded ? [] : DEFAULT_EXCLUDE_GLOBS;
      const candidates = excludeGlobs.length > 0
        ? allCandidates.filter((rel) => !excludeGlobs.some((g) => matchesGlob(rel, g)))
        : allCandidates;
      const excluded = allCandidates.length - candidates.length;
      // Already-registered set so we count "skipped" too.
      const existing = new Set<string>(
        service.listArtifacts().map((a) => a.relativePath),
      );

      const planned: Array<{ pattern: number; relativePath: string; kind: string; scope: string }> = [];
      const skippedAlreadyRegistered: string[] = [];
      const unmatched: string[] = [];

      for (const rel of candidates) {
        let matchedAny = false;
        for (let pi = 0; pi < patterns.length; pi++) {
          if (matchesGlob(rel, patterns[pi]!.glob)) {
            matchedAny = true;
            if (existing.has(rel)) {
              skippedAlreadyRegistered.push(rel);
              break;
            }
            planned.push({ pattern: pi, relativePath: rel, kind: patterns[pi]!.kind, scope: patterns[pi]!.scope });
            // Mark to avoid double-adding when multiple patterns match.
            existing.add(rel);
            break;
          }
        }
        if (!matchedAny) unmatched.push(rel);
      }

      // Bug 9 diagnostics: when the scan found zero candidates, surface the
      // walk roots and observed top-level entries so the user can debug
      // glob-vs-layout mismatches without re-running with --dry_run.
      const zeroMatch = candidates.length === 0;

      if (args.dry_run || zeroMatch && !args.include_excluded) {
        const lines: string[] = [];
        lines.push(`register_existing_files${args.dry_run ? " (dry run)" : ""}`);
        lines.push(`Project: ${projectRoot}`);
        lines.push(`Patterns: ${usingDefaults ? `built-in defaults (${patterns.length})` : `user-supplied (${patterns.length})`}`);
        lines.push(`Candidates scanned: ${candidates.length}${excluded > 0 ? ` (${excluded} excluded by default exclude globs)` : ""}`);
        lines.push(`Would register: ${planned.length}`);
        lines.push(`Already registered (skipped): ${skippedAlreadyRegistered.length}`);
        lines.push(`No-match (no pattern covers them): ${unmatched.length}`);
        lines.push(``);
        lines.push(`Planned by pattern:`);
        for (let pi = 0; pi < patterns.length; pi++) {
          const cnt = planned.filter((p) => p.pattern === pi).length;
          lines.push(`  [${pi}] glob=${patterns[pi]!.glob} kind=${patterns[pi]!.kind} scope=${patterns[pi]!.scope} → ${cnt} files`);
        }
        if (unmatched.length > 0) {
          lines.push(``);
          lines.push(`Unmatched samples (first 10):`);
          for (const u of unmatched.slice(0, 10)) lines.push(`  ${u}`);
        }
        if (zeroMatch) {
          lines.push(``);
          lines.push(`Walk roots and observed top-level entries:`);
          for (const root of describeWalkRoots(projectRoot)) {
            lines.push(`  ${root.subdir}/  ${root.exists ? "(exists)" : "(missing)"}`);
            if (root.exists && root.topLevelEntries.length > 0) {
              lines.push(`    entries: ${root.topLevelEntries.join(", ")}`);
            }
          }
          if (args.dry_run) {
            // user already asked for a dry run; no further hint needed
          } else {
            lines.push(``);
            lines.push(`Hint: re-run with dry_run=true to inspect plan, or include_excluded=true to also walk *_disasm_rebuild_check.prg files.`);
          }
        }
        if (args.dry_run || zeroMatch) {
          return textContent(lines.join("\n"));
        }
      }

      // Live run: invoke saveArtifact for each planned entry.
      const summaryByKind: Record<string, number> = {};
      for (const p of planned) {
        const pat = patterns[p.pattern]!;
        const absPath = resolve(projectRoot, p.relativePath);
        const stat = statSafe(absPath);
        const stem = p.relativePath.split("/").pop()!;
        const patAny = pat as { title_template?: string; produced_by_tool?: string; tags?: string[] };
        const title = patAny.title_template ?? stem;
        const producedByTool = patAny.produced_by_tool ?? "register_existing_files";
        const tags = patAny.tags;
        try {
          service.saveArtifact({
            kind: pat.kind,
            scope: pat.scope,
            title,
            path: absPath,
            format: pat.format,
            role: pat.role,
            producedByTool,
            tags,
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
      lines.push(`Patterns: ${usingDefaults ? `built-in defaults (${patterns.length})` : `user-supplied (${patterns.length})`}`);
      lines.push(`Registered: ${planned.length}`);
      lines.push(`Already registered (skipped): ${skippedAlreadyRegistered.length}`);
      lines.push(`Excluded by default exclude globs: ${excluded}`);
      lines.push(`Unmatched (no pattern covers them): ${unmatched.length}`);
      lines.push(``);
      lines.push(`By kind:`);
      for (const [kind, n] of Object.entries(summaryByKind)) {
        lines.push(`  ${kind}: ${n}`);
      }
      return textContent(lines.join("\n"));
    }),
  );

  server.tool(
    "scan_registration_delta",
    "Read-only: scan the project filesystem for files that match c64re's known artifact extensions but are not registered in knowledge/artifacts.json. Surfaces the gap that opens up when bulk operations bypass the MCP layer. Use this before agent_record_step or before sealing a checkpoint.",
    {
      project_dir: z.string().optional(),
      cap: z.number().int().positive().max(500).optional().describe("Maximum example file paths to return (default 50)."),
    },
    safeHandler("scan_registration_delta", async ({ project_dir, cap }: { project_dir?: string; cap?: number }) => {
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
    }),
  );

  server.tool(
    "bulk_import_analysis_reports",
    "Walk every analysis-run artifact in the project and call import_analysis_report on those whose entities are not yet back-linked. Closes the gap that opens when bulk CLI runs (`dist/pipeline/cli.cjs analyze-prg`) register the analysis JSON but never invoke the entity / finding importer. After this runs, the loadSequence Payload-Focus dropdown in the workspace UI populates with non-empty stages and memory-map filtering becomes meaningful again.",
    {
      project_dir: z.string().optional(),
      limit: z.number().int().positive().max(2000).optional().describe("Max artifacts to import in one call. Default 500."),
      dry_run: z.boolean().optional().describe("If true, return the planned import set without writing."),
    },
    safeHandler("bulk_import_analysis_reports", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const candidates = findUnimportedAnalysisArtifacts(service);
      const limit = args.limit ?? 500;
      const slice = candidates.slice(0, limit);
      if (args.dry_run) {
        const lines: string[] = [];
        lines.push(`bulk_import_analysis_reports (dry run)`);
        lines.push(`Project: ${projectRoot}`);
        lines.push(`Unimported analysis-run artifacts: ${candidates.length}`);
        lines.push(`Would import (limit=${limit}): ${slice.length}`);
        if (slice.length > 0) {
          lines.push(``);
          lines.push(`Examples:`);
          for (const a of slice.slice(0, 10)) lines.push(`  ${a.id} (${a.relativePath})`);
        }
        return textContent(lines.join("\n"));
      }
      let imported = 0;
      let entityTotal = 0;
      let findingTotal = 0;
      let relationTotal = 0;
      let flowTotal = 0;
      let questionTotal = 0;
      const errors: Array<{ id: string; error: string }> = [];
      for (const a of slice) {
        try {
          const r = service.importAnalysisArtifact(a.id);
          imported += 1;
          entityTotal += r.importedEntityCount;
          findingTotal += r.importedFindingCount;
          relationTotal += r.importedRelationCount;
          flowTotal += r.importedFlowCount;
          questionTotal += r.importedOpenQuestionCount;
        } catch (e) {
          errors.push({ id: a.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const lines: string[] = [];
      lines.push(`bulk_import_analysis_reports complete.`);
      lines.push(`Project: ${projectRoot}`);
      lines.push(`Imported: ${imported} of ${slice.length} attempted (${candidates.length} candidates total).`);
      if (candidates.length > slice.length) {
        lines.push(`More candidates remain (${candidates.length - slice.length}); raise --limit or run again.`);
      }
      lines.push(`Aggregate: ${entityTotal} entities, ${findingTotal} findings, ${relationTotal} relations, ${flowTotal} flows, ${questionTotal} questions.`);
      if (errors.length > 0) {
        lines.push(``);
        lines.push(`Errors (${errors.length}, first 5):`);
        for (const e of errors.slice(0, 5)) lines.push(`  ${e.id}: ${e.error}`);
      }
      return textContent(lines.join("\n"));
    }),
  );

  void existsSync; // tree-shake guard
}
