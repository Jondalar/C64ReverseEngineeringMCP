# C64RE on Windows — setup

For a Windows box and the Claude Code session that runs on it. Ten minutes.
Paths below use forward slashes: they work on Windows and they survive JSON.

## 1. Install

| | |
|---|---|
| **Node.js 22 or newer** | required — C64RE uses `node:sqlite`, which older Node does not have |
| **Git** | required — to clone and update, and because every project lives in a git repository: `project_init` and `agent_onboard` refuse to run without it |
| TRX64 daemon (`trx64-daemon.exe`) | optional — needed only for the live runtime, tracing and screenshots. Static reverse engineering works without it |
| Java + `KickAss.jar` | optional — needed only to rebuild a disassembly byte-for-byte |

Check: `node --version` must print v22 or higher.

## 2. Get C64RE and build it

```powershell
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm install
npm run build
```

Repeat `git pull; npm run build` after every update.

## 3. Point Claude at a reverse-engineering project

A *project* is a folder for one game: the disk images go in, the analysis comes
out. It is not this repo. Create it, then let C64RE write the `.mcp.json` in it — do not
hand-edit paths:

```
node C:/path/to/C64ReverseEngineeringMCP/dist/cli.js mcp-config --project C:/path/to/your/project
```

(`project_init` writes the same file into a new project.) A single `\` in a JSON string makes
Claude Code drop the server silently, with no error: use `/` or `\\` if you ever type a path.
The file it writes looks like this:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/path/to/C64ReverseEngineeringMCP/dist/cli.js"],
      "env": { "C64RE_PROJECT_DIR": "C:/path/to/your/project" }
    }
  }
}
```

What C64RE writes has the Windows backslashes escaped as `\\` instead; both spellings are valid JSON for the same path. Every path absolute.

Start Claude Code **in the project
folder** and say: *initialise this project with C64RE*. The `project_init` tool
writes the knowledge scaffold, runs `git init` in the folder (unless it already sits
inside a repository), writes a `.gitignore` and commits the scaffold. The project keeps
contracts and findings that took hours to write; git history is what brings one back
after a wrong write. If git reports that it does not know who you are, run
`git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`
and commit again. Then say: *give me the UI starters for Windows*
(the `project_launchers` tool), which writes `ui.ps1` and the three `.cmd` files
into the folder.

Optional, only if you want byte-verification:
`setx C64RE_KICKASS_JAR "C:\path\to\KickAss.jar"`, then open a new window.

## 4. Run the workbench

In the project folder, once you have the starters (step 3), double-click:

| | |
|---|---|
| **ui-start.cmd** | builds the backend, starts it, waits for the port, opens the browser at `http://localhost:4310` |
| **ui-stop.cmd** | stops it (`c64re down`: the UI, the bridges, the sandboxes and the runtime) |
| **ui-restart.cmd** | stop + start, picks up code changes |

The window closes by itself when it worked, and stays open when it did not.
`ui.log` in the same folder has the detail. From a shell you also get
`status`, `logs` and `build-ui`:

```powershell
powershell -ExecutionPolicy Bypass -File .\ui.ps1 status
```

If the project folder came from another machine, tell it where the repo is —
once:

```powershell
setx C64RE_REPO "C:\path\to\C64ReverseEngineeringMCP"
```

## 5. Model router (worth it on a smaller plan)

Lets a Sonnet session reach Opus for the few hard calls and Haiku for the bulk,
without switching the session model. From the repo:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills","$env:USERPROFILE\.claude\agents"
Copy-Item -Recurse -Force contrib\claude\skills\deep,contrib\claude\skills\cheap,contrib\claude\skills\model-router "$env:USERPROFILE\.claude\skills\"
Copy-Item -Force contrib\claude\agents\reasoner.md,contrib\claude\agents\bulk.md "$env:USERPROFILE\.claude\agents\"
```

Then `/deep <hard question>` runs one turn on Opus, `/cheap <mechanical task>`
one turn on Haiku, and `/model-router` explains when to use which — including
the paste-ready block for `%USERPROFILE%\.claude\CLAUDE.md` that makes Claude
apply the rules on its own. If your plan has no Opus, `/deep` silently stays on
your session model; `/model` shows what you actually have.

## When something breaks

- **`node` is not recognised** — Node is not on PATH. Reinstall it with the
  "Add to PATH" option, then open a new window.
- **The browser opens on an error page** — the backend is still starting, or it
  failed. Read `ui.log` in the project folder.
- **A double-clicked `.ps1` opens Notepad** — use the `.cmd` files, that is what
  they are for.
- **`ui-start.cmd` says the repo was not found** — set `C64RE_REPO` as in step 4.
- **The Live tab stays empty** — that is the TRX64 daemon, which is optional and
  separate. Everything else works without it.
