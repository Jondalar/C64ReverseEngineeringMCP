# Bug: `/v3.html` opens project dashboard instead of C64 Runtime Workbench

- **ID:** BUG-001
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** blocker
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `http://127.0.0.1:4310/v3.html`

## What happened

Opening `/v3.html` shows the project dashboard / knowledge workspace only. The C64 Runtime Workbench that used to be the V3 UI is not visible: no C64 screen, no runtime controls, no Live tab, and no obvious navigation group for the emulator.

## Expected

`/v3.html` should open the unified One-UI Shell with the C64 Runtime Workbench still present and discoverable. The normal human workflow needs a visible C64 screen/runtime surface alongside the project/knowledge/trace tabs.

## Repro steps

1. Start the workspace UI for a project.
2. Open `http://127.0.0.1:4310/v3.html`.
3. Observe that the page shows the project dashboard, not the C64 Runtime Workbench.

Minimal command / call:

```text
Open http://127.0.0.1:4310/v3.html in the browser.
```

## Evidence

- Error / output (verbatim):

```text
Visible page header: "C64 Reverse Engineering Workspace" / "Die Dunkle Dimension".
Visible tabs: Dashboard, Docs, Memory Map, Payloads.
Missing expected runtime UI: C64 screen, Live tab, runtime controls, media/runtime inspector.
```

- Artifacts: user-provided browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

Likely 724B One-UI routing/navigation regression: v3 runtime tabs may be hidden, not mounted, or replaced by the project dashboard entry.

## Notes / follow-up

- This blocks human E2E acceptance because the user cannot see or drive the C64 runtime from the unified UI.
- Fix should preserve the project dashboard tabs, but restore a clear Runtime/Live entry in the same shell.

---

## Resolution

- **Root cause:** the workspace-ui static server only served `ui/dist` (the
  legacy **v1** build). `/v3.html` had no match there, so the catch-all fell back
  to `ui/dist/index.html` = the v1 app. The v3 shell build lands in `ui/dist-v3`
  and was never served. Secondary: the dist dirs were resolved from
  `process.cwd()`, so the UI was only found when launched from the repo root.
- **Fix commit:** `597ad85` — serve `/` + `/v3.html` from `ui/dist-v3` (v3 shell),
  `/index.html` from `ui/dist` (legacy v1), `/assets/*` from whichever dist has
  the file (v3 first), SPA fallback → v3. Resolve the dists from the server module
  location (`dist/workspace-ui` → repo root), not `process.cwd()`.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 28/28 — asserts
  `/` + `/v3.html` serve `C64RE V3` and `/index.html` serves the legacy v1 entry.
  Manually verified from `cwd=/tmp` against the real project
  `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`.
- **Regression risk:** low — static-serve only; the v1 entry stays reachable at
  `/index.html`; no API/runtime change. Note: in dev (vite), the v3 UI is served
  by vite on :4313; this fix is for the bundled/prod static server.
