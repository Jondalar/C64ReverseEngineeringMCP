import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

function parseArgs(argv) {
  const options = {
    source: "",
    workspace: "",
    name: "",
    description: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source" && argv[index + 1]) {
      options.source = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--workspace" && argv[index + 1]) {
      options.workspace = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--name" && argv[index + 1]) {
      options.name = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--description" && argv[index + 1]) {
      options.description = argv[index + 1];
      index += 1;
    }
  }

  if (!options.source || !options.workspace || !options.name) {
    throw new Error("Usage: node scripts/bootstrap-existing-re-workspace.mjs --source <dir> --workspace <dir> --name <project name> [--description <text>]");
  }

  return options;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stableId(prefix, value) {
  return `${prefix}-${slugify(value) || "item"}`;
}

function walk(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function artifactKindFor(path) {
  if (basename(path).toLowerCase() === "manifest.json") {
    return "manifest";
  }
  switch (extname(path).toLowerCase()) {
    case ".prg":
      return "prg";
    case ".g64":
      return "g64";
    case ".d64":
      return "d64";
    case ".crt":
      return "crt";
    case ".asm":
    case ".tass":
      return "generated-source";
    case ".md":
      return "report";
    default:
      return "other";
  }
}

function artifactScopeFor(path) {
  if (path.includes("/analysis/")) {
    return "analysis";
  }
  return "input";
}

function roleFor(path) {
  const normalizedPath = path.toLowerCase();
  const file = basename(path).toLowerCase();
  if (file === "manifest.json" && normalizedPath.includes("/analysis/disk/")) return "disk-manifest";
  if (file === "manifest.json" && (normalizedPath.includes("/analysis/extracted/") || normalizedPath.includes("/analysis/crt/") || normalizedPath.includes("/cart/"))) return "crt-manifest";
  if (file.endsWith("_analysis.json")) return "analysis-json";
  if (file.endsWith("_disasm.asm")) return "kickassembler-source";
  if (file.endsWith("_disasm.tass")) return "64tass-source";
  if (file.endsWith("_final.asm")) return "final-kickassembler-source";
  if (file.endsWith("_final.tass")) return "final-64tass-source";
  if (file.endsWith("_disasm_annotations.json")) return "semantic-annotations";
  if (file.endsWith("_pointer_facts.md")) return "pointer-report";
  if (file.endsWith("_ram_facts.md")) return "ram-report";
  if (file.endsWith("_rebuilt.prg")) return "rebuilt-prg";
  if (file.endsWith("trace-analysis.json")) return "runtime-trace-analysis";
  if (file.endsWith("trace-index.json")) return "runtime-trace-index";
  if (file.endsWith("summary.json")) return "runtime-trace-summary";
  if (file.endsWith(".g64")) return "disk-image";
  if (file.endsWith(".d64")) return "disk-image";
  if (file.endsWith(".crt")) return "cartridge-image";
  if (file.endsWith(".prg")) return "analysis-target";
  return "existing-artifact";
}

function formatFor(path) {
  const file = basename(path).toLowerCase();
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".md")) return "markdown";
  if (file.endsWith(".asm")) return "asm";
  if (file.endsWith(".tass")) return "tass";
  if (file.endsWith(".g64")) return "g64";
  if (file.endsWith(".d64")) return "d64";
  if (file.endsWith(".crt")) return "crt";
  if (file.endsWith(".prg")) return "prg";
  return undefined;
}

function titleFor(path) {
  return basename(path);
}

function findSourceArtifacts(sourceRoot) {
  return readdirSync(sourceRoot)
    .map((name) => join(sourceRoot, name))
    .filter((path) => existsSync(path))
    .filter((path) => [".g64", ".d64", ".crt", ".prg"].includes(extname(path).toLowerCase()))
    .sort();
}

function findAnalysisArtifacts(sourceRoot) {
  const analysisRoot = join(sourceRoot, "analysis");
  if (!existsSync(analysisRoot)) {
    return [];
  }

  return walk(analysisRoot)
    .filter((path) => {
      const file = basename(path).toLowerCase();
      return (
        file.endsWith("_analysis.json") ||
        file.endsWith("_disasm.asm") ||
        file.endsWith("_disasm.tass") ||
        file.endsWith("_final.asm") ||
        file.endsWith("_final.tass") ||
        file.endsWith("_disasm_annotations.json") ||
        file.endsWith(".md") ||
        file.endsWith("_rebuilt.prg") ||
        file === "manifest.json" ||
        file.endsWith("trace-analysis.json") ||
        file.endsWith("trace-index.json") ||
        file.endsWith("summary.json")
      );
    })
    .sort();
}

function materializeWorkspacePath(sourcePath, sourceRoot, workspaceRoot) {
  if (extname(sourcePath).toLowerCase() !== ".md") {
    return sourcePath;
  }
  const targetPath = join(workspaceRoot, "doc", relative(sourceRoot, sourcePath));
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

const options = parseArgs(process.argv.slice(2));
const service = new ProjectKnowledgeService(options.workspace);

service.initProject({
  name: options.name,
  description: options.description || `Imported reverse-engineering workspace linked to ${options.source}`,
  tags: ["existing-project", "workspace-import", slugify(options.name)],
});

const savedArtifacts = new Map();

for (const path of findSourceArtifacts(options.source)) {
  const artifact = service.saveArtifact({
    id: stableId("artifact", relative(options.source, path)),
    kind: artifactKindFor(path),
    scope: artifactScopeFor(path),
    title: titleFor(path),
    path,
    role: roleFor(path),
    format: formatFor(path),
    producedByTool: "workspace-bootstrap",
    tags: ["workspace-bootstrap", "source-import"],
  });
  savedArtifacts.set(path, artifact);
}

for (const path of findAnalysisArtifacts(options.source)) {
  const rel = relative(options.source, path);
  const workspacePath = materializeWorkspacePath(path, options.source, options.workspace);
  const artifact = service.saveArtifact({
    id: stableId("artifact", rel),
    kind: artifactKindFor(path),
    scope: artifactScopeFor(path),
    title: titleFor(path),
    path: workspacePath,
    role: roleFor(path),
    format: formatFor(path),
    producedByTool: "workspace-bootstrap",
    tags: extname(path).toLowerCase() === ".md"
      ? ["workspace-bootstrap", "analysis-import", "workspace-doc"]
      : ["workspace-bootstrap", "analysis-import"],
  });
  savedArtifacts.set(path, artifact);

  if (basename(path).toLowerCase().endsWith("_analysis.json")) {
    try {
      service.importAnalysisArtifact(artifact.id);
    } catch (error) {
      console.warn(`Skipping analysis import for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (basename(path).toLowerCase() === "manifest.json" && (artifact.role === "disk-manifest" || artifact.role === "crt-manifest")) {
    try {
      service.importManifestArtifact(artifact.id);
    } catch (error) {
      console.warn(`Skipping manifest import for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

service.createCheckpoint({
  id: stableId("checkpoint", `${options.name}-workspace-bootstrap`),
  title: "Imported existing reverse-engineering workspace",
  summary: `Bootstrap import from ${options.source}`,
  artifactIds: [...savedArtifacts.values()].map((artifact) => artifact.id),
});

const views = service.buildAllViews();

console.log(`Workspace ready: ${options.workspace}`);
console.log(`Project: ${options.name}`);
console.log(`Artifacts: ${savedArtifacts.size}`);
console.log(`Views:`);
console.log(`  dashboard: ${views.projectDashboard.path}`);
console.log(`  memory: ${views.memoryMap.path}`);
console.log(`  disk: ${views.diskLayout.path}`);
console.log(`  cartridge: ${views.cartridgeLayout.path}`);
console.log(`  load-sequence: ${views.loadSequence.path}`);
console.log(`  flow: ${views.flowGraph.path}`);
console.log(`  listing: ${views.annotatedListing.path}`);
