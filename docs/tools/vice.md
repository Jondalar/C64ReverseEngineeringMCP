# VICE Runtime / Debug Tools

Visible VICE sessions with binary-monitor control + periodic CPU-history
sampling for runtime traces. Each session gets a session-local config copy
(your real `vicerc` and `.vhk` files stay untouched).

## Session lifecycle

| Tool | Description |
|---|---|
| `vice_session_start` | Start a visible VICE session with copied user config and optional media autostart. |
| `vice_session_status` | Report current or last session state, monitor port, and artifact paths. |
| `vice_session_stop` | Stop the active session cleanly. |
| `vice_session_attach_media` | Autostart / autoload media into a running session. |
| `vice_session_send_keys` | Feed text into the keyboard buffer. |
| `vice_session_joystick` | Send keyset-based joystick input via the copied config. |

## Runtime tracing

| Tool | Description |
|---|---|
| `vice_trace_runtime_start` | Start a session with periodic CPU-history sampling enabled. |
| `vice_trace_start` | Enable sampling on an already-running session. |
| `vice_trace_status` | Report whether sampling is active and where the trace is being written. |
| `vice_trace_stop` | Stop sampling without closing VICE. |
| `vice_trace_stop_and_analyze` | Stop the session, snapshot, and return a trace summary. |
| `vice_trace_analyze_last_session` | Analyse the most recent completed trace from disk. |
| `vice_trace_build_index` | Build a persistent trace index with continuity metrics + optional semantic links from annotations. |
| `vice_trace_hotspots` | Summarize hot PCs for triage. |

### Trace queries

| Tool | Description |
|---|---|
| `vice_trace_find_pc` | Find occurrences of a PC and return anchor clocks. |
| `vice_trace_find_bytes` | Search by raw instruction byte patterns. |
| `vice_trace_find_operand` | Search for instructions whose operand bytes contain a target address. |
| `vice_trace_find_memory_access` | Find direct read / write / RMW accesses to a target address. |
| `vice_trace_slice` | Return a focused instruction window around an anchor clock. |
| `vice_trace_call_path` | Heuristically reconstruct the JSR caller chain leading to an anchor clock. |
| `vice_trace_add_note` / `vice_trace_list_notes` | Save / read reasoning notes against a trace session. |

Default sampling settings: `100 ms` interval, CPU-history request size
`65535`, `MonitorChisLines = 16777215`. Aimed at capturing close-to-full
execution history of a normal C64 run for later LLM analysis. Very
timing-sensitive code may still need targeted breakpoint debugging.

## Monitor / debugger

| Tool | Description |
|---|---|
| `vice_debug_run` | Set breakpoints, continue execution, return on hit / stop / JAM. |
| `vice_monitor_registers` / `vice_monitor_set_registers` | Read or write CPU registers. |
| `vice_monitor_memory` / `vice_monitor_write_memory` | Read or write a memory range, optionally by memspace + bank. |
| `vice_monitor_bank` | List available memory banks for the current machine. |
| `vice_monitor_backtrace` | Heuristic stack-derived backtrace from page `$0100`. The official VICE binary monitor protocol does not expose a true backtrace, so this is reconstructed from the 6502 stack — useful, not authoritative. |
| `vice_monitor_breakpoint_add` / `_list` / `_delete` | Manage breakpoints / watchpoints / tracepoints. |
| `vice_monitor_step` / `_next` / `_continue` / `_reset` | Move execution. |
| `vice_monitor_snapshot` | Save a `.vsf` snapshot. |
| `vice_monitor_save` / `_binary_save` | Save a memory range as PRG (with load-address header) or raw binary. |
| `vice_monitor_display` | Capture the current display buffer as an indexed-grayscale PGM preview. |

## Workflow patterns

**Interactive runtime trace:**

1. `vice_trace_runtime_start`
2. user interacts in the visible VICE window
3. user closes VICE manually
4. `vice_trace_analyze_last_session`

**Trace on an already-running session:**

1. `vice_session_start`
2. `vice_trace_start`
3. user interacts
4. `vice_trace_stop` or user closes VICE
5. `vice_trace_analyze_last_session`

**Breakpoint-driven debugging:**

1. `vice_session_start`
2. `vice_debug_run`
3. inspect with `vice_monitor_registers`, `_backtrace`, `_memory`,
   `_bank`, `_breakpoint_list`
4. modify state with `_set_registers`, `_write_memory`,
   `vice_session_send_keys`
5. move with `_step`, `_next`, `_continue`, or `_reset`
6. persist with `_snapshot`, `_display`, `_save`, `_binary_save`

## Session artifacts

Each session writes to `analysis/runtime/<timestamp>-<id>/`:

- `vicerc` + `.vhk` files (session-local copies)
- MCP overlay config for binary monitor + session-local logs
- `runtime-trace.jsonl` (when sampling is active)
- per-tool reports
