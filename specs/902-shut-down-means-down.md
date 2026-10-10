# Spec 902 — Shutting down means everything is down, and stays down

**Status:** PROPOSED 2026-10-10
**Repo:** C64RE (the ledger, the command, autostart, the platform layer). TRX64:
`../TRX64/docs/_archive/902-daemon-shutdown.md`, DONE on TRX64 main afae8f1 (not released).
`daemon/shutdown` (no params) → `{ok:true, persisted:{cartridge:path|null, disks:[path…]},
trace:<duckdb path|null>, exitCode:0}`, then WS close, then exit 0 within 2 s. SIGTERM/SIGINT,
Windows Ctrl-C/Break/console-close and `--idle-exit` run the same exit work once: stop the run,
finalize a recording trace, persist media. Before it, the daemon handled no signal: a kill lost
unpersisted cartridge/disk writes on every OS.
**Number:** 902 (registry: `specs/README.md`).
**Origin:** owner, 2026-10-10: "fahre das UI und den Dämon runter" leaves remains every time.

---

## §1 What is wrong

There is no command that shuts C64RE down. Shutting down means hunting processes by hand, and
whatever nobody remembers keeps running. Found on 2026-10-10:

- **The selection outlives the bridge.** `~/.c64re/runtime-selection.json` pointed at a C64
  Ultimate for two days after its bridge (pid 32198) had ended. A bridge removes only its own
  registry entry when it ends (`src/runtime/c64u-bridge/cli.ts`); nothing removes the selection.
- **What was stopped comes back.** Four triggers start things again on their own:
  - the MCP server's eager start at launch (`src/cli.ts` → `ensureDaemon`)
  - the lazy start on the first runtime tool call (`src/runtime/daemon-client.ts`)
  - the UI dev server (vite plugin)
  - a C64U bridge restart by any process that has used that device once (`adopted` in
    `src/runtime/backend.ts`)

  The bridge log shows the result: more than a dozen bridges started in a row, each ended
  "asked to by a client" and replaced by the next.
- **Tests leave servers behind.** A workspace UI on :4327 had been running since 2026-10-02 on
  a temporary project whose test (BUG-013) has since been deleted.
- **Nothing knows what is running.** Each process type keeps its own trace (a bridge registry,
  a port, a temp dir), or none. A process started detached (`unref()`) is invisible to whoever
  started it once that caller has ended.

## §2 Decision

**D1 — One ledger of everything C64RE starts.** Every process C64RE starts adds itself to
`~/.c64re/processes/<pid>.json` when it starts and removes itself when it ends. That covers:
- the runtime daemon
- a sandbox daemon
- a C64U bridge
- each process of the workspace UI (launcher, HTTP server, vite)
- a server started by a smoke

Each record holds:
- `pid` and the start time (from the OS, so a reused pid is never mistaken for it)
- `kind`, `port`, `project`
- who started it (`mcp` / `ui` / `cli` / `smoke` / `sandbox`)
- the exact command line

A record whose pid is gone, or whose pid now belongs to a different command, is stale. Whoever
reads it removes it.

**D2 — `c64re down`, and the same as an MCP tool (`runtime_down`).** Both run one library
function:
1. Write the hold (D3) first, so nothing restarts while the shutdown runs.
2. End everything in the ledger: SIGTERM, wait, then SIGKILL after 5 s. The order is UI →
   bridges → sandboxes → daemon. A process is only signalled if its pid, start time and
   command line still match its record. A foreign process on a known port is never killed;
   it is named in the report.
3. Remove `runtime-selection.json`, the bridge registry entries and the stale records.
4. Check: no ledger process alive, and nothing listening on the known ports (4312, the UI
   ports, the ports in the records). The report names each process with its pid, port and
   what happened to it, and lists anything that is still there.

The exit code is non-zero if anything is left.

Options:
- `--project <dir>` ends only that project's processes. The selection stays.
- `--keep <kind>` keeps one kind running, e.g. `--keep daemon` stops only the UI.

**D3 — Down stays down.** `down` writes `~/.c64re/hold.json`. While the hold exists, none of
the four automatic triggers (§1) starts anything. A runtime tool then answers: "C64RE is shut
down (since <time>, by <who>) — `c64re up` or `runtime_session_start` starts it again". Only
an explicit start clears the hold:
- `c64re up`
- `c64re ui`
- `runtime_session_start`
- selecting a C64U in the UI

A sandbox (`runtime_sandbox_run`) is not blocked by the hold: it is born with a budget and ends
itself (DOCTRINE rule 2). It is still in the ledger, so `down` ends it too.

**D4 — Status.** `c64re status`, and a section in `project_status`, list:
- every ledger process: kind, pid, port, project, started by, uptime, idle deadline
- the selection
- the hold

This is how anyone sees what is running without `ps` and `lsof`.

**D5 — Tests clean up after themselves.** The gate gets a final leak step: after all smokes,
the ledger holds no record with `startedBy: "smoke"` and nothing listens on a test port.
A smoke that starts a server ends it in `finally`. The leak step names the smoke that left
something behind and fails the gate.

**D6 — Windows, the same command, the same result.** Everything above runs on Windows
natively and under WSL. There is one platform layer, and nothing outside it asks which OS it
is on:
- **Ending a process.** POSIX: SIGTERM, then SIGKILL. Windows has no SIGTERM — `process.kill`
  there is a hard kill and skips the child's cleanup. So Windows first asks the process to end
  itself through C64RE's own channel: a `daemon/shutdown` request to the daemon and bridges,
  and a shutdown request to the UI server. Only after 5 s does it fall back to
  `taskkill /PID <pid> /T /F`. `/T` takes the process tree with it; that matters because the
  UI launcher's children and npm/npx shims are separate processes there.
- **Identity.** On POSIX, `ps -o lstart=,command=` gives the start time and command line. On
  Windows, `Get-CimInstance Win32_Process` gives `CreationDate` and `CommandLine`, called via
  `powershell.exe -NoProfile`. `wmic` is gone from current Windows. A pid that cannot be read
  is treated as not ours.
- **Ports.** POSIX: `lsof -nP -iTCP -sTCP:LISTEN`. Windows: `Get-NetTCPConnection -State Listen`,
  with `netstat -ano` as the fallback. Each listener is matched to its owning pid.
- **Paths.** `stateDir()` (`%USERPROFILE%\.c64re`, `C64RE_STATE_DIR` overrides) is already
  shared. Records store the command line exactly as the OS reports it, never rebuilt by hand.
- **Spawning.** Every detached start (daemon, bridge) gets `windowsHide: true` so no console
  window opens. It is spawned through the npm shim rules in
  `reference_windows_and_wsl_ci_gotchas` (`npm_execpath`, never `shell: true`), so the
  recorded pid is the real process and not a `cmd.exe` wrapper that dies while the child
  keeps running.
- **WSL.** Inside WSL it is Linux. A daemon on the Windows side is a foreign process from
  there: it is reported, never killed across the boundary.

The Windows CI job runs the §4 acceptance e2e (with a fake bridge target and a stub daemon
when no TRX64 binary is present), and the gate's leak step (D5).

**D7 — Docs.** `docs/runtime-sandbox.md`, the README's start/stop section and the
`project_launchers` text say how to shut down and how to start again. Those texts are
corrected wherever they now say "kill the process".

## §3 Out

- No `down` for the shared session from a script or an agent on its own. `runtime_down`
  is an owner action: the tool says so in its description, and the doctrine line on the
  shared machine applies (the agent co-drives it, it does not end it).
- No other change to the TRX64 daemon than `daemon/shutdown` (D6).
- Processes nobody from C64RE started (a hand-started `trx64-daemon`, another tool on 4312)
  are reported, never killed.

## §4 Acceptance

- Start the UI, let an MCP tool start the daemon, select a C64 Ultimate (or a fake bridge
  target), start a sandbox. `c64re down` ends all of them. The report lists each one. Then:
  `ps` and `lsof` show nothing of C64RE, and `runtime-selection.json` is gone.
- After `down`, a runtime tool call starts nothing and answers with the hold message. So does
  an MCP server restart, and so does opening the UI dev server. `c64re up` starts the daemon
  again and clears the hold.
- A foreign process listening on 4312 survives `down` and is named in the report; the exit
  code is non-zero.
- A ledger record whose pid now belongs to a different command is not signalled; it is
  dropped as stale.
- The gate's leak step fails on a smoke that leaves a server running (checked with a test
  smoke that does exactly that) and passes on the clean gate.
- The same acceptance e2e passes in the Windows CI job: everything ends, nothing stays
  listening, no console window opened, and a hard kill is only used after the 5 s grace.
