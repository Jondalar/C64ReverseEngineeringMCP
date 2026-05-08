# Spec 261 — UI shell

**Sprint:** 135
**Status:** PROPOSED 2026-05-09
**Master:** 260

## Goal

React/Vite browser app shell. Connects to MCP via WebSocket
(Spec 272). Top-level tab navigation hosting all V3 panels.

## Surface

- App entry: `ui/src/v3/App.tsx`
- Routes / tabs: Live, Monitor, Trace, Snapshots, Scenarios, Media, Export
- WebSocket client: `ui/src/v3/ws-client.ts` — JSON-RPC commands
  + binary frame consumer
- State: Zustand or React Context (= simple global store, no Redux)
- Theme: dark mode default (RE-friendly), C64-blue accent

## Layout

```
┌─ Header: [C64RE V3] [Session: motm] [Status: running]    ┐
├─ Tabs: Live · Monitor · Trace · Snapshots · Scenarios · Media · Export
│                                                          │
│   <active tab content>                                   │
│                                                          │
└─ Footer: cycle counter, FPS, audio-latency, bandwidth   ┘
```

## Acceptance

- `npm run ui:dev` opens browser at localhost:4311
- WebSocket connects to MCP server, shows connection status
- Tab navigation works without page reloads
- Status bar live-updates from session telemetry
