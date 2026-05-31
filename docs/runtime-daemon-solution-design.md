# C64RE Runtime Daemon — Solution Design

Status: binding design for Spec 744.4c.

## Goal

There is exactly one running C64 Headless Runtime authority for a project.

Both actors are clients:

- human: browser UI;
- LLM: MCP runtime tools.

Neither actor owns the emulator process.

## Product Topology

```text
C64RE Runtime Daemon
  owns IntegratedSession(s)
  owns RuntimeSessionService
  owns media, trace, checkpoint/ring, run/pause/close

Browser UI
  connects to Runtime Daemon

MCP server
  runtime_* tools connect to Runtime Daemon
```

## Binding Rules

1. Product `IntegratedSession` instances are created only inside the Runtime
   Daemon.
2. UI code must not create product sessions directly.
3. MCP tools must not create product sessions directly.
4. MCP reconnect must not reset runtime sessions.
5. Browser reload must not reset runtime sessions.
6. Trace capture is passive; starting trace does not start a run loop.
7. UI live playback is explicit continuous mode.
8. MCP runtime tools are bounded operations unless they explicitly ask the daemon
   for live mode.
9. Commands from UI and MCP serialize through the daemon and return explicit
   busy/run-state results when they overlap.
10. VICE is not part of this product topology.

## Rejected Topologies

### MCP-hosted Runtime

Rejected as product architecture. It ties runtime lifetime to MCP/IDE
connection lifetime. MCP reconnect can reset sessions.

### UI-hosted Runtime

Rejected as product architecture. It makes MCP attach/control dependent on a UI
process and historically led to a second MCP-private runtime.

### Two Process-local Singletons

Rejected. A singleton is shared only inside one OS process. UI and MCP in
separate processes with separate singletons are two runtimes.

### Mirrored Emulators

Rejected. Shared runtime means one machine state, not two sessions synchronized
after the fact.

## Required Runtime Daemon API

The transport may be HTTP, WS, JSON-RPC, stdio bridge, or another local protocol.
The API shape must cover:

- `session.start/list/attach/status/close`
- `control.run/pause/resume/wait/step`
- `media.mount/swap/eject/status`
- `trace.start/mark/status/finalize`
- `render.frame/screenshot/status`
- `inspect.*` for frozen/live inspection where applicable

MCP can wrap these as stable `runtime_*` tools. The LLM must not need to know the
daemon transport.

## Acceptance

Spec 744.4c is accepted only when an end-to-end product test proves:

1. start Runtime Daemon;
2. UI connects as client;
3. MCP connects as client;
4. MCP creates a session and UI sees the same session id/frame/cycle;
5. UI pauses/runs that session and MCP sees the same state transition;
6. UI creates or selects a session and MCP can status/render/control it;
7. MCP reconnect does not reset the session;
8. browser reload does not reset the session;
9. grep/audit proves no product path creates `IntegratedSession` outside the
   daemon.

