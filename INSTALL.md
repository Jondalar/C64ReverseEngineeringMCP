# Installing C64RE

C64RE is an MCP server. Your harness — Claude Code, Codex, anything that speaks MCP —
starts it, and it gives that session the tools to take a C64 program apart.

**The install has three parts, and the third one is yours.**

1. **C64RE** — this package. One command.
2. **The runtime** — TRX64, a separate daemon process. One command, and C64RE can fetch it
   for you.
3. **ROMs** — the C64 and 1541 ROM images. They are Commodore's property. They are in no
   package, they never will be, and you supply your own.

Nothing here needs Emscripten, a Rust toolchain, or a C++ compiler. Those are for people
rebuilding the runtime from source, which is the last option on the list and not the
expected one.

---

## 1. C64RE

### Prerequisites

**Node 22 LTS or newer.** The hard requirement is not the version number — it is the
built-in `node:sqlite` module, which carries the knowledge graph and the platform
reference. C64RE checks for it at startup and says so plainly if your Node is too old,
rather than failing somewhere deep in a query.

Git is needed only for the source-checkout route below.

### From the registry

```bash
npx -y @c64re/mcp --help
```

That is the whole install: `npx` fetches it on first use and your harness runs the same
command. Nothing is written outside npm's own cache.

### From a source checkout

For contributing, for working on the workbench UI, or for running an unreleased change:

```bash
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm ci
npm run build
```

`npm ci`, not `npm install` — it installs exactly the lockfile. Use `npm install` only when
you mean to change a dependency.

The build writes `dist/`: the MCP server as ES modules, and the analysis pipeline as
CommonJS beside it in `dist/pipeline/`. To update a checkout later, `git pull && npm ci &&
npm run build`. Your RE projects live in their own directories and are never touched by
this.

## 2. The runtime

C64RE analyses bytes on its own. To *run* them — to step code, watch a loader, read live
memory — it needs TRX64, which is a separate process.

```bash
npx c64re-mcp runtime install
```

This downloads the TRX64 release C64RE is pinned to for your platform, verifies the
checksum published alongside it, and unpacks it into a per-version cache directory. It
installs nothing into your system and touches no daemon you already have. Inside a session
the `runtime_install` tool does the same thing.

The version is pinned rather than "latest" on purpose: client and daemon must agree on the
wire protocol exactly, and a newer daemon is a setup error rather than a lucky guess.

Already have one? Point C64RE at it instead and skip the download:

| | |
|---|---|
| `C64RE_TRX64_BIN` | absolute path to a `trx64-daemon` binary, which C64RE starts itself |
| `C64RE_RUNTIME_ENDPOINT` | `ws://host:4312` for a daemon that is already running |

Without either, C64RE looks in this order: those two variables, a sibling `../TRX64`
release build, its own cache, then `trx64-daemon` on your `PATH`. A `brew install trx64` is
therefore found without configuration.

Building it from source stays supported and needs the Rust toolchain and a C++ compiler:

```bash
cd ../TRX64 && cargo build --release -p trx64-daemon
```

**Platforms with a prebuilt runtime:** macOS (Apple Silicon and Intel), Linux (x86-64 and
arm64), Windows (x86-64 and arm64). Anything else builds from source.

## 3. ROMs

The daemon needs C64 and 1541 ROM images to boot a machine. They are not distributed here.
Dump them from your own machine or obtain them by whatever route is lawful where you are,
put them in a `resources/roms/` directory, and point C64RE at its parent:

```bash
export C64RE_ROOT=/path/to/that/parent
```

The daemon also looks beside its own executable, so a `roms/` directory next to
`trx64-daemon` works without any variable at all.

---

## Configuring your harness

`C64RE_PROJECT_DIR` is the only variable C64RE requires: the directory holding the program
you are reverse-engineering, together with everything C64RE learns about it. Create it,
point at it, and run `project_init` once in your first session.

### Claude Code

`.mcp.json` at your RE-project root:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["-y", "@c64re/mcp"],
      "env": { "C64RE_PROJECT_DIR": "/path/to/your/re-project" }
    }
  }
}
```

From a checkout, replace the command with `node` and the args with the absolute path to
`dist/cli.js`. Running the built server is the supported shape; the TypeScript dev loader
is for working on C64RE itself.

### Codex

```toml
[mcp_servers.c64re]
command = "npx"
args = ["-y", "@c64re/mcp"]
env = { C64RE_PROJECT_DIR = "/path/to/your/re-project" }
```

### Windows, PowerShell

Paths are the only real difference. Quote anything containing a space, and give the
absolute path with its drive letter:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["-y", "@c64re/mcp"],
      "env": { "C64RE_PROJECT_DIR": "C:\\Users\\you\\re-projects\\thegame" }
    }
  }
}
```

In `.json` a backslash is an escape character, so Windows paths are written `\\`. Setting a
variable for one shell session is `$env:C64RE_PROJECT_DIR = "C:\Users\you\..."` — the
`export` form in the examples above is for POSIX shells.

### Windows with WSL2

Install Node **inside** the WSL distribution and keep the repository and your RE projects
on the Linux filesystem (`/home/you/...`), not under `/mnt/c`. Crossing the boundary costs
a great deal on file-heavy work, and a disassembly listing is file-heavy work. Then every
command and path in this document is the Linux one; the harness must also be running inside
WSL, because a Windows-side harness cannot start a Linux-side process.

### Container

The MCP server speaks over stdin and stdout, so a container must keep them attached:

```bash
docker run --rm -i \
  -v /path/to/your/re-project:/project \
  -e C64RE_PROJECT_DIR=/project \
  <image> npx -y @c64re/mcp
```

`-i` is not optional — without it the protocol has no channel. Mount the project; never
bake it into an image. For the runtime, the TRX64 repository carries its own container
recipe under `docker/`, which mounts ROMs as a volume for the same reason they are not in
any package.

## The workbench UI

Optional, and a second step. From a source checkout:

```bash
npm run ui:build     # once
npm run ui:serve     # serves the workbench
```

It opens on a local port and shows the project the MCP server is working in. It is not
required for any RE work and it is not part of the published package.

## Versions

C64RE is pre-1.0 and versioned accordingly:

- **Minor** versions may break things. MCP tool schemas can change, a project written by an
  older version may need a migration, and the workbench may move.
- **Patch** versions do not intentionally change MCP tool schemas, `.c64re` snapshot
  compatibility, or how the server is invoked.

`package.json` carries the one authoritative version, and a release is tagged `v<version>`.
The TRX64 release C64RE is pinned to moves with it: client and daemon must agree on the
wire protocol exactly, so upgrading C64RE may mean `runtime install` fetches a newer daemon.

## When it does not work

**"needs a Node with the built-in SQLite module"** — your Node is older than the 22 LTS
line. Install a newer one and make sure your harness starts C64RE with *that* Node; a
harness launched from a desktop icon often has a different `PATH` than your shell.

**The harness cannot find `npx` or `node`** — same cause. Give the absolute path to the
executable in the MCP configuration rather than relying on the harness inheriting your
shell's environment.

**"c64re requires a valid project directory"** — `C64RE_PROJECT_DIR` is unset, points
somewhere that does not exist, or points at a directory where `project_init` has never run.
Run `project_init` once; it creates the scaffold and takes in whatever is already lying
there.

**A runtime tool says there is no daemon** — run `npx c64re-mcp runtime install`, or set
`C64RE_TRX64_BIN` / `C64RE_RUNTIME_ENDPOINT`. There is no in-process fallback and there
never will be: the runtime is always a separate process, so this is a setup step rather
than an edge case.

**The daemon starts but nothing boots** — ROMs. See part 3.

**`runtime install` says there is no build for your platform** — you are on something
outside the six prebuilt targets. Build the daemon from source and point `C64RE_TRX64_BIN`
at it.

**Nothing at all happens, and the harness reports a disconnect** — something wrote to
stdout. That channel belongs to the MCP protocol alone. If you are working on C64RE, use
`console.error`; the server reroutes stray `console.log` for exactly this reason, but a
child process writing directly to stdout can still break the frame.
