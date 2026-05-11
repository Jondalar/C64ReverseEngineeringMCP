# VICE Runtime Integration Implementation Plan

## Objective

Implement a first usable VICE runtime integration for `C64ReverseEngineeringMCP` that:

- keeps the VICE UI visible
- uses a copied version of the user's VICE config (including `.vhk` hotkey files) as the session baseline
- supports interactive tracing
- supports targeted breakpoint-driven debug runs with individual monitor tools
- exposes full interactive debugging capabilities (registers, step, next, memory, backtrace, bank, snapshot)
- writes JSONL trace artifacts that the LLM can analyze afterwards
- uses the VICE binary monitor protocol for all monitor communication

## Scope For First Delivery

In scope:

- single active VICE session
- local macOS desktop use (ARM64 GTK3 VICE build)
- copied `vicerc` baseline plus all `.vhk` hotkey files plus MCP overlay
- session-local process management
- visible UI
- optional media attach/autostart on session start (PRG, CRT, D64, G64) via start arguments
- interactive trace start and stop/analyze flow
- targeted debug run with breakpoints
- individual monitor tools: registers, backtrace, step, next, memory, bank, snapshot, continue
- LLM guidance prompt for debugging strategies

Out of scope:

- multiple concurrent sessions
- remote VICE instances
- full drive CPU tracing
- text-based monitor protocol
- polished replay or timeline visualization

## Resolved Design Decisions

These questions from the original plan have been answered:

1. **One active session** — yes, sufficient for first cut.
2. **Config copy scope** — copy `vicerc` plus all `.vhk` files from `~/.config/vice/` from day one.
3. **Media attach** — first implementation uses `vice_session_start` with start arguments for attach/autostart. Attach-to-running-session support is deferred.
4. **Debug interaction model** — `vice_debug_run` stops on first breakpoint hit. Then the LLM uses individual monitor tools (`vice_monitor_registers`, `vice_monitor_step`, etc.) to inspect and step through code interactively.
5. **Artifact format** — JSONL event log plus summary JSON. No separate transcript file; transcript can be reconstructed from JSONL.
6. **Monitor protocol** — binary monitor protocol (TCP, binary framing). No text-based fallback.
7. **Monitor port** — prefer 6510, probe availability at startup, increment until free.

## Target Tool Set

### Session Lifecycle Tools

- `vice_session_start` — start VICE with isolated config; optional `media_path` + `media_type` for autostart
- `vice_session_status` — report session state, monitor connection, media loaded
- `vice_session_stop` — graceful shutdown with trace finalization
- `vice_trace_stop_and_analyze` — stop session and return structured trace summary

### Debug Execution Tools

- `vice_debug_run` — set breakpoints and continue execution; returns on first hit, timeout, or exit

### Monitor Tools (available when CPU is stopped)

- `vice_monitor_registers` — read all CPU registers (PC, A, X, Y, SP, status flags)
- `vice_monitor_backtrace` — show call stack / return address chain
- `vice_monitor_step` — step into next instruction
- `vice_monitor_next` — step over (execute subroutine calls without stopping inside)
- `vice_monitor_memory` — read memory range or search for byte pattern
- `vice_monitor_bank` — show or switch active memory bank (CPU, RAM, ROM, I/O)
- `vice_monitor_snapshot` — save emulator state snapshot to file
- `vice_monitor_continue` — continue execution until next breakpoint

### LLM Guidance

- `debug_workflow` prompt — teaches the LLM how to combine monitor tools into effective debugging sequences

### Planned Later Tools

- `vice_session_send_keys`
- `vice_session_set_joystick_mode`
- `vice_session_attach_media`

## Proposed Module Layout

New modules under `src/runtime/vice/`:

- `types.ts` — session state, stop reason, media type, trace event types, monitor command/response types
- `config-workspace.ts` — copy user config + `.vhk` files, write overlay
- `process-launcher.ts` — start/stop `x64sc`, capture stdout/stderr
- `monitor-client.ts` — binary monitor protocol client (TCP, binary framing, request/response matching)
- `session-manager.ts` — single-session lifecycle, mediates all components
- `trace-collector.ts` — JSONL event writer, summary generator
- `trace-analyzer.ts` — summarize trace for LLM consumption

Server integration:

- `src/server.ts` — register all new tools and the `debug_workflow` prompt

Documentation:

- `docs/vice-runtime-arc42.md`
- `docs/vice-runtime-implementation-plan.md`

## Phase Plan

### Phase 0: Design Freeze

Deliverables:

- reviewed architecture document
- reviewed implementation plan
- confirmed design decisions (see Resolved Design Decisions above)

Acceptance criteria:

- agreement on session model (single session, startup-time port probing from 6510)
- agreement on tool surface (lifecycle + debug + individual monitor tools)
- agreement on binary monitor protocol
- agreement on trace artifact format (JSONL + summary JSON)
- agreement on config copy scope (vicerc + .vhk files)

Status: **complete**

### Phase 1: Session Foundation

Tasks:

1. Add runtime type definitions (`types.ts`): session state, stop reason, media type, trace event types.
2. Add monitor port selection support: prefer 6510, probe and increment until a free local port is found.
3. Implement `ViceConfigWorkspace`:
   - discover config at `~/.config/vice/vicerc`
   - copy `vicerc` and all `.vhk` files into session directory
   - generate overlay with: binary monitor on the selected session port, session-local logs, `SaveResourcesOnExit=0`
4. Implement `ViceProcessLauncher`:
   - start `x64sc` with session config, overlay, and optional media autostart
   - store `ChildProcess` handle, PID, start time, launch command
   - capture stdout/stderr to session log files
   - stop: monitor quit → wait → SIGTERM → SIGKILL
5. Implement `ViceSessionManager`:
   - single active session guard
   - create session workspace, launch process, track state
   - expose status and cleanup

Acceptance criteria:

- can start a visible VICE process from MCP with copied user config
- hotkeys work in the started VICE instance
- session metadata is written to `session.json`
- session can be stopped cleanly
- process does not become orphaned after normal stop

### Phase 2: Binary Monitor Client

Tasks:

1. Implement binary monitor protocol client (`monitor-client.ts`):
   - TCP connection to `localhost:<selected-port>`
   - binary request/response framing with command IDs
   - typed command builders for: ping, quit, registers read, memory read, breakpoint set/delete, continue, step, next
   - response parsing into typed results
   - connection state management (connected, disconnected, error)
2. Add monitor connection to session startup flow (connect after VICE process is ready).
3. Integrate monitor quit into shutdown sequence.

Acceptance criteria:

- session reports connected vs not connected
- can read registers from a running VICE instance
- monitor quit works when VICE is still responsive
- process-stop fallback still works when monitor quit fails

### Phase 3: Session Lifecycle Tools + Interactive Trace

Tasks:

1. Register `vice_session_start` tool in `server.ts`:
   - parameters: optional `media_path`, `media_type`
   - creates session, launches VICE, connects monitor
2. Register `vice_session_status` tool.
3. Register `vice_session_stop` tool.
5. Implement `ViceTraceCollector`:
   - write JSONL events for: session start, media info, monitor commands/responses, breakpoint hits, session stop
   - generate `summary.json` on session end
6. Register `vice_trace_stop_and_analyze` tool:
   - stop session, finalize trace, return summary

Acceptance criteria:

- LLM can start VICE with a PRG and see it autostart
- LLM can query session status
- session stop produces JSONL event log and summary JSON
- abnormal exit still produces usable trace artifacts

### Phase 4: Debug Execution + Monitor Tools

Tasks:

1. Register `vice_debug_run` tool:
   - accept breakpoint addresses
   - set breakpoints via binary monitor
   - continue execution
   - poll/wait for breakpoint hit, timeout, or process exit
   - return which breakpoint hit (or timeout/exit)
2. Register individual monitor tools:
   - `vice_monitor_registers` — read all CPU registers
   - `vice_monitor_backtrace` — call stack
   - `vice_monitor_step` — step into
   - `vice_monitor_next` — step over
   - `vice_monitor_memory` — read memory range or search
   - `vice_monitor_bank` — show/switch memory bank
   - `vice_monitor_snapshot` — save emulator state
   - `vice_monitor_save` — save memory range to file (with load address header)
   - `vice_monitor_binary_save` — save memory range to file (raw binary, no header)
   - `vice_monitor_continue` — continue to next breakpoint
3. Add `debug_workflow` MCP prompt:
   - teach LLM when to use interactive trace vs debug run
   - document typical debugging sequences
   - explain how to interpret C64 register state and memory layout
4. Ensure all monitor commands are logged to trace collector.

Acceptance criteria:

- can start a debug run with breakpoints and get a hit notification
- LLM can inspect registers, step through code, read memory after breakpoint
- LLM can continue and hit subsequent breakpoints
- all monitor interactions appear in JSONL trace
- `debug_workflow` prompt gives the LLM actionable guidance

### Phase 5: Hardening

Tasks:

1. Improve cleanup behavior after crashes and hangs.
2. Validate copied config behavior on macOS with real user setup.
3. Verify `.vhk` hotkey files work correctly in session workspace.
4. Add artifact retention policy (prevent unbounded growth of session directories).
5. Add tests for session manager and launcher logic.
6. Add tests for binary monitor protocol parsing.

Acceptance criteria:

- repeated start/stop cycles do not leave dead sessions behind
- copied config preserves all user controls (hotkeys, joystick)
- failure paths produce useful diagnostics
- binary monitor edge cases are handled (partial reads, connection drops)

## Detailed Technical Decisions

### Config Copy Strategy

Source: `~/.config/vice/`

Files copied:

- `vicerc`
- all `*.vhk` files (hotkey mappings)

Overlay forces:

- `BinaryMonitor=1`
- `BinaryMonitorAddress=ip4://127.0.0.1:<selected-port>`
- `SaveResourcesOnExit=0`
- session-local log paths

### Session Directory Strategy

Location:

```text
analysis/runtime/<timestamp>-<shortid>/
```

Contents:

```text
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

### Media Attach Strategy

Support media types: `prg`, `crt`, `d64`, `g64`

Primary approach: autostart via `x64sc` CLI args (e.g., `x64sc -autostart /path/to/file.prg`)

Attach to an already running session is explicitly deferred to a later enhancement.

### Binary Monitor Protocol

Implementation approach:

- TCP socket connection to `localhost:<selected-port>`
- Binary framing: 11-byte header (STX, API version, body length, request ID, command type) + body
- Response matching by request ID
- Implement only the commands needed for the tool surface first
- Key commands: MON_CMD_PING, MON_CMD_REGISTERS_GET, MON_CMD_MEMORY_GET, MON_CMD_CHECKPOINT_SET, MON_CMD_ADVANCE_INSTRUCTIONS, MON_CMD_EXIT (continue), MON_CMD_QUIT, MON_CMD_DUMP, MON_CMD_BANKS_AVAILABLE, MON_CMD_STACK_FRAME

### Stop Strategy

Stop order:

1. monitor quit (MON_CMD_QUIT via binary protocol)
2. wait for process exit (3s timeout)
3. SIGTERM
4. wait (2s timeout)
5. SIGKILL
6. finalize JSONL log and generate summary JSON

### Trace Event Schema

Each JSONL line:

```json
{
  "ts": "2026-04-05T14:30:00.123Z",
  "type": "monitor_command|monitor_response|breakpoint_hit|session_start|session_stop|media_attach|error",
  "data": { ... }
}
```

Summary JSON:

```json
{
  "sessionId": "20260405-143000-abc123",
  "duration": 45.2,
  "mediaUsed": [{"path": "/path/to/file.prg", "type": "prg"}],
  "exitReason": "clean|timeout|crash|killed",
  "monitorConnected": true,
  "breakpointHits": [{"address": "0x0810", "hitCount": 1}],
  "eventCount": 42,
  "warnings": []
}
```

## Risks

### High Risk

- Binary monitor protocol may have undocumented behaviors or version-specific quirks in VICE 3.10.
- Copied configs may reference additional resource files not yet discovered for copying.
- Startup-time port probing may race with another local process unless launch sequencing is careful.

### Medium Risk

- UI interaction by the user and monitor interaction by the MCP may interfere if not carefully sequenced.
- Autostart behavior differs across media types.

### Low Risk

- File management and session metadata layout.

## Test Strategy

### Unit Tests

- config file discovery and copy logic
- overlay generation
- session state transitions
- process stop escalation sequence
- binary monitor protocol framing (request building, response parsing)

### Integration Tests

- start session with mocked process launcher
- stop session after simulated abnormal exit
- debug run with mocked monitor client
- monitor command/response round-trip with mocked TCP socket

### Manual Tests

1. Start session using copied real user config.
2. Verify hotkeys still work.
3. Verify virtual joystick behavior still works.
4. Autostart a PRG via `vice_session_start`.
5. Stop session and inspect produced JSONL + summary artifacts.
6. Run breakpoint-driven debug flow: set breakpoint, hit it, read registers, step, read memory, continue.
7. Force-kill VICE and verify cleanup produces usable trace.

## Recommended First Implementation Slice

The first coding slice should be deliberately narrow:

1. `types.ts` — core type definitions
2. `ViceConfigWorkspace` — copy config + .vhk files, write overlay
3. `ViceProcessLauncher` — start/stop x64sc
4. `ViceSessionManager` — single-session lifecycle
5. `vice_session_start` tool — with optional media autostart
6. `vice_session_status` tool
7. `vice_session_stop` tool

Reason: if session lifecycle and config isolation are not solid first, every monitor, trace, or debug feature built on top will be unstable.

## Exit Criteria For First Merge

The first merge is ready when:

- a visible VICE session can be started from MCP with optional media autostart
- the session uses a copied user config with hotkey files
- the session can be stopped cleanly
- no changes are written back to the user's real VICE config
- basic session artifacts (session.json, stdout/stderr logs) are written
- architecture and implementation documents are reviewed and reflect actual implementation
