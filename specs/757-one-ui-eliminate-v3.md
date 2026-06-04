# Spec 757 — One UI: eliminate "v3" (one source, one build, one name)

**Status:** PROPOSED (2026-06-04)
**Absorbs / supersedes:** Spec 745 (retire the standalone v3 entry — its "one
build" half is P1 here) + the open contradiction in Spec 724/724B.
**Owner:** the UI (`ui/**`, `src/workspace-ui/**`) + every script/test/doc/rule
that says "v3".

## 0. Principle (user, 2026-06-04)
> "Es gibt nur 1 UI. Also in allen Tests, allen Docs, allen Regeln — weg damit!"

There is **one** UI. The `v1`/`v3` distinction is dead history that survives only
as naming + a redundant second build, and it actively causes bugs and confusion.
Remove the word "v3" everywhere: one source, one build, one served bundle, one
name. Functionality is preserved (the consolidated shell already holds the Live
workbench + all Project/Analysis screens) — this kills the *label* and the
*duplicate build*, not features ([[feedback_one_ui_shell_integrate]]: integrate,
never delete v1 *functionality*).

## 1. Evidence — why this is "wichtig"
- **Stale-artifact bug, hit live this session (2026-06-04).** The product server
  serves `ui/dist` (built by `ui:build`) at `/`. While deploying the Spec 754 MON
  button, `ui/dist` was 3 days stale (Jun 1 21:50) and a **second** build
  `ui/dist-v3` (built by `ui:v3:build`) was rebuilt *by mistake* first — the served
  bundle stayed stale, the button didn't appear. Same failure as BUG-026 (the
  trigger for Spec 745): **two builds compile one source; one is forgotten.**
- **Naming confusion, hit live this session.** "v3 UI" meant the *standalone entry*
  to one party and the *product shell* to the other — a real, repeated
  miscommunication. The token "v3" no longer denotes anything real (there is one
  UI); it only mis-denotes.
- **Footprint:** ~193 non-dist files reference `v3` (the `ui/src/v3/**` tree,
  `v3-ws-server.ts` / `V3WsServer` / `V3_WS_PORT`, `ui/v3.html`,
  `ui/v3-vite.config.ts`, `ui:v3:*` scripts, `scripts/*v3*.mjs`, plus docs/specs/
  CLAUDE.md rules).

## 2. What "v3" is today (the three things to collapse)
1. **The dual build** — `ui:build`→`ui/dist` (served at `/`) AND
   `ui:v3:build`→`ui/dist-v3` (standalone, `/v3.html`). One source
   (`ui/src/v3/**`), two artifacts. *The stale-artifact root cause.*
2. **The source/file naming** — `ui/src/v3/**`, `src/workspace-ui/v3-ws-server.ts`,
   `class V3WsServer`, `V3_WS_PORT`, `ui/v3.html`, `ui/v3-vite.config.ts`,
   `ui/src/v3/main.tsx`. The product code — keep it, **rename the `v3` token out**.
3. **The references** — `ui:v3:*` package scripts, `scripts/start-v3-server.mjs`,
   `scripts/smoke-v3-ws.mjs`, the `/v3.html` server route, and every "v3" in tests/
   docs/CLAUDE.md/specs.

## 3. Decision
**ONE UI. ONE build (`ui:build` → `ui/dist`, served at `/`). NO token "v3"
anywhere in live code/scripts/tests/docs/rules** (historical specs may keep it as
archived record). The standalone entry + the second build + the `/v3.html` route
are deleted (Spec 745); on top of that, the surviving product source is **renamed**
to drop "v3", and every reference is purged.

## 4. Scope / phases
- **P1 — collapse to ONE build (Spec 745 core; highest value, just bit us).**
  Delete the standalone entry + second build: `ui/v3.html`, `ui/v3-vite.config.ts`,
  `ui/dist-v3` (stop producing), `ui/src/v3/main.tsx` (the standalone entry only —
  NOT `App.tsx`/tabs), the `ui:v3:*` scripts, `scripts/start-v3-server.mjs` +
  `smoke-v3-ws.mjs` (if no other caller), and the `/v3.html` route +
  `uiV3DistDir`/`hasUiV3Dist` in `server.ts`. **First move** the
  `ensureRuntimeDaemon` vite plugin from `v3-vite.config.ts` into the surviving
  `ui/vite.config.ts` (744.4c Trigger 2 — no capability loss). After P1:
  `npm run ui:build` is the ONLY UI build; `git grep v3.html` → only history.
- **P2 — rename the `v3` token in code.** `ui/src/v3/**` → a neutral one-UI dir
  (OQ1); `v3-ws-server.ts` → `ws-server.ts`, `class V3WsServer` → `WsServer`,
  `V3_WS_PORT` → the WS port const; fix every import. The WS protocol, the 4310
  HTTP server, and the 4312 daemon port are **unchanged** (behaviour-preserving
  rename only). Gate: `ui:build` + `ui:typecheck` clean, the daemon + smoke tests
  green after rename.
- **P3 — purge references.** package scripts, tests (flip the `/v3.html`-alive
  assertions to 404/gone per Spec 745 §4.3), docs, and **CLAUDE.md rules** (the
  memory rules that say "v3" → "the UI"). Mark Spec 724.5 + 745 superseded by this;
  note in `docs/ui-server-consolidation-audit.md`. Historical specs/bugs keep their
  "v3" text (archive record) but get a one-line "v3 = the UI, retired naming" note
  where load-bearing.

## 5. Open questions
- **OQ1 — the replacement name.** `ui/src/v3/**` → `ui/src/app/**`,
  `ui/src/workbench/**`, or flatten into `ui/src/**`? (The product is shown as
  "C64RE Workbench" — `workbench` reads true, but `app` is shorter/neutral. User's
  call before P2 churn.)
- **OQ2 — keep `v1` live source?** Spec 745 §3 made the v1 entry (`ui/src/App.tsx`)
  the product shell that imports the v3 components. After the rename there is no
  "v1" either — it is just the UI entry. Confirm `ui/src/App.tsx` + `ui/src/main.tsx`
  stay as THE entry (renamed conceptually, not as a "v1" thing).
- **OQ3 — churn vs history.** Renaming 193-file-worth of `v3` is a large mechanical
  diff. Do it as one sweep (P2) or fold P2 into P1? (Lean: P1 alone removes the
  *bug class* immediately; P2/P3 are the *naming hygiene* the user asked for —
  sequence them, but both land.)

## 6. Non-goals
- NOT deleting any UI *functionality* (the consolidated shell keeps every tab /
  screen; this removes a duplicate build + a dead label).
- NOT changing ports (4310 HTTP / 4312 daemon WS) or the WS message protocol.
- NOT a visual/layout redesign (that is the browser-annotate flow,
  [[feedback_ui_browser_annotation]]).

## 7. Acceptance
- One UI build: `npm run ui:build` → `ui/dist` is the only bundle; `ui:v3:*` scripts
  + `ui/dist-v3` + `ui/v3.html` + `/v3.html` route GONE; a single source edit +
  `ui:build` is sufficient to deploy (no second build to forget).
- `git grep -i '\bv3\b'` over live code/scripts/tests/docs/CLAUDE.md returns
  **zero** hits (only `specs/_archive/**` + dated historical mentions remain).
- `npm run ui:build` + `ui:typecheck` clean; the 4310 workbench + 4312 daemon +
  monitor (incl. the Spec 754 MON pop-out) work unchanged; smoke tests green with
  the flipped `/v3.html`→404 assertions; `npm run ui:dev` still warm-starts the
  daemon (plugin moved). Gate `e2e:757`.
