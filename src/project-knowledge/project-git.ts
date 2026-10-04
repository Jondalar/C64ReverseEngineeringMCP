// A project is in git. `knowledge/` is hand-authored state (contract, findings,
// annotations, steering) and a wrong write over it is only recoverable when history
// exists, so `project_init` and `agent_onboard` check for git and say so.
//
// Every call here runs `git` itself (never a library), with the repository-selecting
// variables of the CALLER's environment removed: a pre-push hook runs with GIT_DIR set,
// and a child that inherits it would see the hook's repository instead of the project's.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The first line of every answer that is about missing history. */
export const GIT_WARNING_LINE = "PLEASE USE GIT TO AVOID LOSS OF DATA!";

const REPO_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPO_ENV) delete env[name];
  return env;
}

interface GitRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** git could not be started at all (not on PATH). */
  missing: boolean;
}

function git(cwd: string, args: string[]): GitRun {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    missing: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ENOENT",
  };
}

/** Is a `git` executable on PATH? */
export function gitAvailable(): boolean {
  return !git(process.cwd(), ["--version"]).missing;
}

/** How to get git, for the three systems this runs on. */
export function gitInstallHint(): string[] {
  return [
    "Install git, then run this tool again:",
    "  Windows: Git for Windows (https://git-scm.com/download/win) or `winget install Git.Git`",
    "  macOS:   `xcode-select --install`, or `brew install git`",
    "  Linux:   your distribution's package, e.g. `apt install git` or `dnf install git`",
  ];
}

/** The refusal text for a tool that cannot continue without git. */
export function noGitRefusal(what: string): string {
  return [
    GIT_WARNING_LINE,
    "",
    `${what} needs git: a project keeps contracts, findings and annotations that took hours to write, and without history one wrong write is the end of them. No \`git\` was found on PATH.`,
    "",
    ...gitInstallHint(),
  ].join("\n");
}

/** The nearest directory at or above `dir` that exists (a project about to be created has none yet). */
function nearestExisting(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** The root of the work tree `dir` lies in, or undefined when it is in none. Needs git. */
export function workTreeRoot(dir: string): string | undefined {
  const r = git(nearestExisting(dir), ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) return undefined;
  const top = r.stdout.trim();
  return top ? top : undefined;
}

/**
 * Regenerable or per-machine outputs. Names are the ones the writers use:
 * the launchers (`project_launchers`: ui.sh / ui.ps1, ui-<action>.desktop|command|cmd —
 * each bakes an absolute path — plus `ui.log` and `.ui.pid`), the derived indexes under
 * `knowledge/.cache/`, the graph's WAL side files, trace stores (`*.duckdb` index and
 * `*.c64retrace` log, gigabytes and rewritten while a trace runs), the lock and temp
 * files of the JSON stores, and the rebuild check's scratch PRG. Media, `knowledge/`,
 * annotations, listings and machine dumps are not listed: they are the project.
 */
export const GITIGNORE_BLOCK_BEGIN = "# >>> c64re (managed block: project_init)";
export const GITIGNORE_BLOCK_END = "# <<< c64re";
export const GITIGNORE_LINES = [
  "# per-machine UI starters (they hold absolute paths) and their log/pid",
  "ui.sh",
  "ui.ps1",
  "ui-*.desktop",
  "ui-*.command",
  "ui-*.cmd",
  "ui.log",
  ".ui.pid",
  "# derived indexes, rebuilt on demand",
  "knowledge/.cache/",
  "# the graph's write-ahead side files",
  "knowledge/graph.sqlite-wal",
  "knowledge/graph.sqlite-shm",
  "# trace stores: large, binary, regenerable",
  "*.duckdb",
  "*.duckdb.wal",
  "*.c64retrace",
  "# store locks and half-written files",
  "*.lock",
  "*.tmp",
  "# the rebuild check's scratch binary",
  "*_disasm_rebuild_check.prg",
  ".DS_Store",
];

/** What `ensureGitignore` did to `<root>/.gitignore`. */
export type GitignoreOutcome = "written" | "updated" | "current" | "left-alone";

/**
 * Write the managed block into `<root>/.gitignore`. An absent file is created; a file
 * that already carries our block has the block refreshed; a file that is somebody
 * else's is left exactly as it is.
 */
export function ensureGitignore(root: string): GitignoreOutcome {
  const path = join(root, ".gitignore");
  const block = [GITIGNORE_BLOCK_BEGIN, ...GITIGNORE_LINES, GITIGNORE_BLOCK_END, ""].join("\n");
  if (!existsSync(path)) {
    writeFileSync(path, block, "utf8");
    return "written";
  }
  const text = readFileSync(path, "utf8");
  const begin = text.indexOf(GITIGNORE_BLOCK_BEGIN);
  const end = text.indexOf(GITIGNORE_BLOCK_END);
  if (begin < 0 || end < begin) return "left-alone";
  const next = text.slice(0, begin) + block + text.slice(end + GITIGNORE_BLOCK_END.length).replace(/^\r?\n/, "");
  if (next === text) return "current";
  writeFileSync(path, next, "utf8");
  return "updated";
}

export interface ScaffoldCommit {
  /** `git init` ran here. */
  initialised: boolean;
  /** The scaffold is committed. */
  committed: boolean;
  /** Why not, when it is not: the exact lines for the human. */
  problem?: string[];
}

const NO_IDENTITY = /please tell me who you are|unable to auto-detect email|empty ident name|author identity unknown|auto-detection is disabled|fatal: unable to auto-detect/i;

/** The two lines that give git an identity. Never run by this server. */
export const IDENTITY_LINES = [
  `git config --global user.name "Your Name"`,
  `git config --global user.email "you@example.com"`,
];

/**
 * `git init` in `root` (it is in no work tree), stage everything the `.gitignore`
 * leaves in, and commit it. A missing identity is not an error of the project: the
 * repository stays, staged, and the answer carries the lines that fix it.
 */
export function initRepositoryAndCommit(root: string, message: string): ScaffoldCommit {
  const init = git(root, ["init"]);
  if (init.status !== 0) {
    return { initialised: false, committed: false, problem: [`git init failed in ${root}: ${init.stderr.trim() || init.stdout.trim()}`] };
  }
  const add = git(root, ["add", "-A"]);
  if (add.status !== 0) {
    return { initialised: true, committed: false, problem: [`git add failed in ${root}: ${add.stderr.trim()}`] };
  }
  const commit = git(root, ["commit", "-m", message]);
  if (commit.status === 0) return { initialised: true, committed: true };
  const err = `${commit.stderr}\n${commit.stdout}`;
  if (NO_IDENTITY.test(err)) {
    return {
      initialised: true,
      committed: false,
      problem: [
        "git has no identity on this machine, so the first commit was not made. The repository is created and the files are staged. Run:",
        ...IDENTITY_LINES.map((l) => `  ${l}`),
        `  git -C "${root}" commit -m "${message}"`,
        "(drop --global to set the identity for this project only)",
      ],
    };
  }
  return { initialised: true, committed: false, problem: [`git commit failed in ${root}: ${err.trim()}`] };
}

/** How many files under `<root>/knowledge/` differ from the last commit (untracked included, ignored not). */
export function uncommittedKnowledgeFiles(root: string): number {
  const r = git(root, ["status", "--porcelain", "-uall", "--", "knowledge"]);
  if (r.status !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

/** The one command line that puts an existing project under git. `;`, not `&&`: Windows PowerShell 5.1 has no `&&`. */
export function gitAdoptCommand(root: string): string {
  return `git -C "${root}" init; git -C "${root}" add -A; git -C "${root}" commit -m "c64re: put the project under git"`;
}
