# Spec 272 — WebSocket protocol (JSON-RPC + binary frames)

**Sprint:** 134 (foundation)
**Status:** DONE 2026-05-09 — `V3WsServer` shipped in
src/workspace-ui/v3-ws-server.ts. Hybrid JSON-RPC text + binary
frame protocol on ws://127.0.0.1:4312. Binary types: VIC frame,
audio buffer, trace chunk, ack. Built-in handlers: ping,
session/state, runtime/call (= AgentQueryApi facade dispatch).
Smoke `scripts/smoke-v3-ws.mjs` exercises connect, ping, state,
runtime call, error path, binary round-trip, broadcast notify —
**7/7 PASS**. Build clean.
**Master:** 260

## Goal

Bidirectional WebSocket between browser UI and MCP server. Hybrid
encoding: text JSON-RPC for commands, binary frames for media
streams. localhost-only bind, no auth.

## Server bind

```
ws://127.0.0.1:4312
```

Hardcoded 127.0.0.1. `--host 0.0.0.0` flag warns user.

## Text frames (JSON-RPC 2.0)

Commands from browser → server:

```json
{ "jsonrpc": "2.0", "method": "runtime_step_into",
  "params": { "session_id": "..." }, "id": 42 }
```

Response server → browser:

```json
{ "jsonrpc": "2.0", "result": { "pc": 0xe5d0 }, "id": 42 }
```

Notifications server → browser (no id):

```json
{ "jsonrpc": "2.0", "method": "session/state",
  "params": { "running": true, "cycle": 12345678 } }
```

All V2/V3 `runtime_*` MCP tools exposed via JSON-RPC method names.

## Binary frames

```
[type:u8][seq:u32 LE][payload...]
```

Types:
- `0x01` VIC frame (palette-indexed): `width:u16][height:u16][palette:48 bytes RGB triples][pixels:width*height bytes]`
- `0x02` Audio buffer: `samples:u32][channels:u8][rate:u32][s16le data]`
- `0x03` Trace event chunk: `eventCount:u32][events JSONL gzipped]`
- `0x04` Ack: `seq:u32` (ack of received command)

Payload framing inside WebSocket binary message; one logical
message per WS frame.

## Reconnection

Browser auto-reconnects on socket close (= page refresh, network
hiccup). On reconnect:
- Send `session/resume` with last-known cycle
- Server resumes streams from current state
- No state replay (= browser shows latest only)

## Backpressure

Server flow-control:
- VIC frame queue: drop oldest if browser hasn't ack'd in 100ms
- Audio buffer queue: drop chunks if behind (= audio glitch over
  buffering delay)
- Trace events: never drop (= use server-side ring + browser
  pulls on demand)

## MCP integration

`src/workspace-ui/server.ts` extended with WebSocket upgrade
handler. New file `src/workspace-ui/ws-server.ts` owns protocol.

## Acceptance

- Browser connects, exchanges JSON-RPC ping
- VIC frames stream at 50fps without backlog
- Audio plays continuously without dropouts at 50ms latency
- Reconnect after refresh: stream resumes within 1s
- Multi-tab browser (= 2 connections to same MCP) works
  independently (= each tab gets its own VIC stream from same
  session)

## Out of scope

- TLS / wss:// (= localhost only)
- Token auth (= single user)
- Multi-server load balancing
