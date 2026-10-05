// The host config (`<project>/.mcp.json`, Claude Code's format) is written by C64RE and
// never typed. A hand-copied entry loses its JSON escaping on Windows (`"C:\Users\…"`),
// the file stops parsing, and Claude Code drops the server without a word.
//
// Everything here is JSON.stringify of a value built from data — no template strings —
// so a backslash, a tab or a newline inside a path round-trips byte-exact.

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isPackagedInstall } from "./ui-launcher.js";

export const MCP_SERVER_KEY = "c64-re";
export const MCP_CONFIG_FILE = ".mcp.json";

/**
 * The `C64RE_*` variables the entry carries from the starting environment: the ones that
 * name a tool, a binary or a directory this machine needs to find again.
 *
 * Left out on purpose, and why:
 *  - C64RE_RUNTIME_ENDPOINT, C64RE_RUNTIME_WS, C64RE_RUNTIME_AUTOSTART, C64RE_RUNTIME_IDLE_EXIT,
 *    C64RE_WS_PORT — where one session's daemon lives or whether it may start: transient, and a
 *    stale endpoint would pin the next session to a daemon that is gone.
 *  - C64RE_RUNTIME_BIN_ARGS — daemon arguments (model, video), a per-run choice, not a binary.
 *  - C64RE_FULL_TOOLS, C64RE_ONBOARDING_GATE, C64RE_SLOT_GATE, C64RE_RUNTIME_RATCHET,
 *    C64RE_CUTOVER_*, C64RE_GRAPH_SEED_OWNERS, C64RE_FINGERPRINT_LIBS, C64RE_ANALYZE_GRACE_MS,
 *    C64RE_MAX_LANDING_RUNS, C64RE_COVERAGE_THRESHOLD, C64RE_ORPHAN_RATIO, C64RE_INDEX_*_BYTES —
 *    behaviour switches, gates and tuning knobs, usually set for one experiment or one test.
 *  - C64RE_PROJECT_DIR — not carried from the environment: it is the TARGET project.
 */
export const CARRIED_ENV: readonly string[] = [
  "C64RE_TOOLS_DIR",
  "C64RE_ROOT",
  "C64RE_TRX64_BIN",
  "C64RE_TRX64CLI_BIN",
  "C64RE_RUNTIME_BIN",
  "C64RE_64TASS_BIN",
  "C64RE_KICKASS_JAR",
  "C64RE_EXOMIZER_BIN",
  "C64RE_BYTEBOOZER_BIN",
  "C64RE_PLATFORM_KB",
  "C64RE_TRACE_DIR",
];

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LaunchInput {
  execPath: string;
  /** process.argv: [node, script, ...]. */
  argv: readonly string[];
  execArgv: readonly string[];
  /** The package/checkout root the running code belongs to. */
  repoDir: string;
  /** Overridable for tests; defaults to isPackagedInstall(repoDir). */
  packaged?: boolean;
}

/**
 * How THIS process was started, as a command and args a host can run again.
 *  - an installed package: `npx -y @trex64/c64re`. The package lives in a cache directory that
 *    changes with every version, so no path inside it is written down.
 *  - a checkout run from TypeScript (`tsx src/cli.ts`): node, the loader flags the process was
 *    started with, and the script.
 *  - a checkout run built: node and `dist/cli.js`.
 */
export function describeLaunch(input: LaunchInput): { command: string; args: string[] } {
  const packaged = input.packaged ?? isPackagedInstall(input.repoDir);
  if (packaged) return { command: "npx", args: ["-y", "@trex64/c64re"] };
  const script = input.argv[1];
  if (!script) throw new Error("cannot describe the launch: process.argv has no script");
  let real = script;
  try { real = realpathSync(script); } catch { /* keep as given */ }
  const loader = /\.[cm]?ts$/.test(real) ? [...input.execArgv] : [];
  return { command: input.execPath, args: [...loader, real] };
}

/** The carried variables that are set (and non-empty) in `env`, in CARRIED_ENV order. */
export function collectCarriedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CARRIED_ENV) {
    const v = env[key];
    if (v !== undefined && v.trim() !== "") out[key] = v;
  }
  return out;
}

export function buildServerEntry(input: {
  /** Absolute, already resolved by the caller; written exactly as given. */
  projectDir: string;
  launch: { command: string; args: string[] };
  env: Record<string, string | undefined>;
}): McpServerEntry {
  return {
    command: input.launch.command,
    args: [...input.launch.args],
    env: { C64RE_PROJECT_DIR: input.projectDir, ...collectCarriedEnv(input.env) },
  };
}

export function serialise(config: unknown): string {
  return JSON.stringify(config, null, 2) + "\n";
}

/** A config holding only the c64-re entry. */
export function standaloneConfig(entry: McpServerEntry): string {
  return serialise({ mcpServers: { [MCP_SERVER_KEY]: entry } });
}

export interface ParseFailure {
  message: string;
  /** 1-based; absent when the file parses but its shape is unusable. */
  line?: number;
  column?: number;
}

/** Line and column (1-based) of a character offset. */
export function lineColumn(text: string, position: number): { line: number; column: number } {
  const p = Math.max(0, Math.min(position, text.length));
  let line = 1;
  let last = -1;
  for (let i = 0; i < p; i++) {
    if (text.charCodeAt(i) === 10) { line++; last = i; }
  }
  return { line, column: p - last };
}

function parseFailure(text: string, error: unknown): ParseFailure {
  const message = error instanceof Error ? error.message : String(error);
  const m = /position (\d+)/.exec(message);
  // "Unexpected end of JSON input" names no position: the problem is where the text stops.
  const position = m ? Number(m[1]) : text.length;
  const { line, column } = lineColumn(text, position);
  return { message, line, column };
}

export type MergeResult =
  | { ok: true; text: string; replaced: boolean }
  | { ok: false; failure: ParseFailure };

/**
 * Replace only mcpServers["c64-re"]; every other server and every other key stays.
 * `existing` undefined: a new file.
 */
export function mergeServerEntry(existing: string | undefined, entry: McpServerEntry): MergeResult {
  if (existing === undefined) {
    return { ok: true, text: standaloneConfig(entry), replaced: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return { ok: false, failure: parseFailure(existing, error) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, failure: { message: "the top level is not a JSON object" } };
  }
  const config = parsed as Record<string, unknown>;
  const servers = config.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { ok: false, failure: { message: `"mcpServers" is not a JSON object` } };
  }
  const had = servers !== undefined && Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_KEY);
  config.mcpServers = { ...(servers as Record<string, unknown> | undefined), [MCP_SERVER_KEY]: entry };
  return { ok: true, text: serialise(config), replaced: had };
}

export type WriteOutcome =
  | { kind: "created" | "updated" | "unchanged"; path: string }
  | { kind: "refused"; path: string; failure: ParseFailure };

/** Write (create or merge) `<projectDir>/.mcp.json`. A file that does not parse is never touched. */
export function writeMcpConfig(projectDir: string, entry: McpServerEntry): WriteOutcome {
  const path = join(projectDir, MCP_CONFIG_FILE);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const merged = mergeServerEntry(existing, entry);
  if (!merged.ok) return { kind: "refused", path, failure: merged.failure };
  if (existing === merged.text) return { kind: "unchanged", path };
  writeFileSync(path, merged.text, "utf8");
  return { kind: existing === undefined ? "created" : "updated", path };
}

export function describeFailure(path: string, failure: ParseFailure): string {
  const where = failure.line !== undefined ? ` at line ${failure.line}, column ${failure.column}` : "";
  return `${path} is not usable${where}: ${failure.message}.`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = resolve(p);
    try { r = realpathSync(r); } catch { /* does not exist: compare as written */ }
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A bare command name is looked up on PATH (and PATHEXT on Windows); anything with a separator is a path. */
function commandExists(command: string, env: Record<string, string | undefined>): boolean {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(resolve(command));
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try { if (statSync(join(dir, command + ext)).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

/**
 * What a session that has not started yet would trip over. One line each; a project with
 * no `.mcp.json` yields none. Warnings, never a refusal: the running session already has
 * its server, the file is read by the next one.
 */
export function checkMcpConfig(projectDir: string, env: Record<string, string | undefined> = process.env): string[] {
  const path = join(projectDir, MCP_CONFIG_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const f = parseFailure(text, error);
    return [
      `WARNING ${path} is not valid JSON (line ${f.line}, column ${f.column}: ${f.message}). `
      + `Claude Code drops the c64-re server without an error when it cannot parse this file, so the next session has no c64-re tools. `
      + `Fix it, or delete it and run \`c64re mcp-config --project <dir>\`.`,
    ];
  }
  const servers = parsed && typeof parsed === "object" ? (parsed as { mcpServers?: unknown }).mcpServers : undefined;
  const entry = servers && typeof servers === "object" ? (servers as Record<string, unknown>)[MCP_SERVER_KEY] : undefined;
  if (!entry || typeof entry !== "object") {
    return [`WARNING ${path} has no "${MCP_SERVER_KEY}" server: the next session has no c64-re tools. Run \`c64re mcp-config --project ${projectDir}\`.`];
  }
  const e = entry as { command?: unknown; args?: unknown; env?: unknown };
  const lines: string[] = [];
  const entryEnv = e.env && typeof e.env === "object" ? e.env as Record<string, unknown> : {};

  const configured = entryEnv.C64RE_PROJECT_DIR;
  if (typeof configured !== "string" || !samePath(configured, projectDir)) {
    lines.push(`WARNING ${path}: C64RE_PROJECT_DIR is ${typeof configured === "string" ? `"${configured}"` : "not set"}, not this project (${projectDir}). The next session works on the wrong project.`);
  }
  if (typeof e.command !== "string" || !commandExists(e.command, env)) {
    lines.push(`WARNING ${path}: command ${JSON.stringify(e.command)} does not exist on this machine, so the server will not start.`);
  }
  // The script a node-style entry runs is as much "the command" as the command itself.
  const script = Array.isArray(e.args) ? [...e.args].reverse().find((a) => typeof a === "string" && isAbsolute(a)) : undefined;
  if (typeof script === "string" && !existsSync(script)) {
    lines.push(`WARNING ${path}: the server script ${script} does not exist on this machine, so the server will not start.`);
  }
  for (const key of CARRIED_ENV) {
    const v = entryEnv[key];
    if (typeof v === "string" && v !== "" && !existsSync(resolve(v))) {
      lines.push(`WARNING ${path}: ${key} = ${v} does not exist on this machine.`);
    }
  }
  return lines;
}

/** `checkMcpConfig` for a status line: a check that itself fails says nothing. */
export function mcpConfigWarnings(projectDir: string): string[] {
  try { return checkMcpConfig(projectDir); } catch { return []; }
}
