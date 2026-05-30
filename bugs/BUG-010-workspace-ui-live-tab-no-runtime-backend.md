# Bug: Workspace UI Live tab does not start/connect Headless Runtime backend

- **ID:** BUG-010
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** workspace-ui
- **Severity:** blocker
- **Status:** fixed

## Environment

- Branch / commit: b65943c
- Surface: ui-v3 / workspace HTTP + runtime WS
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Live tab, `http://127.0.0.1:4310/`, runtime backend expected on `127.0.0.1:4312`

## What happened

The unified UI opens the C64RE V3 Live tab, but the Headless Runtime backend is not available/connected. The status bar shows `session: (none)`, `connecting`, `running`, `cycle: 0`; the main screen stays blank with `No frame yet - emulator booting...`; CPU/VIC/SID panels show `-`.

The Live UI expects the separate runtime backend/API on port `4312`, but the workspace UI startup visible to the user does not ensure that backend is started and a session exists.

## Expected

Starting the workspace UI for a project must also start or connect the Headless Runtime backend required by the Live tab. The human should not have to know that an extra backend process on `4312` is required.

Expected behavior:

- Opening `http://127.0.0.1:4310/` shows the Live tab with a connected runtime backend.
- If no runtime session exists, the UI/backend should create one or show a clear one-click/start action.
- Session status should become a real session id, not `(none)`.
- The C64 screen should advance beyond `No frame yet - emulator booting...`.
- If `4312` is unavailable, the UI should show an actionable error: which backend is missing and how to start it.

## Repro steps

1. Start the workspace UI for the DDD project.
2. Open `http://127.0.0.1:4310/`.
3. Go to the Live tab.
4. Observe the connection/session state and screen area.

Minimal command / call:

```text
Open the workspace UI Live tab at http://127.0.0.1:4310/ without separately starting a runtime backend on 4312.
```

## Evidence

- Error / output (verbatim):

```text
Da ... die headless runtim e with nicht gestartet, exs gibt keine session auf die sich das UI connected könnte (war immer API auf 4312). Das meine ich
```

- Browser evidence:

```text
Top bar:
project: Die Dunkle Dimension
session: (none)
connecting
running
cycle: 0

Main screen:
No frame yet - emulator booting...

Inspector panels:
CPU -
VIC -
SID OFF -
```

- Artifacts: user-provided browser screenshot `Bildschirmfoto 2026-05-30 um 11.57.31.png` in Codex thread.

## Scope guess (optional)

Workspace bootstrap / UI runtime wiring:

- `scripts/workspace.mjs`
- `scripts/start-v3-server.mjs`
- `src/workspace-ui/server.ts`
- `src/workspace-ui/v3-ws-server.ts`
- v3 Live tab connection/session startup handling

Likely distinction: HTTP/UI on `4310` is running, but WS/runtime backend on `4312` is absent, not connected, or has no session.

## Notes / follow-up

- This is different from BUG-001. BUG-001 was static routing to the wrong UI bundle. BUG-010 is the Live runtime backend/session not being available from the unified UI.
- The product expectation is not that the user manually starts a second hidden backend. One documented workspace start must bring up the UI + runtime backend stack.
- If a separate runtime backend remains intentional, the UI must make that dependency explicit and actionable.

---

## Resolution

- **Root cause:** the Live tab connects to the Headless Runtime WS server on
  `:4312`. `npm run workspace` already starts BOTH the HTTP/UI server and that WS
  for one project (`scripts/workspace.mjs` → `dist/workspace-ui/server.js` +
  `scripts/start-v3-server.mjs`, which creates a session + boots to BASIC). But
  when the UI is opened against an HTTP-only server (e.g. `npm run ui:serve`, which
  runs only `src/workspace-ui/server.ts`), the WS is absent and the Live tab spun
  on `session:(none)` / `connecting` with no actionable signal. The dependency was
  implicit and a failure was silent.
- **Fix commit:** `700b398` — `/api/config` now reports `runtimeWsUrl`; a new
  `/api/runtime-status` TCP-probes `:4312` and returns `reachable` + an actionable
  `hint` (the exact `npm run workspace -- --project "<dir>"` command) when it is
  down. The v3 shell polls `/api/runtime-status` while the WS is not connected and
  shows a red banner naming the missing backend + how to start it; it clears once
  the WS connects. The documented one-command remains `npm run workspace`, which
  brings up the full stack.
- **Gate proving the fix:** `npm run smoke:workspace-runtime`
  (`scripts/smoke-workspace-runtime-bootstrap.mjs`) 7/7 — boots the workspace
  bootstrap against a temp project and proves HTTP + runtime WS both come up,
  `/api/runtime-status` reachable, the WS has a live session (not `(none)`), and
  `session/state` advances (cycle>0 → frame-ready). Negative (HTTP-only →
  `reachable=false` + actionable hint) verified manually.
- **Regression risk:** low — adds a read-only status endpoint + a UI banner; no
  change to the runtime, the emulator, or the existing `npm run workspace` flow.
