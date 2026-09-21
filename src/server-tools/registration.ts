import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { describeWalkRoots, findUnimportedAnalysisArtifacts, listCandidateFiles, matchesGlob, scanRegistrationDelta, statSafe } from "../lib/registration-delta.js";
import { howToSilenceToolOutput, INVENTORY_KIND_VALUES, INVENTORY_PATTERNS_FILE, INVENTORY_SCOPE_VALUES } from "../project-knowledge/inventory-patterns.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

export interface RegistrationPattern {
  glob: string;
  kind: typeof KIND_VALUES[number];
  scope: typeof SCOPE_VALUES[number];
  role?: string;
  format?: string;
}

// Built-in glob set used when register_existing_files is called with no
// `patterns` arg (R4 in REQUIREMENTS.md). Covers every c64re-produced
// extension across input, analysis, generated, view, knowledge, and session
// scopes, and excludes rebuild-check PRGs (Bug 14).
//
// Spec 730.3 / §7: the analysis-folder globs are broadened from the original
// `analysis/disk/**`-only coverage to `analysis/**`, so disasm output produced
// outside the disk subtree is still registered. The trailing block adds the
// "semantic / hand-curated source" patterns (.asm/.tas/.sym/.md authored by a
// human under analysis folders) so a better-than-generated source file on disk
// becomes visible to the artifact resolver instead of being invisible
// (BUG-019). These come AFTER the generated `*_disasm.*` patterns so a generated
// listing keeps its specific `listing` / `generated-source` role and only the
// remaining hand-made source files fall through to the curated-source role.
export const DEFAULT_PATTERNS: RegistrationPattern[] = [
  { glob: "input/disk/*.d64", kind: "d64", scope: "input", role: "source-disk" },
  { glob: "input/disk/*.g64", kind: "g64", scope: "input", role: "source-disk" },
  { glob: "input/cart/*.crt", kind: "crt", scope: "input", role: "source-cart" },
  { glob: "input/prg/*.prg", kind: "prg", scope: "input", role: "source-prg" },
  { glob: "analysis/**/manifest.json", kind: "manifest", scope: "analysis", role: "disk-manifest", format: "json" },
  // Spec 784's extraction manifest. It is the artifact the per-project extractor
  // stands behind (TOOL_OWNED_MANIFEST_NAMES deliberately keeps it out of the
  // machine-output bucket), and with no pattern for it, it was reported as an
  // unregistered file on every single sync. `report`, not `manifest`: the disk-manifest
  // importer does not read this shape — `register_payloads_from_manifest` is its door.
  { glob: "analysis/**/manifest.spec784.json", kind: "report", scope: "analysis", role: "extraction-manifest", format: "json" },
  { glob: "analysis/g64/**/track-metadata.json", kind: "report", scope: "analysis", role: "g64-extraction", format: "json" },
  { glob: "analysis/**/*_analysis.json", kind: "analysis-run", scope: "analysis", role: "prg-analysis", format: "json" },
  { glob: "analysis/**/*_annotations.json", kind: "report", scope: "analysis", role: "annotations", format: "json" },
  { glob: "analysis/**/*_disasm.asm", kind: "listing", scope: "analysis", role: "disasm", format: "asm" },
  { glob: "analysis/**/*_disasm.tas", kind: "generated-source", scope: "generated", role: "disasm-tass", format: "tass" },
  // pre-2026-09-06 output; the renderer writes `.tas` now, old projects keep theirs
  { glob: "analysis/**/*_disasm.tass", kind: "generated-source", scope: "generated", role: "disasm-tass", format: "tass" },
  { glob: "analysis/**/raw_sectors/**/*.bin", kind: "raw", scope: "analysis", role: "raw-sector", format: "bin" },
  { glob: "analysis/runtime/**/session.json", kind: "checkpoint", scope: "session", role: "vice-session", format: "json" },
  { glob: "analysis/runtime/**/trace/summary.json", kind: "report", scope: "session", role: "trace-summary", format: "json" },
  { glob: "analysis/runtime/**/trace/trace-analysis.json", kind: "report", scope: "session", role: "trace-analysis", format: "json" },
  { glob: "analysis/runtime/**/trace/events.jsonl", kind: "trace", scope: "session", role: "trace-events", format: "jsonl" },
  // R29: headless-runtime session outputs.
  { glob: "analysis/headless-runtime/**/session.json", kind: "report", scope: "session", role: "headless-session", format: "json" },
  { glob: "analysis/headless-runtime/**/trace/runtime-trace.jsonl", kind: "trace", scope: "session", role: "runtime-trace", format: "jsonl" },
  { glob: "analysis/headless-runtime/**/trace/summary.json", kind: "report", scope: "session", role: "trace-summary", format: "json" },
  { glob: "views/*.json", kind: "view-model", scope: "view", format: "json" },
  { glob: "docs/**/*.md", kind: "other", scope: "knowledge", role: "doc", format: "md" },
  // Spec 730.3 §7 — semantic / hand-curated source under analysis folders.
  // Conservative: only catches files NOT already claimed by a more specific
  // pattern above (first-match-wins in the scan loop). Role marks them as
  // human-authored source the resolver should prefer over generated output.
  { glob: "analysis/**/*.asm", kind: "generated-source", scope: "analysis", role: "semantic-source", format: "asm" },
  { glob: "analysis/**/*.tas", kind: "generated-source", scope: "analysis", role: "semantic-source", format: "tass" },
  { glob: "analysis/**/*.tass", kind: "generated-source", scope: "analysis", role: "semantic-source", format: "tass" },
  { glob: "analysis/**/*.sym", kind: "other", scope: "analysis", role: "symbols", format: "sym" },
  { glob: "analysis/**/*.md", kind: "other", scope: "analysis", role: "semantic-notes", format: "md" },
];

// Files we never want to auto-register through default globs. Currently
// only rebuild-check PRGs (Bug 14) — they are byproducts of disasm_prg's
// verify step, not source assets.
const DEFAULT_EXCLUDE_GLOBS = ["**/*_disasm_rebuild_check.prg"];

// One vocabulary, declared in the leaf module both this tool and the project's own
// `knowledge/inventory-patterns.json` reader share — so a project reading a refusal
// here and a project writing a declaration there are told the same list.
const KIND_VALUES = INVENTORY_KIND_VALUES;
const SCOPE_VALUES = INVENTORY_SCOPE_VALUES;

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

export interface RegisterFilesResult {
  registered: number;
  registeredByKind: Record<string, number>;
  skippedAlreadyRegistered: number;
  excludedByGlob: number;
  unmatched: string[];
  errors: Array<{ relativePath: string; error: string }>;
  /**
   * How many candidate files each pattern matched, by glob.
   *
   * The previous round taught the declaration file to explain a MALFORMED entry.
   * A well-formed one that matches nothing was still silent: a project declared
   * `analysis/overlays/*.prg`, the door accepted it without a word, and 207
   * outputs stayed unregistered with no way to find out why. A zero here is what
   * the sync turns into that sentence.
   */
  matchesByGlob: Record<string, number>;
  /** Every candidate file the walk saw — the material a diagnosis is made from. */
  candidates: string[];
}

// Core registration pass shared by register_existing_files (the internal tool)
// and project_inventory_sync (the Spec 730.3 product facade). Walks the project
// for candidate files, glob-matches them against `patterns` (first match wins),
// skips files already registered (by relativePath) and the default-exclude set,
// and calls saveArtifact for the rest. Pure side-effect on the knowledge store;
// never moves/copies/deletes files. Idempotent: a second call registers nothing
// new because the candidates are already in artifacts.json.
export function registerProjectFiles(
  service: ProjectKnowledgeService,
  projectRoot: string,
  patterns: RegistrationPattern[],
  opts: { producedByTool?: string; includeExcluded?: boolean } = {},
): RegisterFilesResult {
  const allCandidates = listCandidateFiles(projectRoot);
  const excludeGlobs = opts.includeExcluded ? [] : DEFAULT_EXCLUDE_GLOBS;
  const candidates = excludeGlobs.length > 0
    ? allCandidates.filter((rel) => !excludeGlobs.some((g) => matchesGlob(rel, g)))
    : allCandidates;
  const excludedByGlob = allCandidates.length - candidates.length;
  const existing = new Set<string>(service.listArtifacts().map((a) => a.relativePath));

  const planned: Array<{ pattern: RegistrationPattern; relativePath: string }> = [];
  let skippedAlreadyRegistered = 0;
  const unmatched: string[] = [];
  const matchesByGlob: Record<string, number> = {};
  for (const pat of patterns) matchesByGlob[pat.glob] = matchesByGlob[pat.glob] ?? 0;

  for (const rel of candidates) {
    let matchedAny = false;
    for (const pat of patterns) {
      if (matchesGlob(rel, pat.glob)) {
        matchedAny = true;
        matchesByGlob[pat.glob] = (matchesByGlob[pat.glob] ?? 0) + 1;
        if (existing.has(rel)) {
          skippedAlreadyRegistered += 1;
          break;
        }
        planned.push({ pattern: pat, relativePath: rel });
        existing.add(rel); // avoid double-add when multiple patterns match.
        break;
      }
    }
    if (!matchedAny) unmatched.push(rel);
  }

  const registeredByKind: Record<string, number> = {};
  const errors: Array<{ relativePath: string; error: string }> = [];
  for (const p of planned) {
    const absPath = resolve(projectRoot, p.relativePath);
    const stem = p.relativePath.split("/").pop()!;
    try {
      service.saveArtifact({
        kind: p.pattern.kind,
        scope: p.pattern.scope,
        title: stem,
        path: absPath,
        format: p.pattern.format,
        role: p.pattern.role,
        producedByTool: opts.producedByTool ?? "register_existing_files",
      });
      registeredByKind[p.pattern.kind] = (registeredByKind[p.pattern.kind] ?? 0) + 1;
    } catch (e) {
      errors.push({ relativePath: p.relativePath, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    registered: planned.length - errors.length,
    registeredByKind,
    skippedAlreadyRegistered,
    excludedByGlob,
    unmatched,
    errors,
    matchesByGlob,
    candidates,
  };
}

// ───────────────────────────────────────── the way back (BUG-060 defect 1)

export interface UnregisterFilesResult {
  /** Rows matched by the glob. */
  matched: number;
  /** Rows actually taken out of the store. */
  removed: number;
  removedPaths: string[];
  /** Rows the glob matched that were refused, each with the reason it was kept. */
  kept: Array<{ artifactId: string; relativePath: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Un-register the artifact rows a glob matches. The inverse of `registerProjectFiles`.
 *
 * Registration had no inverse, and that is half of what made the tool-output
 * recommendation dangerous: a caller that registered 2732 per-sector dumps could move
 * the glob to `intentional` afterwards and stop NEW registrations, but the rows stayed
 * and the coverage denominator stayed wrong for ever. The next sync answered "Files
 * registered: 0" — correctly, and uselessly.
 *
 * What it refuses, and why: a row somebody has WRITTEN something about is not a
 * registration mistake, it is work. So a row is kept when a finding / entity / relation
 * / flow / open question references it, when it names entities of its own, when it sits
 * in a lineage (derived from something, something derived from it, or it carries a
 * version history), or when its version group holds more than one member. Everything
 * else is just a path the store knows about, and the store can forget it.
 *
 * It never deletes a FILE. The bulk it exists for is a tool's output, and the tool will
 * read those bytes again.
 */
export function unregisterProjectFiles(
  service: ProjectKnowledgeService,
  projectRoot: string,
  opts: { glob: string; dryRun?: boolean },
): UnregisterFilesResult {
  void projectRoot;
  const artifacts = service.listArtifacts();
  const matched = artifacts.filter((a) => matchesGlob(a.relativePath ?? "", opts.glob));

  // Everything the knowledge layer points at, in one pass.
  const referenced = new Map<string, string>();
  const note = (id: string | undefined, why: string) => {
    if (id && !referenced.has(id)) referenced.set(id, why);
  };
  for (const f of service.listFindings()) for (const id of f.artifactIds ?? []) note(id, `a finding cites it ("${f.title}")`);
  for (const e of service.listEntities()) {
    for (const id of e.artifactIds ?? []) note(id, `an entity is linked to it ("${e.name}")`);
    note(e.payloadSourceArtifactId, `it holds a payload's bytes ("${e.name}")`);
    note(e.payloadDepackedArtifactId, `it holds a payload's depacked bytes ("${e.name}")`);
    for (const id of e.payloadAsmArtifactIds ?? []) note(id, `it is a payload's disassembly ("${e.name}")`);
  }
  for (const r of service.listRelations()) for (const id of r.artifactIds ?? []) note(id, `a relation cites it ("${r.title}")`);
  for (const fl of service.listFlows()) for (const id of fl.artifactIds ?? []) note(id, `a flow cites it ("${fl.title}")`);
  for (const q of service.listOpenQuestions()) for (const id of q.artifactIds ?? []) note(id, `an open question cites it ("${q.title}")`);
  // Lineage in both directions.
  for (const a of artifacts) {
    note(a.derivedFrom, "another artifact is derived from it");
    for (const id of a.sourceArtifactIds ?? []) note(id, "another artifact names it as a source");
  }
  const multiVersionSubjects = new Set<string>();
  for (const group of service.listArtifactVersionGroups()) {
    if (group.versions.length > 1) for (const v of group.versions) multiVersionSubjects.add(v.artifactId);
  }

  const kept: UnregisterFilesResult["kept"] = [];
  const removable: string[] = [];
  for (const a of matched) {
    const reason = referenced.get(a.id)
      ?? (a.derivedFrom ? "it is derived from another artifact" : undefined)
      ?? ((a.versions ?? []).length > 0 ? "it carries a version history" : undefined)
      ?? ((a.entityIds ?? []).length > 0 ? "it names entities of its own" : undefined)
      ?? (multiVersionSubjects.has(a.id) ? "its subject holds more than one version" : undefined);
    if (reason) kept.push({ artifactId: a.id, relativePath: a.relativePath ?? "", reason });
    else removable.push(a.id);
  }

  const removed = opts.dryRun ? removable.length : service.removeArtifacts(removable);
  return {
    matched: matched.length,
    removed,
    removedPaths: matched.filter((a) => removable.includes(a.id)).map((a) => a.relativePath ?? ""),
    kept,
    dryRun: opts.dryRun === true,
  };
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
    "unregister_files",
    "Take artifact rows back out of the project knowledge store — the inverse of registering files. Use after a bulk of machine output (per-sector dumps, depack scratch, raw track binaries) was registered by mistake: those rows add their bytes to the project's coverage denominator without adding anything to what is understood, and moving the glob to `intentional` only stops NEW registrations — the rows already written stay. Matches the same glob dialect as registration (relative to the project root; * within a path component, ** across them). It NEVER deletes a file from disk, and it refuses any row somebody has written about — one a finding, entity, relation, flow or open question cites, one that sits in a lineage, or one whose subject holds more than one version — naming each refusal and why. dry_run=true previews. Not for removing a file (delete it on disk and re-sync) and not for hiding infrastructure from the UI (that is the internal flag).",
    {
      project_dir: z.string().optional(),
      glob: z.string().describe("Glob for the rows to take out, relative to the project root, e.g. 'analysis/g64/**/*.bin'."),
      dry_run: z.boolean().optional().describe("If true, report what would be taken out without writing. Default false."),
    },
    safeHandler("unregister_files", async ({ project_dir, glob, dry_run }: { project_dir?: string; glob: string; dry_run?: boolean }) => {
      const projectRoot = ctx.projectDir(project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const r = unregisterProjectFiles(service, projectRoot, { glob, dryRun: dry_run });
      const lines: string[] = [];
      lines.push(`unregister_files${r.dryRun ? " (dry run)" : ""} — ${glob}`);
      lines.push(`Project: ${projectRoot}`);
      lines.push(`Rows matched: ${r.matched}`);
      lines.push(`Rows ${r.dryRun ? "that would be taken out" : "taken out"}: ${r.removed}`);
      lines.push(`Files on disk touched: 0 — this unregisters, it does not delete.`);
      if (r.kept.length > 0) {
        lines.push(``);
        lines.push(`Kept (${r.kept.length}) — something is written about these:`);
        for (const k of r.kept.slice(0, 20)) lines.push(`  ${k.relativePath} — ${k.reason}`);
        if (r.kept.length > 20) lines.push(`  … and ${r.kept.length - 20} more, same shape.`);
      }
      if (r.removed > 0 && !r.dryRun) {
        lines.push(``);
        lines.push(`Declare the glob \`intentional\` in ${INVENTORY_PATTERNS_FILE} so the next sync does not register them again:`);
        lines.push(`  { "patterns": [], "intentional": [${JSON.stringify(glob)}] }`);
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
      lines.push(`Tool output (machine-written, not debt): ${delta.toolOutputCount}`);
      lines.push(`Declared intentional by the project (not debt): ${delta.declaredIntentionalCount}`);
      lines.push(``);
      if (delta.declarationError) lines.push(`⚠ ${delta.declarationError}`);
      for (const p of delta.declarationProblems) lines.push(`⚠ ${p}`);
      if (delta.declarationError || delta.declarationProblems.length > 0) lines.push(``);
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
      // Spec 832 D5 — files a tool wrote into a directory it owns and fills are
      // reported here, apart from the human's list. Nothing to do per file: the
      // run's manifest is the artifact that stands for the bulk.
      if (delta.toolOutputCount > 0) {
        lines.push(``);
        lines.push(`Tool output by directory:`);
        const byDir = Object.entries(delta.toolOutputByDir).sort((a, b) => b[1] - a[1]);
        for (const [prefix, n] of byDir) lines.push(`  ${prefix}/**: ${n}  (${delta.toolOutputBytesByDir[prefix] ?? 0} bytes)`);
        lines.push(`  (register the run's manifest, not each file)`);
        // BUG-060 defect 1 — one answer about a tool's bulk, wherever it is reported.
        lines.push(...howToSilenceToolOutput(delta.toolOutputByDir, delta.toolOutputBytesByDir, delta.toolOutputBytes));
      }
      if (delta.declaredIntentionalCount > 0) {
        lines.push(``);
        lines.push(`Declared intentional in ${INVENTORY_PATTERNS_FILE} (${delta.declaredIntentionalCount}, showing ${delta.declaredIntentional.length}):`);
        for (const f of delta.declaredIntentional) lines.push(`  ${f}`);
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
