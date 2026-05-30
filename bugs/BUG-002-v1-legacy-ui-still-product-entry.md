# Bug: v1 legacy UI is still served as a separate product entry

- **ID:** BUG-002
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** workspace-ui
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: ui-v3 / workspace HTTP
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `http://127.0.0.1:4310/`, `http://127.0.0.1:4310/v3.html`, `http://127.0.0.1:4310/index.html`

## What happened

After BUG-001, `/` and `/v3.html` are intended to serve the v3 shell, but `/index.html` still serves the old v1 app. That means the product still exposes two separate browser UIs. A user can still land in the wrong UI, and 724B "One UI Shell" is not actually complete.

## Expected

There is one normal browser UI entry for product use. `/`, `/v3.html`, and normal docs/playbooks should lead to the v3 One-UI Shell. The v1 UI must not remain a normal product entry.

Acceptable outcomes:

- `/` opens v3.
- `/v3.html` opens v3 or redirects to `/`.
- `/index.html` redirects to v3, or shows a tiny explicit legacy/dev-only page that cannot be mistaken for the product UI.
- If v1 remains temporarily reachable for reference, it must move behind an explicit dev-only URL such as `/legacy/index.html`.
- No normal documentation/playbook points users to v1.

## Repro steps

1. Start the workspace UI for a project.
2. Open `http://127.0.0.1:4310/`.
3. Open `http://127.0.0.1:4310/v3.html`.
4. Open `http://127.0.0.1:4310/index.html`.
5. Observe whether `/index.html` still exposes a second product-looking UI.

Minimal command / call:

```text
Open /, /v3.html, and /index.html on the workspace HTTP server.
```

## Evidence

- Error / output (verbatim):

```text
BUG-001 fix report says:
"/ + /v3.html → v3-Shell (ui/dist-v3)"
"/index.html → legacy v1 (ui/dist)"

This still exposes two UIs.
```

- Artifacts: browser state in Codex thread, 2026-05-30.

## Scope guess (optional)

`src/workspace-ui/server.ts` static routing / fallback behavior. Possibly docs/playbooks that still mention the v1 entry.

## Notes / follow-up

- This is separate from BUG-001. BUG-001 fixed the default route accidentally serving v1. BUG-002 is about retiring or hiding v1 as a normal product entry.
- For 724B DONE, normal users should not see two product UIs.

---

## Resolution

- **Root cause:** the earlier 724B framing made the v3 shell the product (served at `/`) and kept v1 as a *second* separately-served entry, so two normal product UIs co-existed. The final 724B decision inverts this: there is exactly ONE product UI = the v1 workbench (the functional Project/Analysis source of truth), now restyled to the v3 theme + extended with the v3 Live runtime tab. v3 standalone is demoted to dev/reference.
- **Fix:** the static router (`src/workspace-ui/server.ts`) now serves the v1 product bundle at `/` and `/index.html`; `/v3.html` is reachable only as the dev/reference shell. The v1 entry no longer self-labels "legacy". (Live tab + theme were the parallel 724B slices.)
- **Fix commits:** `ec0a1e1` (route `/` → v1 product, v3 → dev-only), with `8252560`/`5653738`/`6809cef` completing the one-UI product (Live tab + frame-connect + v3 theme).
- **Gate proving the fix:** `npm run smoke:product-ui` — check 7 (`/` = `C64RE Workbench`, the v1 product) + 7b (`/` is NOT the v3 shell) + 8 (`/index.html` = the SAME product, no second UI) + 9 (`/v3.html` = `C64RE V3`, a distinct dev/reference title). 13/13 green. Asset names are unique (`index-*` vs `v3-*`) so `/assets/*` resolves correctly per entry.
- **Regression risk:** low — routing + entry-title only; v1/v3 bundles unchanged. `/v3.html` still works for developers but is no longer a normal product entry.
