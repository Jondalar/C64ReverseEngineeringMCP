# Spec 895 — The host config is written by C64RE, never typed

**Status:** PROPOSED (2026-10-05)
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
