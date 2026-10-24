import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { graphFirstVerdict, noteListingRead, LARGE_LISTING_LINES } from "../contract/graph-first.js";

export function registerArtifactTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "read_artifact",
    "Read a generated artifact (ASM, JSON, SYM, MD) into context — C64 disassemblies are ≤64 KB and fit whole. Use to inspect a disassembly, analysis JSON, or report. Not for raw disk/cart media (use extract_disk / extract_crt) or directory peeks (use inspect_disk). Inputs: artifact path/id. Returns: file contents.",
    {
      path: z.string().describe("Path to the artifact (relative to project dir or absolute)"),
    },
    async ({ path: filePath }) => {
      const pd = context.projectDir({ fileHint: filePath });
      const absPath = resolve(pd, filePath);
      const text = context.readTextFile(absPath, 10 * 1024 * 1024);

      // Spec 881 D1 — a large listing waits until the graph has been asked something this
      // session. Counted and decided after the read, because the line count is the
      // measure and the file is small enough to have read either way; nothing is hidden,
      // the text simply is not handed over yet.
      const lines = text.length ? text.split("\n").length : 0;
      const verdict = graphFirstVerdict(pd, absPath, lines);
      if (verdict.refusal) return { content: [{ type: "text" as const, text: verdict.refusal }] };
      if (lines >= LARGE_LISTING_LINES) noteListingRead(pd, relative(resolve(pd), absPath) || filePath);

      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "list_artifacts",
    "List the project's registered artifacts — media (D64/G64/CRT/PRG), extracted payloads, listings, analysis JSON, documents — one line each with its id, kind/role and path. Use to see what the project holds and to get an artifact id before reading or linking one. Not for payload entities (use list_payloads) or knowledge records (use list_findings). Inputs: optional project_dir, subdir (a path prefix; '.' or omitted = all), kind, include_internal. Returns: id, kind/role, path, size per artifact, and how many files on disk are not registered yet.",
    {
      project_dir: z.string().optional().describe("Project root. Defaults to C64RE_PROJECT_DIR or the active project."),
      subdir: z.string().optional().describe("Only artifacts whose path starts with this (e.g. 'input', 'analysis/disk'). '.' or omitted: all."),
      kind: z.string().optional().describe("Only this artifact kind (e.g. d64, prg, listing)."),
      include_internal: z.boolean().optional().describe("Also list internal files (manifests, analysis JSON, annotation files). Default false, as in the workbench."),
    },
    async ({ project_dir, subdir, kind, include_internal }) => {
      // The registry is the answer, not the directory: a walk of analysis/ with an extension
      // list never showed media, ignored the project it was given, and carried no ids.
      const pd = context.projectDir({ projectDir: project_dir, fileHint: subdir });
      const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
      const service = new ProjectKnowledgeService(pd);
      const prefix = subdir && subdir !== "." ? subdir.replace(/^\.\//, "").replace(/\/+$/, "") : undefined;
      const relOf = (p: string): string => (isAbsolute(p) ? relative(pd, p) : p).replace(/\\/g, "/");
      const all = service.listArtifacts();
      const rows = all
        .filter((a) => include_internal || !a.internal)
        .filter((a) => !kind || a.kind === kind)
        .filter((a) => !prefix || relOf(a.path) === prefix || relOf(a.path).startsWith(`${prefix}/`))
        .sort((x, y) => relOf(x.path).localeCompare(relOf(y.path)));
      const lines = rows.map((a) => {
        const abs = isAbsolute(a.path) ? a.path : join(pd, a.path);
        const size = existsSync(abs) ? `${(statSync(abs).size / 1024).toFixed(1)} KB` : "missing on disk";
        return `${a.id}  ${a.kind}${a.role ? `/${a.role}` : ""}  ${relOf(a.path)}  (${size})`;
      });
      const hidden = include_internal ? 0 : all.filter((a) => a.internal).length;
      const out = [lines.length ? `${lines.length} artifact(s)${prefix ? ` under ${prefix}/` : ""}${kind ? `, kind ${kind}` : ""}:` : `[no registered artifacts${prefix ? ` under ${prefix}/` : ""}${kind ? ` of kind ${kind}` : ""}]`, ...lines];
      if (hidden > 0) out.push(``, `${hidden} internal file(s) not shown (include_internal=true lists them).`);
      try {
        const { scanRegistrationDelta } = await import("../lib/registration-delta.js");
        const delta = scanRegistrationDelta(pd, 3);
        if (delta.unregisteredCount > 0) out.push(``, `${delta.unregisteredCount} file(s) on disk are not registered — project_inventory_sync registers them.`);
      } catch { /* the listing stands without the delta */ }
      return { content: [{ type: "text" as const, text: out.join("\n") }] };
    },
  );

  server.tool(
    "build_tools",
    "Compile the TRXDis pipeline (npm run build) in a source checkout or a C64RE_TOOLS_DIR tree, after its source changed. An installed package ships the pipeline built and has nothing to compile.",
    {},
    async () => {
      const td = context.toolsDir();
      // An installed package carries dist/ and no TypeScript: `npm run build` there has no
      // tsconfig to read and fails with a compiler error that says nothing useful.
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!existsSync(join(td, "tsconfig.json"))) {
        return { content: [{ type: "text" as const, text:
          `build_tools: nothing to compile in ${td} — it has no tsconfig.json, which is what an installed package looks like; the pipeline there is already built. Set C64RE_TOOLS_DIR to a source tree to rebuild one.` }] };
      }
      // Not `execFile("npm", …)`: on Windows npm is a batch file, which Node will not start
      // without a shell. npm-cli.js run by this Node works everywhere.
      const { findNpmCli, NPM_NOT_FOUND } = await import("../lib/npm-cli.js");
      const npm = findNpmCli();
      if (!npm) return { content: [{ type: "text" as const, text: `build_tools: ${NPM_NOT_FOUND}` }] };
      const { execFile } = await import("node:child_process");
      return new Promise((resolveResult) => {
        execFile(npm.cmd, [...npm.prefix, "run", "build"], { cwd: td, timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
          resolveResult(context.cliResultToContent({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? 1 : 0,
          }));
        });
      });
    },
  );
}
