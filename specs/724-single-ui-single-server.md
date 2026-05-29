# Spec 724 — One UI, One Server Entry, One Project Path

**Status:** PLANNED (2026-05-29 CEST)
**Owner:** Workspace UI / server bootstrap
**North star:** the MCP + workspace must be usable by an LLM **from outside the
C64RE dev repo** (installed elsewhere, launched from any cwd, pointed at an
arbitrary project). Today they are repo-cwd-bound (`cwd/ui/dist`, `cwd/samples`,
projectDir defaulting to `cwd`). 724 makes path resolution explicit + cwd-free.
**Scope:** Collapse the UI + server surfaces so a user starts ONE thing, points
it at ONE project, and gets a coherent product. Retire the legacy v1 UI. Make
the runtime WS project-aware. Remove every `process.cwd()` hard-wire / fallback.
NO emulator behaviour change.
**Depends on:** Spec 723 (single-path runtime — DONE). Pairs with Spec 722 (tool
contract). 724 = the processes; 722 = the tools behind them.

## 1. Problem — three servers, two UIs, three project-path sources

There are **three server surfaces**, grown per-sprint, each with its own
transport AND its own project-path handling:

| # | file | transport | consumer | project path |
|---|------|-----------|----------|--------------|
| 1 | `src/server.ts` | stdio (MCP) | the LLM (Spec 722 tools) | `C64RE_PROJECT_DIR` env |
| 2 | `src/workspace-ui/server.ts` | HTTP | browser UI knowledge tabs (REST) | `--project` / env / `?projectDir=` |
| 3 | `src/workspace-ui/v3-ws-server.ts` (via `scripts/start-v3-server.mjs`) | WebSocket :4312 | live runtime (frames/audio push) | **almost none** — `process.cwd()/samples` hard-wired (`v3-ws-server.ts:1176`); `C64RE_PROJECT_DIR` env bolted on for media scan (`:1196`) |

And **two UIs**: `ui/index.html` (v1, `ui/vite.config.ts`, `ui/dist`) +
`ui/v3.html` (v3, `ui/v3-vite.config.ts`, `ui/dist-v3`). v1 is legacy, never
retired.

**Consequences (this is the "Murder" bug):**
- The project path must be set correctly in **three** places. Miss one (the
  runtime WS) → it falls back to `cwd/samples` (repo sample media) and the
  knowledge HTTP shows nothing for the project. Exactly the reported symptom:
  frame renders, knowledge empty, dropdown shows C64RE samples.
- Two UIs = doubled build/serve/feature drift; unclear which is "the" UI.
- `start-v3-server.mjs` is project-agnostic by design (Spec 261/272 dev
  bootstrap) and still passes post-723 dead keys (`useMicrocodedCpu`,
  `drive1541`) + an opt-in cycle-pumped path that used the deleted
  `VicIIVice.onCycle`.

The three transports are each technically justified (stdio for the LLM, REST for
knowledge tabs, WS for 50fps push). The problem is **no unifying bootstrap and
no single project-path source** — not the transport count.

## 2. What "good" looks like
- **One UI** (v3). v1 retired.
- **One command** starts the workspace: it resolves the project path ONCE and
  fans it out to the HTTP + WS surfaces. (The MCP/stdio server is launched by
  the MCP host with the same `C64RE_PROJECT_DIR`; 724 makes the host config +
  the workspace bootstrap read the SAME source.)
- **No `cwd` hard-wire.** Media + knowledge + runtime all resolve from the one
  project path. Repo `samples/` only appear if explicitly opted in (dev), never
  as a silent fallback that masks a misconfigured project.
- A user cannot accidentally run "frame on project A, knowledge on project B".

## 3. Non-goals
- Not collapsing the three transports into one (stdio/REST/WS serve genuinely
  different consumers). 724 unifies *launch + project path + UI*, not transport.
- No emulator/runtime behaviour change. `runtime:proof` 7/7 unchanged.
- Not the tool reshaping — that is Spec 722.

## 4. Method (audit-first, small slices)

### 724.1 — Audit (no code change)
- Confirm the three-server / two-UI map above against current code.
- v1↔v3 feature diff: what (if anything) only v1 serves; who still loads
  `ui/index.html` / `ui/dist`. Emit `docs/ui-server-consolidation-audit.md`.
- List every project-path entry point + every `process.cwd()` use in
  `workspace-ui/**`.

### 724.2 — One UI shell (NOT "delete v1") (code)
**Correction (2026-05-29):** v1 is NOT dead weight — it holds all the
workspace/knowledge/analysis screens; v3 is only the emulator workbench. The
goal is ONE shell that contains BOTH worlds. Delete nothing until every screen
is reachable in the one UI.

Current split (feature-diff, see `docs/ui-server-consolidation-audit.md` §8):
- **v1** (`ui/src/App.tsx` + `ui/src/components/**`, REST via server.ts, 11 tabs):
  Dashboard · Questions · Docs · Memory Map · Graphics · Scrub · Disk ·
  Cartridge · Payloads · Flow Graph · Annotated Listing.
- **v3** (`ui/src/v3/**`, WS :4312, 7 tabs): Live · Trace · Monitor · Media ·
  Scenarios · Snapshots · Export.

Target shell groups (one nav, both backends):
- **Project/Knowledge** — Dashboard, Questions, Docs (REST)
- **Media/Extraction** — Disk, Cartridge, Payloads, Graphics (REST) + Media (WS)
- **Code** — Memory Map, Flow Graph, Annotated Listing (REST)
- **Runtime** — Live, Trace, Monitor (WS) + Scenarios, Snapshots, Export (WS)

Sequence (no capability loss at any step):
1. (724.2a, audit-only) feature-diff: v1 tabs + REST deps vs v3 tabs + WS deps
   → done in the audit doc.
2. (724.2b) one v3/Workbench shell with the four groups above; the shell talks
   to BOTH the HTTP (REST) and WS backends.
3. (724.2c) move the v1 screens into the shell as components — reuse, not
   rewrite. Each lands behind its group, still hitting the same `/api/*`.
4. (724.2d) ONLY after every v1 screen is reachable in the shell: remove
   `ui/index.html` + the v1 entry route; `server.ts` serves the one UI.
- Gate per step: `ui:v3:build` + `ui:v3:typecheck` + the moved screens render
  against the live REST API.

### 724.3 — One project path, fanned out (code) — DONE (2026-05-29)
Shipped: `src/workspace-ui/resolve-project-dir.ts` (`--project` > env > hard
error, no cwd fallback) used by server.ts (HTTP) + start-v3-server (WS);
V3WsServer requires `projectDir` + reads it (not env); repo `samples/` behind
`--dev-samples`; dead post-723 keys removed from start-v3-server;
`npm run workspace -- --project <dir>` bootstrap starts HTTP + WS with the one
path. Guard `scripts/probe-workspace-single.mjs` 11/11. (UI v1 entry + server.ts
v1-dist path stay for 724.2d.)

Original plan:
- Single resolver: `resolveProjectDir(argv, env)` (one precedence:
  `--project` > `C64RE_PROJECT_DIR` > error). Used by BOTH `server.ts` and the
  runtime-WS bootstrap.
- Make the runtime WS project-aware: `start-v3-server.mjs` (or its replacement)
  takes the resolved project path and passes it to `V3WsServer`; the media
  scan reads the project, not `process.cwd()`.
- **One bootstrap** (`npm run workspace -- --project <dir>`) that starts the
  HTTP + WS surfaces with the one resolved path. The old `ui:serve` + `v3:server`
  split collapses into it (kept as thin internal steps if needed).
- Gate: start workspace on a fixture project → knowledge populated + project
  media in the picker + frame renders, all from one `--project`.

### 724.4 — Remove the cwd hard-wire + dead keys (code)
- `v3-ws-server.ts:1176`: drop the unconditional `process.cwd()/samples` scan;
  media comes from the project path (repo samples only behind an explicit dev
  flag).
- `start-v3-server.mjs`: remove dead `useMicrocodedCpu` / `drive1541` keys + the
  cycle-pumped path (post-723).
- `ui/src/v3/tabs/Scenarios.tsx`: remove the `fast-trap` / `real-kernal` mode
  options (removed in 723.3).
- Gate: build + UI typecheck + the smoke from 724.3.

### 724.5 — Guard (code)
`scripts/probe-workspace-single.mjs` asserts:
- exactly one UI entry (`ui/v3.html`); no `ui/index.html` / `ui/dist`;
- no `process.cwd()` in `workspace-ui/**` media/project resolution;
- the project path has exactly one resolver, used by both HTTP + WS;
- `start-v3-server`/bootstrap carries no removed runtime keys;
- the workspace bootstrap requires a project path (no silent fallback).

## 5. Open questions
- **OQ1** — does the MCP/stdio server share the bootstrap, or stay host-launched?
  Proposed: stay host-launched (the MCP host owns its lifecycle), but document
  that its `C64RE_PROJECT_DIR` MUST equal the workspace `--project`; the guard
  can warn on mismatch when both are running.
- **OQ2** — ports: keep HTTP + WS on distinct ports (4313/4312) under one
  bootstrap, or multiplex? Proposed: keep distinct ports, one process.
- **OQ3** — dev access to repo `samples/`: explicit `--dev-samples` flag vs
  drop entirely. Proposed: flag, default off.

## 6. Acceptance
- One UI (v3); v1 fully removed; `docs/ui-server-consolidation-audit.md` exists.
- One `--project` resolver feeds HTTP + WS; no `process.cwd()` media/project
  hard-wire; runtime WS is project-aware.
- One documented command starts the workspace pointed at a project; knowledge +
  project media + frame all come from that one path (Murder bug cannot recur).
- Dead keys + stale mode dropdown removed.
- `runtime:proof` 7/7 GREEN + `probe-workspace-single` GREEN.
