# Bug: Header hero contains dashboard metrics and filters

- **ID:** BUG-020
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** workspace-ui
- **Severity:** medium
- **Status:** open

## Environment

- Branch / commit: faf59b4
- Surface: workspace UI
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: global header / all tabs

## What happened

The global hero/header shows Dashboard-style counts and filter controls on every
tab:

- Artifacts
- Active Findings
- Open Tasks
- Open Questions
- `active`
- `updated ...`
- `Show all versions`
- `Show internal files`

These controls consume vertical space and visually dominate screens where the
user is working inside Disk, Live, Payloads, etc. They are project/dashboard
overview information, not global navigation chrome.

## Expected

The global header should be lean. It should show only identity/navigation-level
information, such as:

- product/workspace label;
- project name;
- maybe project path/status/session summary if needed.

The four count boxes and the `active/updated/show all versions/show internal
files` controls should move into the Dashboard/Project overview area, where they
belong.

## Repro steps

1. Open the workspace UI.
2. Switch to `Disk`, `Live`, or any non-dashboard tab.
3. Observe the large header with dashboard metrics and filters still present.

Minimal command / call:

```text
UI: open http://127.0.0.1:4310/ and switch away from Dashboard.
```

## Evidence

- Error / output (verbatim):

```text
Die 4 Boxen könnten auch gut ins Dashboard... nicht hierhin.
```

```text
Genauso diese Zeile
```

The second note refers to the line:

```text
active updated 30.05., 18:48 Show all versions Show internal files
```

- Artifacts: browser screenshots/comments on `http://127.0.0.1:4310/`, header
  hero in Wasteland EasyFlash Crack project.

## Scope guess (optional)

Workspace header/hero layout. Dashboard summary cards and project filters should
be rendered inside the Dashboard tab instead of the global header.

## Notes / follow-up

- This is a layout/product-information-placement issue, not a runtime bug.
- Keep project identity visible globally, but move dashboard metrics and filters
  to Dashboard.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**

