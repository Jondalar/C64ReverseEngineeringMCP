# Bug: v1 legacy UI is still served as a separate product entry

- **ID:** BUG-002
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** workspace-ui
- **Severity:** high
- **Status:** open

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

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
