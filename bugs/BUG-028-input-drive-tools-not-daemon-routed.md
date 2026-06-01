# Bug: Runtime input/drive tools are not daemon-routed — can read the shared session but not drive it

- **ID:** BUG-028
- **Date:** 2026-06-01
- **Reporter:** llm
- **Area:** mcp-tool / runtime
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master (post Spec 744.4c standalone runtime daemon)
- Surface: mcp full + standalone runtime daemon (`ws://127.0.0.1:4312`) + UI on :4310
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint: `runtime_type` vs `runtime_session_status` / `runtime_render_screen`
- Session: `integrated-1` (the shared daemon session the human drives in the browser)

## What happened

With the standalone runtime daemon (744.4c), the **read-path** runtime MCP tools correctly
attach to the daemon and report the SHARED session, but the **input/drive** tools do NOT —
they fall back to the MCP process's own (empty) local session registry and fail.

Same session, same moment:

- `runtime_session_status integrated-1` → **works**, header "(Runtime Daemon)", live state
  (`PC=$E5D4 cycles=221184070`, advancing as the human drives it).
- `runtime_render_screen integrated-1` → **works**, header "(Runtime Daemon)", renders the
  human's live screen.
- `runtime_type integrated-1 "HALLO ALEX"` → **FAILS**: `Error: No integrated session
  integrated-1` at `src/server-tools/headless.ts:575`.

So I can observe the shared session but cannot drive it (type, and almost certainly also
`runtime_session_run`, `runtime_joystick`, `runtime_media_*`, stepping). This defeats the
point of the shared daemon for LLM+human co-driving: the human and I are on one session, I
can see it, but I cannot send input to it.

## Expected

Every runtime tool that takes a `session_id` resolves it the SAME way — when a daemon is
attached, ALL of them (read AND write: type, run/step, joystick, media mount/swap/persist,
mark, until, breakpoints) route to the daemon session. `runtime_type integrated-1` should
queue keystrokes into the daemon's `integrated-1` exactly as `runtime_session_status` reads
from it.

## Repro steps

1. Start the UI (`node dist/workspace-ui/server.js --port 4310 --project <dir>`); the daemon
   comes up on :4312 with `integrated-1`.
2. `runtime_session_status integrated-1` → succeeds ("Runtime Daemon").
3. `runtime_render_screen integrated-1` → succeeds ("Runtime Daemon").
4. `runtime_type integrated-1 "HALLO ALEX"` → fails with "No integrated session".

## Evidence

```text
runtime_session_status integrated-1
-> Runtime session status (Runtime Daemon) — integrated-1
   C64 CPU: PC=$E5D4 ... cycles=221184070   Mode: true-drive

runtime_type integrated-1 "HALLO ALEX"
-> Error: No integrated session integrated-1
   at <anonymous> (/Users/.../src/server-tools/headless.ts:575:27)
```

## Scope guess (optional)

`runtime_type`'s handler (and the other input/drive handlers) in
`src/server-tools/headless.ts` resolve the session against the local in-process registry
instead of the daemon-attached resolver that `runtime_session_status` /
`runtime_render_screen` use. Likely a shared `resolveSession(session_id)` helper is applied
to the read tools but not yet to the write/drive tools. Audit every `runtime_*` handler for
the daemon-aware resolution path and apply it uniformly.

## Notes / follow-up

- Blocks LLM+human co-driving on the shared daemon (the resolved-gap promise of 744.4 /
  the BUG-027 "can't attach" item).
- Likely also affects `runtime_session_run`, `runtime_until`, `runtime_step_*`,
  `runtime_joystick`, `runtime_media_mount/unmount/swap/persist`, `runtime_mark`. Confirm and
  fix together.
- Once fixed, the immediate acceptance check: `runtime_type integrated-1 "HALLO ALEX\r"`
  appears on the human's live screen.

---

## Resolution (fixed 2026-06-01)

- **Root cause:** Spec 744.4c routed only the read tools (`runtime_session_status`/
  `runtime_render_screen`) + `session_start/run/close` to the daemon. The input/drive
  write tools in `headless.ts` (`runtime_type`, `runtime_joystick`, `runtime_mark`,
  `runtime_load_prg`) still called `getIntegratedSession(session_id)` against the MCP
  process's own (empty) registry → "No integrated session integrated-1". So the LLM
  could observe the shared session but not drive it.
- **Fix:** routed the 4 input/drive tools to the daemon (BUG-028). `runtime_type`,
  `runtime_joystick` use the existing `session/type`, `session/joystick_set` daemon
  methods; added two missing daemon methods: `runtime/mark` (the existing MCP `mark`
  client wrapper had pointed at a non-existent handler — dead route, now real) and
  `session/load_prg` (path resolved absolute on the MCP side, daemon reads the caller's
  file — same project-agnostic rule as `session_start`'s `disk_path`). Client wrappers
  `typeText/joystickSet/loadPrg` in `runtime-daemon-client.ts`.
- **Gate proving the fix:** `npm run e2e:bug028` (7/7) — the bug's exact repro
  (`runtime_type integrated-1 "HALLO ALEX"`) no longer throws AND the text appears on
  the SHARED session's live screen (read back from screen RAM); joystick routes; a
  SECOND MCP drives the same session (co-driving); no private session leaks.
- **Regression risk:** low — additive daemon branches gated by `isDaemonMode()`; the
  in-process path is unchanged. Regression: slice2a 9/9 + slice2b 10/10 + slice2c 13/13
  + daemon 10/10 + autostart 5/5 + race 11/11 all green.
- **NOTE — remaining unrouted headless.ts tools (deliberate / follow-up):**
  `runtime_drive_session_*` + `runtime_iec_bus_state` + `runtime_drive_persist_writes`
  operate a STANDALONE drive session (their own registry, not the integrated session) —
  KEEP-INPROC. `runtime_trace_finalize`/`runtime_trace_status`/`runtime_session_snapshot`/
  `runtime_diagnose_mm` are trace/diagnostic; route in a later slice if the LLM needs them
  against the shared session.
