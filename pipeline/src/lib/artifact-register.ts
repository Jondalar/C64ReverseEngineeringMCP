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
//     unless the relativePath is already present, writes back atomically —
//     all three under the cross-process lock in `json-store-lock.ts`, because
//     the MCP server writes the same file from its own process.
//   - Uses the same shape that `save_artifact` produces. Any field
//     missing on the input is filled with sensible CLI-side defaults.
//   - Never throws. A store that will not take the row is reported on stderr,
//     loudly, because the file the row was about is already on disk.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { withJsonStoreLock, writeJsonStoreAtomic } from "./json-store-lock";

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

/**
 * The same file, reached two ways, has to produce the same row.
 *
 * `process.cwd()` hands back a canonical path and an argument does not, so on a
 * machine where the project sits under a symlinked directory (`/tmp` on macOS
 * is one) the root was canonical and the artifact path was not. `relative()`
 * then walked out of the project to get back in, every row read
 * `../../../tmp/<project>/…`, and the "already registered?" check keyed on that
 * string never matched anything a differently-spelled call had written.
 */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
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

function writeStore(path: string, store: ArtifactStore): void {
  writeJsonStoreAtomic(path, `${JSON.stringify(store, null, 2)}\n`);
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
  const absolutePath = canonical(resolve(input.path));
  const relativePath = relative(canonical(projectRoot), absolutePath);

  try {
    // Load, check and write inside ONE lock. Splitting them is what turns two
    // parallel pipeline children into one lost registration: both read a store
    // without the other's row, both write their own version back, and the row
    // that was written first is gone with nothing to show for it.
    withJsonStoreLock(artifactsPath, () => {
      const store = loadStore(artifactsPath);
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
      writeStore(artifactsPath, store);
    });
  } catch (error) {
    // The file this call was about IS on disk — the subcommand wrote it before
    // asking for it to be registered — so the run did not fail and must not
    // report that it did. What did fail is the bookkeeping, and that is the one
    // thing nobody notices: the old code let the ENOENT escape as a raw node
    // stack out of `main`, and on the MCP side the same failure arrived as a
    // quiet line at the end of a message that began "rebuild verified
    // byte-identical". Say it plainly instead, on stderr, with the way out.
    reportRegistrationFailure(relativePath, error);
  }
}

/** Not a warning in passing: the artifact exists and the project does not know it. */
function reportRegistrationFailure(relativePath: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `\n[c64re] ARTIFACT NOT REGISTERED — knowledge/artifacts.json could not be written: ${reason}\n`
    + `[c64re] ${relativePath} is on disk, and nothing in the project knows it is: it will not\n`
    + `[c64re] appear in list_artifacts, in any view, or to the next session that onboards.\n`
    + `[c64re] Run project_inventory_sync to register what is on disk.\n`,
  );
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
