# VICE Runtime Integration Architecture

## 1. Introduction And Goals

This document describes the planned VICE-based runtime integration for `C64ReverseEngineeringMCP`.

The goal is to extend the existing static reverse engineering workflow with controlled runtime analysis backed by a real VICE emulator instance. The integration must support:

- interactive user-driven runtime tracing with visible VICE UI
- debugger-style analysis with breakpoints, register inspection, stepping, and memory access
- isolation from the user's normal VICE installation and persistent settings
- reuse of the user's preferred VICE controls by copying their configuration as a session baseline
- structured outputs that the LLM can analyze after execution
- individual monitor tools that give the LLM full interactive debugging capabilities

The integration is intended for solo use first. Multi-user or shared-host hardening is explicitly not the first target.

### Quality Goals

The most important quality goals are:

1. Isolation: MCP-controlled VICE sessions must not corrupt or unexpectedly modify the user's normal VICE setup.
2. Controllability: the LLM must be able to start, inspect, debug, and stop VICE sessions deterministically.
3. Usability: the user must still be able to interact with the VICE UI directly, including existing hotkeys and virtual joystick setup.
4. Recoverability: if VICE hangs, the MCP session must still be stoppable and analyzable.
5. Reviewability: trace outputs must be written to files in a form suitable for later LLM analysis and human inspection.

### Stakeholders

| Stakeholder | Need |
|---|---|
| Primary user | Wants visible VICE UI, preserved input workflow, and useful runtime traces |
| LLM agent | Needs a stable tool API, individual monitor commands, and structured artifacts |
| Future maintainer | Needs clear session lifecycle boundaries and low-risk process handling |

## 2. Architecture Constraints

The following constraints apply:

- The solution must integrate into the existing TypeScript MCP server in this repository.
- Existing `analyze_prg`, `disasm_prg`, and media extraction tools must remain separate from runtime execution concerns.
- VICE remains the execution backend; the MCP server is only the orchestration and analysis layer.
- The first implementation should prefer synchronous, session-oriented tool calls over long-running blocked MCP calls.
- The UI must remain visible unless explicitly disabled in a future configuration.
- The user's VICE configuration must be copied into a temporary session workspace and never modified in place. This includes hotkey files (`.vhk`).
- Session-local overlays must force non-persistent behavior such as `SaveResourcesOnExit=0`.
- The VICE binary monitor protocol (binary TCP framing) must be used for all monitor communication. The text-based monitor is not used.
- Only one active session is supported.
- The monitor port is selected at session start: prefer 6510, probe availability, and increment until a free port is found.
- The first target platform is macOS (ARM64, GTK3 build).

## 3. System Scope And Context

### Business Context

`C64ReverseEngineeringMCP` currently supports:

- static PRG analysis
- disassembly and annotation workflows
- CRT extraction
- D64/G64 extraction

The new runtime integration adds a second analysis lane:

- static analysis for deterministic structure discovery
- runtime analysis for execution behavior, depackers, boot paths, state changes, and breakpoint-driven inspection

### Technical Context

Main external actors and systems:

- User: interacts with the VICE UI directly
- MCP client / LLM: calls tools exposed by this server
- `C64ReverseEngineeringMCP`: manages sessions, files, and orchestration
- VICE emulator: executes media and exposes binary monitor control on a session-selected local TCP port
- Local filesystem: stores session configs, logs, traces, and derived analysis artifacts

### Platform Context (macOS First)

The first supported platform is macOS with the following known layout:

- VICE installation: `/Applications/vice-arm64-gtk3-3.10/` (GTK3 ARM64 build)
- Binary path: `x64sc` available in `$PATH` (symlinked or added via shell profile)
- Config directory: `~/.config/vice/`
- Config file: `~/.config/vice/vicerc`
- Hotkey files to copy: `gtk3-hotkeys-C64SC.vhk`, any custom `.vhk` files (e.g. `keys_alex.vhk`)

TODO: The MCP should provide guidance to the LLM on how to locate VICE on the user's system when the binary is not in PATH.

## 4. Solution Strategy

The solution uses a session-based wrapper around VICE.

Core strategic decisions:

1. Introduce a real `ViceSessionManager` instead of stateless one-shot commands.
2. Split interactive tracing from targeted debugging.
3. Treat VICE as an external process with isolated per-session config and artifacts.
4. Copy the user's VICE config (including `.vhk` hotkey files) as the baseline for the session, then apply an MCP-owned overlay.
5. Avoid long-lived blocking MCP calls for interactive sessions. Use start, inspect, stop, and analyze as separate tools.
6. Expose individual monitor commands as separate MCP tools so the LLM can interactively debug (registers, step, next, memory, backtrace, etc.).
7. Keep runtime analysis artifacts as files in the project workspace so they can be inspected and re-used.
8. Prefer a simple first cut that controls one active session at a time.
9. Use the VICE binary monitor protocol (TCP, structured binary framing) for all monitor communication.
10. For the first implementation, media attach and autostart are driven by VICE start arguments. Attaching new media to an already running session is a later enhancement.

## 5. Building Block View

### Level 1

The runtime integration adds these main building blocks:

- `ViceSessionManager`
- `ViceProcessLauncher`
- `VicePortAllocator`
- `ViceConfigWorkspace`
- `ViceMonitorClient`
- `ViceTraceCollector`
- `ViceRuntimeTools`
- `ViceTraceAnalyzer`

### Level 2

#### `ViceConfigWorkspace`

Responsibilities:

- create a per-session directory
- copy the user's VICE configuration into that directory
- copy associated hotkey files (`.vhk`) from the same config directory
- write an MCP overlay config
- ensure no session writes leak back into the original config

Key outputs:

- `vicerc` copy
- copied `.vhk` hotkey files
- generated overlay file
- session metadata

Source config discovery:

- default: `~/.config/vice/vicerc`
- override via environment variable (future)
- copy all `.vhk` files from the same directory

#### `ViceProcessLauncher`

Responsibilities:

- start `x64sc` with explicit config and binary monitor enabled on the session-selected port
- optionally autostart media (PRG, CRT, D64, G64) via CLI args
- retain process handle, PID, start time, and launch command
- capture stdout and stderr safely without deadlocking
- stop VICE gracefully, then force-kill if necessary

#### `VicePortAllocator`

Responsibilities:

- probe whether preferred port 6510 is free
- increment until a free port is found
- return the final selected port to the session startup path
- record the selected port in session metadata

#### `ViceMonitorClient`

Responsibilities:

- connect to the VICE binary monitor on the session-selected TCP port
- implement the binary monitor protocol (request/response framing with command IDs)
- expose typed monitor operations: registers, memory read, breakpoints, step, next, continue, backtrace, bank, snapshot
- maintain connection state independently from process lifetime
- log all commands and responses to the trace collector

#### `ViceSessionManager`

Responsibilities:

- own the single active session state
- mediate between launcher, config workspace, monitor client, and trace collector
- expose session status
- coordinate cleanup

#### `ViceTraceCollector`

Responsibilities:

- collect session events (start, media info, monitor commands/responses, breakpoint hits, stop)
- write structured JSONL event log
- generate summary JSON on session end

Artifact format:

- `trace/events.jsonl` — line-oriented event log with timestamps, command/response pairs
- `trace/summary.json` — session duration, media used, exit reason, breakpoint hits, notable events

Note: a human-readable transcript can be reconstructed from the JSONL if needed; no separate transcript artifact is written.

#### `ViceTraceAnalyzer`

Responsibilities:

- summarize trace artifacts for the LLM
- classify stop reasons
- extract breakpoint hits, PC paths, register snapshots, and notable events

#### `ViceRuntimeTools`

Responsibilities:

- expose MCP tools for session lifecycle, monitor commands, and trace analysis
- provide descriptive tool documentation that teaches the LLM how to use debugging capabilities

### Level 3: Tool Surface

#### Session Lifecycle Tools

- `vice_session_start` — start VICE with session-isolated config; optionally attach and autostart media (PRG/CRT/D64/G64)
- `vice_session_status` — report session state, monitor connection, media loaded
- `vice_session_stop` — graceful shutdown with trace finalization
- `vice_trace_stop_and_analyze` — stop session and return structured trace summary

#### Debug Execution Tools

- `vice_debug_run` — set breakpoints and continue execution; returns on first breakpoint hit, timeout, or exit

#### Monitor Tools (available when CPU is stopped)

- `vice_monitor_registers` — read all CPU registers (PC, A, X, Y, SP, status flags)
- `vice_monitor_backtrace` — show call stack / return address chain
- `vice_monitor_step` — step into next instruction
- `vice_monitor_next` — step over (execute subroutine calls without stopping inside)
- `vice_monitor_memory` — read memory range or search for byte pattern
- `vice_monitor_bank` — show or switch active memory bank (CPU view, RAM, ROM, I/O)
- `vice_monitor_snapshot` — save emulator state snapshot to file
- `vice_monitor_save` — save memory range to file (with load address header)
- `vice_monitor_binary_save` — save memory range to file (raw binary, no header)
- `vice_monitor_continue` — continue execution until next breakpoint

#### Planned Later Tools

- `vice_session_attach_media`
- `vice_session_send_keys`
- `vice_session_set_joystick_mode`

### Level 4: LLM Guidance

A dedicated MCP prompt `debug_workflow` will be provided that teaches the LLM:

- when to use interactive tracing vs targeted debug runs
- how to combine monitor tools into effective debugging sequences
- typical patterns: "set breakpoint → run → inspect registers → read memory → step through code → continue"
- how to interpret register state and memory contents in C64 context
- when to save snapshots for later comparison

## 6. Runtime View

### Scenario 1: Interactive Runtime Trace

1. LLM calls `vice_session_start` (optionally with media path).
2. Server creates session workspace and copies VICE config plus `.vhk` files.
3. Server selects a free monitor port, then launches `x64sc` with UI visible, binary monitor enabled on that port, and session-local config.
4. User interacts with the emulator while VICE runs normally.
5. User closes VICE or asks the LLM to stop the session.
6. LLM calls `vice_trace_stop_and_analyze`.
7. Server finalizes JSONL event log, generates summary JSON, and returns structured summary.

### Scenario 2: Targeted Debug Session

1. LLM calls `vice_session_start` with media to autostart.
2. LLM calls `vice_debug_run` with breakpoint addresses.
3. Server sets breakpoints via binary monitor, continues execution.
4. On breakpoint hit, server returns which breakpoint was hit.
5. LLM calls `vice_monitor_registers` to inspect CPU state.
6. LLM calls `vice_monitor_memory` to read relevant memory ranges.
7. LLM calls `vice_monitor_step` or `vice_monitor_next` to trace through code.
8. LLM calls `vice_monitor_registers` again to see changed state.
9. LLM calls `vice_monitor_continue` to resume execution.
10. LLM calls `vice_session_stop` when analysis is complete.

### Scenario 3: Recovery From Hang

1. Monitor client stops responding or VICE process becomes unusable.
2. Session manager marks the session degraded.
3. `vice_session_stop` first attempts monitor-level shutdown.
4. If that fails, launcher terminates the process and force-kills after timeout.
5. Server preserves available JSONL log and marks the session as abnormal termination.

## 7. Deployment View

The first deployment model is local desktop execution on macOS.

Relevant runtime elements:

- `C64ReverseEngineeringMCP` process
- `x64sc` binary (from PATH or `/Applications/vice-arm64-gtk3-3.10/bin/x64sc`)
- local filesystem session workspace
- one session-selected local TCP port for the VICE binary monitor

Per-session directory example:

```text
analysis/runtime/<timestamp>-<shortid>/
  session.json
  vice/
    vicerc
    overlay.vicerc
    *.vhk
    stdout.log
    stderr.log
  trace/
    events.jsonl
    summary.json
```

## 8. Cross-Cutting Concepts

### Session Ownership

Only one active VICE session is supported. This keeps process control and port management simple. The monitor port is selected at startup by probing from 6510 upward.

### Config Isolation

Session startup copies the user's VICE config into the session workspace. The files copied are:

- `~/.config/vice/vicerc`
- all `.vhk` files from `~/.config/vice/`

The MCP overlay then adds:

- binary monitor enabled on the session-selected port
- session-local logging paths
- `SaveResourcesOnExit=0` to prevent persistence
- optional explicit settings to avoid modal or disruptive behavior

### User Config Reuse

The user's copied config is the baseline so that:

- hotkeys still work (via copied `.vhk` files)
- virtual joystick or keyboard preferences still work
- familiar UI behavior is preserved

This is intentionally a copy, not a live reference.

### Binary Monitor Protocol

All monitor communication uses the VICE binary monitor protocol:

- TCP connection to `localhost:<session-port>`
- Binary framing with request/response IDs for reliable command/response matching
- Typed commands for registers, memory, breakpoints, stepping, etc.
- No text-based monitor fallback

### Trace Artifact Format

- `trace/events.jsonl` — each line is a JSON object with timestamp, event type, and payload (commands sent, responses received, breakpoint hits, state changes)
- `trace/summary.json` — session metadata: duration, media used, exit reason, breakpoint hits, notable events
- `vice/stdout.log` and `vice/stderr.log` — raw process output

A human-readable transcript can be reconstructed from the JSONL events if needed.

### Graceful Shutdown

Shutdown order:

1. try monitor-level quit via binary protocol
2. wait for process exit
3. terminate process
4. kill if still alive
5. finalize JSONL log and generate summary JSON

## 9. Architectural Decisions

### ADR-001: Session-Based Design Instead Of Stateless VICE Tools

Decision: Use session state with explicit lifecycle tools.

Reason: Interactive VICE use spans multiple MCP calls and must survive periods where only the user interacts with the emulator UI.

### ADR-002: Copy User Config Into Session Workspace

Decision: Use the user's VICE config (including `.vhk` hotkey files) as a copied baseline.

Reason: This preserves hotkeys and virtual joystick behavior while keeping the MCP session isolated.

### ADR-003: No Long-Blocking MCP Tool For Manual Tracing

Decision: Split tracing into start and later stop/analyze phases.

Reason: This avoids long blocked calls while the user interacts with the visible VICE UI.

### ADR-004: One Active Session With Probed Monitor Port

Decision: Support only one active session, but probe for a free local monitor port starting at 6510 and increment if occupied.

Reason: The primary user is a single operator, but a hard-coded fixed port would collide unnecessarily with an already running normal VICE instance.

### ADR-005: Keep Existing Static RE Pipeline Separate

Decision: Do not merge runtime tools into `analyze_prg` or `disasm_prg`.

Reason: Runtime execution and static disassembly solve different problems and need different failure models.

### ADR-006: Binary Monitor Protocol

Decision: Use the VICE binary monitor protocol (TCP, binary framing) instead of the text-based monitor.

Reason: The binary protocol is more powerful, more reliable to parse, and more performant. The higher initial implementation effort pays off in capability and robustness.

### ADR-007: Individual Monitor Tools Instead Of Generic Command Passthrough

Decision: Expose each monitor capability as a separate MCP tool (registers, step, next, memory, etc.) instead of a single generic `vice_monitor_command` tool.

Reason: Individual tools each carry their own description, parameter schema, and return type. This allows the LLM to understand exactly what each command does and what it returns, without needing to know the raw monitor syntax.

### ADR-008: JSONL Event Log Without Separate Transcript

Decision: Write a single JSONL event log containing all monitor commands and responses. Do not write a separate human-readable transcript.

Reason: The JSONL is machine-readable and a transcript can be reconstructed from it. Once the system is stable, no human needs to read raw logs.

### ADR-009: Media Attach Via Start Arguments First

Decision: In the first implementation, media is attached or autostarted through VICE process start arguments. Attaching media to an already running session is deferred.

Reason: This keeps the first version operationally simple and reliable. Because the VICE UI remains visible, the user can still intervene manually after startup if needed.

## 10. Quality Requirements

### Reliability

- Session startup must fail fast with actionable error messages if VICE is missing or monitor connection cannot be established.
- Session shutdown must never leave orphaned long-running VICE processes without reporting that fact.

### Usability

- Visible UI must remain controllable by the user.
- The copied config must preserve expected hotkeys and joystick behavior.
- Monitor tool descriptions must teach the LLM effective debugging strategies.

### Performance

- Session startup should complete within a few seconds on a normal local setup.
- Binary monitor commands should return within milliseconds.
- Breakpoint polling should remain lightweight and not flood monitor traffic unnecessarily.

### Maintainability

- VICE process management, binary monitor protocol, config handling, and trace analysis must remain separate modules.

## 11. Risks And Technical Debt

Key risks:

- VICE binary monitor protocol may have undocumented behaviors or version-specific quirks.
- The copied user config may contain paths or settings that behave differently inside a session workspace.
- Some monitor operations may not be safe to issue while the user is simultaneously interacting with the UI.
- Trace volume can grow quickly if instruction-level logging is too verbose.
- Disk and drive-side debugging may need deeper 1541-specific support later.
- Port probing may still race with another local process if allocation and launch are not tightly sequenced.

Known acceptable limitations for the first version:

- one session only
- local macOS only
- startup-time port probing only, no stronger reservation protocol yet
- no full drive CPU trace yet
- no guarantee that every user-specific VICE resource file is discovered automatically

TODO: Add MCP guidance for LLM to discover VICE installation when binary is not in PATH.

## 12. Glossary

| Term | Meaning |
|---|---|
| Session | One isolated VICE process plus associated config, logs, and monitor connection |
| Binary monitor | TCP-based binary protocol for controlling VICE programmatically |
| Monitor client | Binary-monitor protocol client implemented in TypeScript |
| Trace | Runtime artifacts (JSONL events + summary JSON) captured during emulator execution |
| Debug run | Runtime execution with prepared breakpoints and controlled monitor interaction |
| JSONL | Line-delimited JSON format used for event logging |
