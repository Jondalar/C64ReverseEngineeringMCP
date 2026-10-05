# Spec 895 — The host config is written by C64RE, never typed

**Status:** DONE (2026-10-05)
**Repo:** C64RE. From issue #36 (Mike, Windows 11).

## §1 What went wrong

An agent in one project wrote `.mcp.json` for a new project by copying its own server
entry by hand. The Windows paths lost their JSON escaping (`"C:\Users\…"`), the file was
invalid JSON, and Claude Code dropped the `c64-re` server without a word. The next session
had no c64-re tools. `\t` or `\n` in a path would even have parsed and silently changed the
path.

Nothing in C64RE writes `.mcp.json`, and nothing checks one. A file whose only author is a
model copying text will break again.

## §2 The rule

- **C64RE writes the server entry itself, serialised with `JSON.stringify`.** Never a
  template string.
- **What it writes is the running server's own launch**, so a copy from a working session
  is exact:
  - command and args: how this process was started (`process.execPath` + the script, or
    the `tsx` shim + `src/cli.ts` for a checkout, or `npx -y @trex64/c64re` for a package
    install — read how `cli.ts`/the setup docs describe each install shape and reproduce
    the one in use; do not guess from names);
  - env: `C64RE_PROJECT_DIR` = the TARGET project (absolute), plus the `C64RE_*` variables
    this server was started with that name tools or binaries (`C64RE_TOOLS_DIR`,
    `C64RE_TRX64_BIN`, `C64RE_64TASS_BIN`, `C64RE_KICKASS_JAR`, …). Not the session's
    transient ones (runtime endpoint overrides, test switches) — list them explicitly.
- **Merge, never clobber.** An existing `.mcp.json` that parses: only `mcpServers["c64-re"]`
  is replaced, every other server and key kept. One that does not parse: refuse, show the
  parse error with line and column, and write nothing — the human fixes or deletes it.

## §3 Doors

1. **`project_init` writes `.mcp.json`** into the new project when there is none, and says
   so. When one exists it leaves it alone and checks it (§4). The file holds absolute,
   per-machine paths, so the `.gitignore` block `project_init` writes gains `.mcp.json`.
2. **CLI `c64re mcp-config [--project <dir>] [--print]`**: the same writer for a project
   that already exists, run from a checkout or the package. `--print` writes nothing and
   prints the JSON. Without a running MCP there is no "running server" to copy: the CLI
   describes its OWN launch (the same rule, applied to the CLI process) and the env from
   its own environment.
3. **Check:** `project_status` and `agent_onboard` parse `<project>/.mcp.json` when present
   and report, in one line each:
   - invalid JSON, with line and column, and that Claude Code drops the server without an
     error in that case;
   - a `c64-re` entry whose `C64RE_PROJECT_DIR` is not this project;
   - a command or a path-valued `C64RE_*` value that does not exist on this machine.
   Not a refusal: the session is already running, the warning is for the next one.

## §4 Docs

- `INSTALL.md` and `docs/windows-setup.md`: "let C64RE write `.mcp.json`
  (`c64re mcp-config`), do not hand-edit paths; a single `\` in a JSON string makes Claude
  Code drop the server silently — use `/` or `\\`". No spec numbers.
- The agent doctrine: never write `.mcp.json` by hand; `project_init` or `c64re mcp-config`.

## §5 Tests

A smoke wired into gates.yml, temp dirs only:
- `project_init` in a fresh dir writes a `.mcp.json` that parses, names the project
  absolutely and reproduces this server's command/args;
- a Windows-style path with backslashes, `\t` and `\n` in it round-trips byte-exact through
  the writer (unit level: build the entry from an injected path and env, `JSON.parse` it
  back);
- merge keeps another server and unknown keys; an unparsable file is refused, untouched,
  and the error names line and column;
- `c64re mcp-config --print` prints valid JSON and writes nothing;
- the check reports a broken file, a foreign `C64RE_PROJECT_DIR` and a missing command.

## §6 Not in this spec

Other hosts' config formats (Codex, Cursor). Claude Code's `.mcp.json` only.

## §7 As built

Branch `spec-895`. Writer, merge and check: `src/project-knowledge/mcp-config.ts`; CLI
`src/mcp-config-cli.ts` (dispatched from `src/cli.ts`, `argv[0] === "mcp-config"`); smoke
`scripts/smoke-895-mcp-config.mjs` (`npm run smoke:895`, 39 checks, wired into gates.yml).

**Doors.** `project_init` writes `.mcp.json` when absent (after the git step, so a foreign
`.gitignore` does not let a machine's absolute paths into the first commit), says so in a
`Host config:` line, and with an existing file leaves it byte-identical and prints the check.
`GITIGNORE_LINES` gained `.mcp.json`. `c64re mcp-config [--project <dir>] [--print]`; default
project is the current directory (like `c64re setup`). `project_status` and `agent_onboard`
append the check's `WARNING` lines (one per problem); tool descriptions of the three tools were
extended and the tool-surface inventory regenerated (matrix and playbooks came out unchanged).

**Launch rule** (`describeLaunch`, from `process.execPath`, `process.argv[1]`, `process.execArgv`):
a packaged install (`isPackagedInstall`, now exported from `ui-launcher.ts`) is `npx -y
@trex64/c64re` with no path baked in; a checkout is `process.execPath` plus the realpath of the
script, and when the script is TypeScript the process's own `execArgv` (the tsx loader flags) go
in front, so a `tsx src/cli.ts` session is reproduced as started. A built checkout is `node
<abs>/dist/cli.js`.

**Carried env** (`CARRIED_ENV`), only when set and non-empty: `C64RE_TOOLS_DIR`, `C64RE_ROOT`,
`C64RE_TRX64_BIN`, `C64RE_TRX64CLI_BIN`, `C64RE_RUNTIME_BIN`, `C64RE_64TASS_BIN`,
`C64RE_KICKASS_JAR`, `C64RE_EXOMIZER_BIN`, `C64RE_BYTEBOOZER_BIN`, `C64RE_PLATFORM_KB`,
`C64RE_TRACE_DIR` — each is read by the code as a tool, binary or directory location that the
next session needs to find again. `C64RE_PROJECT_DIR` is always the target. Not carried:
`C64RE_RUNTIME_ENDPOINT` / `_WS` / `_AUTOSTART` / `_IDLE_EXIT` / `C64RE_WS_PORT` (where one
session's daemon lives, or whether it may start — a stale endpoint pins the next session to a
dead daemon), `C64RE_RUNTIME_BIN_ARGS` (per-run daemon arguments, not a binary),
`C64RE_FULL_TOOLS` (a surface switch), and the gates and tuning knobs (`C64RE_ONBOARDING_GATE`,
`_SLOT_GATE`, `_RUNTIME_RATCHET`, `_CUTOVER_*`, `_GRAPH_SEED_OWNERS`, `_FINGERPRINT_LIBS`,
`_ANALYZE_GRACE_MS`, `_MAX_LANDING_RUNS`, `_COVERAGE_THRESHOLD`, `_ORPHAN_RATIO`, `_INDEX_*_BYTES`).

**Merge.** Only `mcpServers["c64-re"]` is replaced, in place; the file is re-serialised with
`JSON.stringify` (2 spaces, trailing newline), so a hand-formatted file is reformatted though
no key or value is lost. Refused, nothing written: a file that does not parse (line and column
from the `JSON.parse` error position; a truncated file reports where the text ends), and a file
that parses but whose top level or `mcpServers` is not an object.

**Check** (`checkMcpConfig`): invalid JSON (line, column, and that Claude Code drops the server
without an error); no `c64-re` entry; `C64RE_PROJECT_DIR` not this project (compared by real
path, case-insensitive on Windows/macOS); command not on PATH/PATHEXT or not a file; carried
path-valued variables that do not exist.

**Deviations / additions.**
- The check also reports a missing server SCRIPT (the last absolute path in `args`), and a
  missing `c64-re` entry — a missing script is the same silent failure as a missing command,
  and an entry-less file is the same "no c64-re tools next session".
- `--print` prints the standalone `{ "mcpServers": { "c64-re": … } }`, not a merge with an
  existing file.
- A UTF-8 BOM makes the file unparsable for `JSON.parse`, so it is refused as invalid at line 1,
  column 1; not special-cased.
- The first-ever `.mcp.json` of a project cannot come from `project_init` unless a c64-re
  server is already configured somewhere else; the docs therefore lead with `c64re mcp-config`.

**Docs.** `INSTALL.md` (Claude Code), `docs/windows-setup.md` §3 (its example now shows the
`node …/dist/cli.js` shape the writer produces), `docs/agent-doctrine.md` §2 (never write
`.mcp.json` by hand). No spec numbers in the user docs.

**Not done.** `specs/README.md` row and `**Status:**` line, archiving (the merge step).
Other hosts' formats stay out (§6). `smoke-893` check 4b fails in a worktree nested under the
main checkout (the main checkout's root is itself a project); unrelated to this spec.
