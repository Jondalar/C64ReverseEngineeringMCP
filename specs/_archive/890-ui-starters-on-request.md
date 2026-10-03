# Spec 890 — UI starters on request, for the system you name

**Status:** DONE (2026-10-03)
**Repo:** C64RE. From issue #34 (Mike, Linux Mint 22).

## §1 What is wrong

`project_init` writes every launcher set into every project, on every platform
(`src/project-knowledge/ui-launcher.ts:13`, `ensureUiLauncher` from `mcp-tools.ts:129`):
`ui.sh`, plus `ui.ps1` and `ui-start|stop|restart.cmd`.

- **Linux:** nothing can be double-clicked. A file manager opens `ui.sh` in an editor, and
  the script needs an argument.
- **Linux and macOS:** only `ui.ps1 start` opens the browser; `ui.sh start` does not.
- **Every system:** files for the other OS clutter the project root, and a re-init brings
  back the ones that were deleted.

The starters are for the human who wants to click. They are not part of the project
scaffold. The owner, 2026-10-03: the LLM is asked "give me the starters for <system>" and
writes them for that system.

## §2 The rule

- **`project_init` writes no starters.** Its answer ends with one line naming the tool
  ("UI starters for double-click: project_launchers"). It does not delete starters that
  already exist in older projects.
- **New tool `project_launchers`** `{ project_dir?, platform?: "linux" | "macos" |
  "windows", refresh?: boolean }`.
  - **`platform`:** omitted means the system the MCP server runs on (`process.platform`).
    Named means another system, for a folder handed to someone else.
  - **Files it writes:**
    - linux: `ui.sh`, plus `ui-start.desktop`, `ui-stop.desktop`, `ui-restart.desktop`;
    - macos: `ui.sh`, plus `ui-start.command`, `ui-stop.command`, `ui-restart.command`;
    - windows: `ui.ps1`, plus the three `.cmd` shims (unchanged).
  - **Existing files:** without `refresh`, only missing files are written (hand edits are
    safe). With `refresh: true`, this platform's files are rewritten, e.g. after the
    project moved, since a `.desktop` file carries an absolute path.
  - **Answer:** what was written, what was kept, and how to start. For Linux it adds that
    the `.desktop` files hold this absolute path and should not be committed.
- **`ui.sh --open`** (start / restart):
  - waits for :4310 and then opens the browser (`open` on macOS, `xdg-open` on Linux);
  - if the workspace exits while waiting, shows the log tail and exits non-zero;
  - gives up after 90 s, naming the log.
  - Without `--open`, nothing opens, so an agent running `./ui.sh start` gets no window.
  - "Already running" returns instead of exiting, so `start --open` on a running UI still
    opens the browser, as Start does on Windows.
- **The double-click starters pass `--open`**, except stop.
  - `.desktop`: `Type=Application`, `Terminal=true`,
    `Exec=bash -c "./ui.sh <action> [--open]; read -rp 'Press Enter to close'"`,
    `Path=<absolute project dir>`, `Icon=utilities-terminal`; `chmod +x`, and mark it
    trusted with `gio set <file> metadata::trusted true` (best effort, a failure is
    ignored).
  - `.command`: `#!/bin/bash`, `cd "$(dirname "$0")"`, `./ui.sh <action> [--open]`;
    `chmod +x`. No absolute path: Finder runs it in Terminal from anywhere.

## §3 Deliverables

1. `ui-launcher.ts`: per-platform generation (`ensureUiLaunchers(projectDir, repoDir,
   { platform, refresh })`), the `.desktop` and `.command` writers, and `--open` in `ui.sh`.
2. `project_launchers` on the default surface (`tier-tools.ts`), with its matrix row, a
   playbook step (onboarding: "the human wants to click → project_launchers"), and the
   regenerated inventory.
3. `project_init` writes none and names the tool.
4. `scripts/write-ui-launchers.mjs` / `npm run launchers` take `--platform` (default: host)
   and `--refresh`.
5. Tests: `smoke:ui-launcher` covers:
   - each platform writes exactly its set;
   - `refresh` rewrites, no-refresh keeps a hand edit;
   - `bash -n` on `ui.sh`; `desktop-file-validate` when installed (skipped by name if not);
   - `.desktop` holds the absolute `Path=`;
   - `ui.sh start --open` with a stubbed `xdg-open`/`open` opens once the port is up;
   - `project_init` writes no starter.
   
   The PowerShell parse check stays where it is, and the gate stays green.
6. Docs: README ("In the project folder itself"), INSTALL.md, `docs/windows-setup.md`.
   They describe asking for the starters, with no spec numbers in user docs.

## §4 Not in this spec

App bundles (.app), Windows .lnk with icons, Linux menu entries in
`~/.local/share/applications`: a double-click in the project folder is what was asked for.

## §5 As built

- `ui-launcher.ts`: `ensureUiLaunchers(projectDir, repoDir, { platform, refresh })`; `.desktop`
  (chmod 0755, best-effort `gio set ... metadata::trusted true` on a Linux host only) and
  `.command` writers; `ui.sh` with `--open`. The Windows files are byte-identical to before.
- `project_launchers` on the default surface (192 default / 298 total tools), matrix row,
  onboarding playbook step, regenerated inventory. It sits behind the onboarding gate like
  any other non-init tool. `project_init` writes no starter and names the tool.
- `npm run launchers -- --platform --refresh`.
- Tests: `smoke:ui-launcher` 105 pass; `e2e-716-package` 42 pass; probe-tool-surface 19,
  probe-mcp-llm-playbooks 12, probe-mcp-tool-usecase-matrix 17; `scripts/gate.sh` 88/88.
  `desktop-file-validate` and `pwsh` are not installed on the build machine: both steps
  print a SKIP line naming the binary.
- Found on the way: `ui.sh` `stop` and `is_up` use `lsof -ti:PORT`, which also lists a client
  connected to the port, so `stop` can kill a process that merely talks to the UI. The smoke
  probes the port from a child process for that reason. Not changed here.
