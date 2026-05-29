# UI / server consolidation audit (Spec 724.1)

**Date:** 2026-05-29. Audit-only — input for the 724 code slices. No code change.

**North star:** the MCP + workspace must be usable by an LLM from OUTSIDE the
C64RE dev repo (installed elsewhere, launched from any cwd, pointed at an
arbitrary project). The findings below are ranked by whether they block that.

## 1. Three server surfaces (confirmed)

| # | file | transport | consumer | project path | starts a runtime session? |
|---|------|-----------|----------|--------------|---------------------------|
| 1 | `src/server.ts` (+ `cli.ts`) | stdio (MCP) | the LLM (194 tools) | `projectDir()` helper, `src/server.ts:37-39`, **cwd fallback** | yes, via tools |
| 2 | `src/workspace-ui/server.ts` | HTTP (`node:http`, `createServer` :264) | browser UI knowledge tabs (REST) | `--project` > `C64RE_PROJECT_DIR` > **`process.cwd()`** (`:72-86`) | no (knowledge only) |
| 3 | `src/workspace-ui/v3-ws-server.ts` via `scripts/start-v3-server.mjs` | WebSocket (`ws`, :4312) | live runtime (frames/audio push) | **none for runtime**; media = `cwd/samples` (`:1176`) + `C64RE_PROJECT_DIR` env scan (`:1196`) | yes (`start-v3-server.mjs` creates the session) |

## 2. Two UIs (confirmed)

| UI | entry | vite config | built dist | served by |
|----|-------|-------------|------------|-----------|
| v1 (legacy) | `ui/index.html` | `ui/vite.config.ts` | `ui/dist` | `server.ts:261` `uiDistDir = resolve(cwd, "ui", "dist")` |
| v3 (current) | `ui/v3.html` | `ui/v3-vite.config.ts` | `ui/dist-v3` | (v3 dev/build; runtime via the WS) |

Note: `server.ts:261` serves the **v1** `ui/dist` — the HTTP server is still
wired to the legacy UI build.

## 3. All project-path sources (the drift)

- MCP stdio: `src/server.ts:37` `projectDir(hint)` → `findProjectDir({ cwd, hint })` (cwd fallback).
- Workspace HTTP: `server.ts:72-73` env `C64RE_PROJECT_DIR`; `:85-86` `--project` (resolved vs cwd); `:74` default `process.cwd()`; per-request `?projectDir=` (~30 sites, each `resolve(process.cwd(), …)`).
- Runtime WS: `v3-ws-server.ts:1196` + `:1578` read `process.env.C64RE_PROJECT_DIR` directly; no `--project`.

→ **Three independent resolvers, three precedence rules.** Setting the project
for one does not set it for the others. This is the root of the "Murder" bug
(WS without the env → cwd/samples + empty knowledge).

## 4. All `process.cwd()` / repo `samples/` fallbacks (outside-repo blockers)

| site | what | blocks outside-repo? |
|------|------|----------------------|
| `v3-ws-server.ts:1176` | `join(process.cwd(), "samples")` — ALWAYS-on media scan | **YES** — only repo samples; project media only if env set |
| `server.ts:261` | `resolve(process.cwd(), "ui", "dist")` — UI asset dir | **YES** — UI not found unless launched from repo root |
| `server.ts:74` | projectDir default = `process.cwd()` | **YES** — silently "projects" whatever cwd is |
| `server.ts` ×~30 | `resolve(process.cwd(), payload.projectDir / ?projectDir=)` | partial — fine for relative input, but duplicated 30× (no single resolver) |
| `src/server.ts:39` | MCP `projectDir()` cwd fallback | **YES** — MCP "project" = cwd when no env/hint |

`start-v3-server.mjs:8` uses `import.meta.dirname` for `dist/` imports — that one
is cwd-free (correct); the cwd problem is only the `samples` scan.

## 5. Stale post-723 runtime keys in `start-v3-server.mjs`

| line | key | status |
|------|-----|--------|
| 33-34, 40 | `drive1541` (from `C64RE_DRIVE1541` env) | post-723.6 ignored — VICE1541 is the only drive |
| 38 | `useMicrocodedCpu: true` | post-723.4a ignored — microcoded is the only CPU |
| 52-57 | `C64RE_CYCLE_PUMPED=1` → `installCyclePumpedRenderer` | **likely broken** post-723.7d — the cycle-pumped path used `VicIIVice.onCycle`, now deleted. Opt-in env; off by default. |

Also stale: `ui/src/v3/tabs/Scenarios.tsx` offers `fast-trap` / `real-kernal`
mode options (removed in 723.3) — would 400 on submit.

## 6. 724 code slices (confirmed by this audit)

- **724.2** retire v1 UI: remove `ui/index.html`, `ui/vite.config.ts`, `ui/dist`,
  v1 `ui:dev`/`ui:build`; point `server.ts:261` at the v3 dist (`ui/dist-v3`),
  resolved cwd-free (see 724.3).
- **724.3** one resolver `resolveProjectDir(argv, env)` = `--project` >
  `C64RE_PROJECT_DIR` > **hard error** (no cwd fallback). Used by HTTP + WS; the
  MCP stdio server documents the same env. UI asset dir resolved via
  `import.meta.dirname`/package root, not cwd. One bootstrap
  `npm run workspace -- --project <dir>` starts HTTP + WS with the one path.
- **724.4** WS media scan reads the project path only; repo `samples/` behind an
  explicit `--dev-samples` (default off). Remove the `start-v3-server` dead keys
  (`useMicrocodedCpu`/`drive1541`/cycle-pumped) + the `Scenarios.tsx` mode
  options.
- **724.5** guard `scripts/probe-workspace-single.mjs`: no `process.cwd()` in
  media/project/UI-asset resolution; no `cwd/samples` silent fallback; one v3 UI
  entry (no `ui/index.html`/`ui/dist`); HTTP + WS report the same `projectDir`;
  no post-723 removed runtime key in the bootstrap; project path required.

## 8. Feature-diff: v1 vs v3 (724.2a) — why v1 must NOT be deleted

v3 is ONLY the emulator workbench. All workspace/knowledge/analysis screens are
v1. Deleting v1 = losing product function. Consolidation = ONE shell that hosts
both, NOT deletion.

**v1** — `ui/src/App.tsx` + `ui/src/components/**`, entry `ui/src/main.tsx`,
REST via `server.ts` knowledge API. 11 tabs:

| tab | purpose | REST deps (sample) |
|-----|---------|--------------------|
| Dashboard | project status / audit / workflow runner | `/api/workspace`, `/api/audit`, `/api/per-artifact-status` |
| Questions | open questions | `/api/open-question`, `/api/tasks` |
| Docs | rendered project docs | `/api/docs`, `/api/document` |
| Memory Map | address-space map | `/api/artifact`, `/api/segment` |
| Graphics | sprite/charset/bitmap preview | `/api/graphics`, `/api/graphics-marks` |
| Scrub | segment scrub + annotate | `/api/scrub/annotate-segment`, `/api/segment` |
| Disk | disk image layout | `/api/disk`, `/api/disk/assemble-chain` |
| Cartridge | cart layout | `/api/artifact`, `/api/depack` |
| Payloads | payload list + reverse workflow | `/api/run-payload-workflow`, `/api/depack` |
| Flow Graph | control-flow view | `/api/artifact`, `/api/annotations` |
| Annotated Listing | disasm + annotations | `/api/artifact/raw`, `/api/annotations` |

(~24 `/api/*` endpoints total served by `server.ts`.)

**v3** — `ui/src/v3/**`, entry `ui/src/v3/main.tsx`, WS :4312 (kinds:
`debug/*`, `audio/*`, `batch/*`). 7 tabs: Live · Trace · Monitor · Media ·
Scenarios · Snapshots · Export.

**Target shell (724.2b-d):** one nav, four groups, both backends —
Project/Knowledge (Dashboard, Questions, Docs) · Media/Extraction (Disk,
Cartridge, Payloads, Graphics, Media) · Code (Memory Map, Flow Graph, Annotated
Listing) · Runtime (Live, Trace, Monitor, Scenarios, Snapshots, Export). Move
v1 screens in as components (reuse, same `/api/*`); remove the v1 entry only
after all are reachable.

## 7. Out of scope (flag for a follow-up, not 724)
- ROM/resource loading (`resources/roms/**`) repo-relativity — if the MCP can't
  find ROMs outside the repo that is a separate install/packaging concern.
  Not a UI/server-path issue; note for an install/packaging spec.
