// Lightweight artifact-registration helper for the pipeline CLI.
//
// The MCP `save_artifact` tool registers files in `knowledge/artifacts.json`
// when LLMs call analysis pipeline through MCP. When the same pipeline is
// invoked directly via `dist/pipeline/cli.cjs` (e.g. shell loops), no
// registration happens and outputs become invisible to the workspace UI
// and to future `agent_onboard` calls.
//
// This helper closes the gap: every CLI subcommand that writes a file
// calls `registerCliArtifact` after the write. Behaviour:
//
//   - No-op when CWD has no `knowledge/phase-plan.json` (we are not
//     inside a c64re project root).
//   - Skipped when `--no-register` was on the command line.
//   - Reads the existing `knowledge/artifacts.json`, appends a new entry
//     unless the relativePath is already present, writes back atomically.
//   - Uses the same shape that `save_artifact` produces. Any field
//     missing on the input is filled with sensible CLI-side defaults.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface CliArtifactInput {
  kind: string;
  scope: string;
  title: string;
  path: string;
  description?: string;
  format?: string;
  role?: string;
  producedByTool: string;
  sourceArtifactIds?: string[];
  tags?: string[];
}

const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const probe = resolve(dir, "knowledge", "phase-plan.json");
    if (existsSync(probe)) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function makeId(prefix: string, title: string): string {
  return `${prefix}-${slugify(title)}-${Date.now().toString(36)}`;
}

interface ArtifactStore {
  schemaVersion: number;
  updatedAt: string;
  items: Array<Record<string, unknown>>;
}

function loadStore(path: string): ArtifactStore {
  if (!existsSync(path)) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), items: [] };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ArtifactStore;
    if (!data.items) data.items = [];
    return data;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), items: [] };
  }
}

function writeStoreAtomic(path: string, store: ArtifactStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

let registrationDisabled = false;

export function disableRegistrationGlobally(): void {
  registrationDisabled = true;
}

export function isRegistrationDisabled(): boolean {
  return registrationDisabled;
}

export function registerCliArtifact(input: CliArtifactInput): void {
  if (registrationDisabled) return;
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) return; // not inside a c64re project — silent no-op

  const artifactsPath = resolve(projectRoot, "knowledge", "artifacts.json");
  const store = loadStore(artifactsPath);
  const absolutePath = resolve(input.path);
  const relativePath = relative(projectRoot, absolutePath);
  // Skip if already registered (matched by relativePath).
  for (const item of store.items) {
    if (item.relativePath === relativePath) return;
  }

  let fileSize: number | undefined;
  try {
    if (existsSync(absolutePath)) fileSize = statSync(absolutePath).size;
  } catch {
    // ignore
  }

  const timestamp = nowIso();
  const id = makeId("artifact", input.title);
  store.items.push({
    id,
    kind: input.kind,
    scope: input.scope,
    title: input.title,
    path: absolutePath,
    relativePath,
    description: input.description,
    format: input.format,
    role: input.role,
    producedByTool: input.producedByTool,
    sourceArtifactIds: input.sourceArtifactIds ?? [],
    entityIds: [],
    evidence: [],
    status: "active",
    confidence: 1,
    fileSize,
    tags: input.tags ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.updatedAt = timestamp;
  writeStoreAtomic(artifactsPath, store);
}

// Parse `--no-register` flag from argv and return a cleaned argv. Should
// be called by the CLI entry point before subcommand dispatch.
export function consumeRegisterFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "--no-register") {
      disableRegistrationGlobally();
      continue;
    }
    out.push(a);
  }
  return out;
}

// Payload entities are NOT written here.
//
// They used to be appended to `knowledge/entities.json` from this process. That
// file stopped being the store when the knowledge graph took over: every reader
// and writer of an entity goes to `knowledge/graph.sqlite`, and a project that
// still has the JSON file gets it folded in once, on open, and moved aside to
// `knowledge/_legacy-822/`. So this helper re-created a store that the next
// project open swept away again — in one day's work on one project it left 32
// archived copies behind, and each round gave the same payload a fresh id
// because the duplicate check only looked inside the file it had just lost.
//
// The graph door does it properly: through MCP, `analyze_prg` imports the
// analysis artifact right after this process exits, and that importer dedupes a
// payload on (source artifact, load address). A direct `dist/pipeline/cli.cjs`
// run registers the analysis JSON and nothing else; `project_inventory_sync`
// (or `bulk_import_analysis_reports`) is what folds those runs in afterwards.
export function noteCliPayloadNotRegistered(): string {
  return "Payload entities are created when the analysis is imported — run project_inventory_sync after a direct CLI run.";
}
