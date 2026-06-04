# Spec 745 — Retire the standalone v3 UI entry (ONE build, ONE bundle)

**Status:** SUPERSEDED (2026-06-04) by **Spec 757** (DONE): this spec's "one
build" decision is Spec 757 P1; Spec 757 additionally eliminated the "v3" *naming*
everywhere (the user directive 745 §6 explicitly deferred). Read Spec 757 for the
delivered end-state.
**Depends on:** Spec 724 (single-UI — shipped, but left contradictory).

## 1. Why (the bug that triggered this)

BUG-026 (Escape→C64 ←) was fixed in the **source** (`ui/src/v3/tabs/Live.tsx`,
2026-05-31 17:06). The fix shipped into `ui/dist-v3` but NOT into `ui/dist`
(the v1 build, last built 2026-05-30). The product server serves **v1** (`ui/dist`)
at `/`, so the browser kept loading the stale `Escape→RUN_STOP` mapping → ESC aborted
LOAD with `?BREAK`. Backend + source were correct the whole time; a stale ARTIFACT
was served.

Root cause: **two build pipelines compile ONE source** (`ui/src/v3/**`):
- `ui:build` → `ui/dist/` (v1 entry, the product, served at `/`)
- `ui:v3:build` → `ui/dist-v3/` (standalone v3 entry, served at `/v3.html`)

Every source change must be built TWICE or one artifact goes stale. Same failure
class as the tsx-vs-node daemon (Spec 744.4c) and the per-project `.mcp.json` drift:
**one source, multiple artifacts, one forgotten.**

## 2. The contradiction in Spec 724

724.5's guard says *"exactly one UI entry (`ui/v3.html`); no `ui/index.html` /
`ui/dist`"* — i.e. v3 wins, v1 deleted. But 724B (later, in `server.ts`) shipped the
OPPOSITE: *"ONE product UI = the v1 workbench … served at `/`. The standalone v3 shell
stays reachable at `/v3.html` for DEV/REFERENCE only."* The direction flipped mid-stream
and was never reconciled. Endstate: v1 is the product, the standalone v3 entry is a
redundant zombie that only causes stale-artifact bugs.

## 3. Decision

**ONE UI build. ONE served bundle.** v1 (`ui/src/main.tsx` → `ui/src/App.tsx`) is the
product UI. It already imports the real product code from `ui/src/v3/**` (`LiveTab`,
`getClient`, the inspector panels). The **standalone v3 ENTRY** (`ui/v3.html` +
`ui/v3-vite.config.ts` + `ui/dist-v3` + `ui:v3:*` scripts + the `/v3.html` server route)
is deleted.

**Crucial distinction — two things are called "v3":**
- **v3 SOURCE** (`ui/src/v3/**`: App, tabs/Live, InspectorPanel, ws-client, …) = the
  actual product component code. v1 builds it. **KEEP.**
- **standalone v3 ENTRY** (`ui/v3.html`, `ui/v3-vite.config.ts`, `ui/dist-v3`, `ui:v3:*`)
  = a second redundant shell of that same source. **DELETE.**

After this: editing `ui/src/v3/**` and running `npm run ui:build` is the ONLY path to
the served UI. There is no second bundle to forget.

## 4. Scope (what changes)

### 4.1 Daemon-trigger plugin MUST move first (no capability loss)
The `ensureRuntimeDaemon` vite plugin (Spec 744.4c Trigger 2 — UI dev-server warm-starts
the runtime daemon if down) lives ONLY in `ui/v3-vite.config.ts`. **Move it into
`ui/vite.config.ts`** (the surviving v1 config) BEFORE deleting v3-vite.config, else
`npm run ui:dev` loses the auto-start. Verify: `ui:dev` on a cold port spawns the daemon.

### 4.2 Delete
- `ui/v3.html`
- `ui/v3-vite.config.ts` (after 4.1)
- `ui/dist-v3/` (build output; gitignored — just stop producing it)
- `ui/src/v3/main.tsx` (the standalone entry — NOT `ui/src/v3/App.tsx`/tabs, which v1 still
  needs; confirm `App.tsx` has no other importer than the deleted `main.tsx` before
  removing it too, else keep `App.tsx`).
- package.json scripts: `ui:v3:dev`, `ui:v3:build`, `ui:v3:typecheck`, `smoke:v3-ws`,
  `v3:server` (+ `scripts/start-v3-server.mjs` if it has no other caller).
- `server.ts`: the `/v3.html` route + `uiV3DistDir`/`hasUiV3Dist` plumbing. `/v3.html`
  and any `/assets/v3-*` now 404.

### 4.3 Rewrite the 2 tests that pin v3 alive
- `scripts/smoke-product-ui.mjs` test 9 ("/v3.html reachable as dev/reference"): flip to
  **assert `/v3.html` → 404** (one UI, no second entry).
- `scripts/smoke-ui-project-trace-view.mjs` tests 24-26 (BUG-001 v3 routing): drop the
  `/v3.html` assertions; keep only `/` serves the product UI.

### 4.4 Reconcile docs/specs
- Spec 724: mark 724.5's "one entry = ui/v3.html" line SUPERSEDED by this spec (the
  product entry is v1 `index.html`; the contradiction is resolved in favour of v1).
- `docs/ui-server-consolidation-audit.md`: note the standalone v3 entry is retired.

## 5. Acceptance
- `ui/v3.html`, `ui/v3-vite.config.ts`, `ui:v3:*` scripts GONE; `npm run ui:build` is the
  only UI build; `git grep v3.html` finds only historical spec/doc mentions.
- `ui/dist/` (v1) serves a Live tab with `Escape→LARROW` (BUG-026 fix present in the ONLY
  bundle); a source edit + `ui:build` is sufficient — no second build to forget.
- `npm run ui:dev` still warm-starts the runtime daemon (plugin moved, 744.4c Trigger 2
  intact).
- `/v3.html` → 404; `/` serves the product UI. Both smoke tests GREEN with the flipped
  assertions. `ui:typecheck` clean.

## 6. Non-goals
- NOT touching `ui/src/v3/**` component source (that IS the product).
- NOT renaming the `v3/` source dir (churn for no gain; it's just a folder name now).
- NOT changing ports / the 4310 server / the 4312 daemon.
