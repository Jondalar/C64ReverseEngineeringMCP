# Bug: Product UI lacks visible runtime connection/session status for LLM-human coordination

- **ID:** BUG-018
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: 12b74c3
- Surface: product UI / Live tab / workspace navigation
- Project dir: current project UI acceptance session
- Tool / endpoint / tab: top navigation / tab strip / runtime status area

## What happened

The product UI no longer shows the runtime connection status and active session name/id in the obvious top-level location where the old v3 UI showed it. This makes collaboration with the LLM harder because the human cannot quickly see which runtime session is connected, whether it is open/closed/connecting, and whether the UI and LLM are talking about the same session.

## Expected

The product UI should show runtime connection/session status near the top navigation or another always-visible status area, similar to the old v3 UI.

Expected fields:

- connection state: connecting / open / closed / error
- session id/name, e.g. `integrated-1`
- running/paused state
- cycle count, if available
- possibly FPS/frame status

The status should be visible enough for human/LLM coordination, especially when debugging runtime state.

## Repro steps

1. Open the product UI.
2. Look at the top navigation / workspace views tab area.
3. Observe that the runtime connection/session status is not visible in the same clear way as old v3.

Minimal command / call:

```text
Open product UI and inspect the top-level navigation/status area.
```

## Evidence

- Error / output (verbatim):

```text
Hier irgendwo den Connection status und den namen der Session wie im V3 wäre hut für zusammenarbeit mit dem LLM
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Target area: workspace tab strip / top-level navigation
Nearby text: Live Dashboard Questions Docs Memory Map Disk Payloads Flow Graph Annotated List
Missing: clear runtime connection/session status like old v3.
```

- Artifacts: user-provided marked browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

Top-level product UI header/navigation. Status values likely already exist in the Live/runtime state; they need to be surfaced in the shared header/tab area, not only buried in Live internals.

## Notes / follow-up

- This is specifically for human + LLM coordination: both need to refer to the same runtime session by name/id.
- Should not require opening developer tools or inspecting WS state.

---

## Resolution

- **Root cause:** when the v3 Live tab was embedded into the v1 product workbench, the runtime conn/session state existed only inside the Live tab and the WS subscription was gated on `activeTab === "live"`. The standalone v3 shell showed conn/session/run/cycle in its always-visible header; the product UI lost that, so the human couldn't see which session was connected without opening the Live tab.
- **Fix (`ui/src/App.tsx` + `ui/src/index.css` + the Live components):** the conn subscription (`getClient().onState`) runs in a mount effect (no tab gate), the session is picked once the socket opens, and the cycle counter is polled from `session/state` every 1 s while connected (no frame subscription — frames stay a Live-tab concern). The status chip (connection chip `connecting`/`open`/`closed`/`error` with colour+dot, session id, cycle) is rendered **in the Live tab's machine-controls bar, next to the Audio button** (per the user's request — `.rt-inline` variant), not in the global product header. It is threaded in via an optional `statusSlot` prop on `LiveTab` → `MachineControls`; the standalone v3 dev shell omits it (it keeps its own header status), so v3 is visually unchanged. (Run state is already shown by the controls bar's Run/Pause button, so it's not duplicated in the chip.)
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug018` 8/8 — source wiring (mount-time conn subscribe NOT gated on the Live tab, cycle poll, status-bar JSX with conn/session/run/cycle) + built v1 bundle markers (`runtime-status-bar` in JS, `.rt-conn-open`/`.runtime-status-bar` in CSS). v1 build green; ui typecheck 13 pre-existing / 0 new.
- **Regression risk:** low — additive header + status polling. The product workbench now opens the runtime WS on load (it is a runtime product, and the workspace always starts the backend); no frame streaming is started here, only lightweight status polling.
