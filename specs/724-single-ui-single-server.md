# Spec 724 — One UI, One Server Entry, One Project Path

**Status:** ACTIVE (2026-05-30) — 724A (one `--project` resolver, no cwd/samples
fallback) DONE; 724.2e (browser drag&drop → backend `media/ingress`) DONE
(2026-05-30); **724B (one UI shell — integrate the v1 knowledge screens into the v3
workbench, then retire the v1 entry) is the active remaining work.**
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

## 1a. Slice structure (2026-05-29)

Two independent halves — do NOT couple them:

- **724A — Project / bootstrap fix (DONE).** One `--project` resolver shared by
  HTTP + WS; same `projectDir` for both; no silent `process.cwd()/samples`
  fallback; repo `samples/` only via `--dev-samples`; stale post-723 keys out of
  `start-v3-server`; one `npm run workspace -- --project <dir>` command starting
  HTTP + WS on the same project. Guard `scripts/probe-workspace-single.mjs`.
  Touches NO `ui/src`, deletes NO screen, changes NO emulator behaviour.
- **724B — UI consolidation (LATER, not started).** The "One UI shell" work
  (§724.2 below): integrate the v1 knowledge/analysis screens + the v3 workbench
  into one shell, then retire the v1 entry. **v1 currently holds all the
  knowledge/analysis screens (Dashboard, Questions, Docs, Memory Map, Graphics,
  Scrub, Disk, Cartridge, Payloads, Flow Graph, Annotated Listing) and STAYS
  intact until 724B integrates them.** v1 entry + the server.ts v1-dist path +
  the stale `Scenarios.tsx` mode dropdown are all 724B.

## 2. What "good" looks like
- **One UI** eventually (724B) — but v1 is NOT deleted until its screens live in
  the one shell.
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

The one shell must follow the product swimlane, not merely glue old tabs
together. The UI is the **human workbench** for the same project state that the
LLM accesses through MCP. REST and WS are transports; they must not create a
second workflow model or a second knowledge store.

Binding UI roles:

- MCP = agent/product API used by the LLM.
- UI = human workbench over the same project/runtime/evidence state.
- ProjectKnowledgeService remains the persistence authority.
- Runtime WS streams live state; it is not a separate project owner.
- No UI screen may silently use repo `samples/` or process `cwd` as normal
  project media.

Current split (feature-diff, see `docs/ui-server-consolidation-audit.md` §8):
- **v1** (`ui/src/App.tsx` + `ui/src/components/**`, REST via server.ts, 11 tabs):
  Dashboard · Questions · Docs · Memory Map · Graphics · Scrub · Disk ·
  Cartridge · Payloads · Flow Graph · Annotated Listing.
- **v3** (`ui/src/v3/**`, WS :4312, 7 tabs): Live · Trace · Monitor · Media ·
  Scenarios · Snapshots · Export.

Target shell groups (one nav, both backends):
- **Project / Knowledge** — Dashboard, workflow state, entities, findings,
  questions, Docs (REST)
- **Media / Extraction** — Disk, Cartridge, Payloads, Graphics, media picker
  (REST + WS)
- **Runtime** — Live screen/audio/control, Monitor, media mount state (WS)
- **Trace / Evidence** — trace capture status, marks, bounded trace queries,
  evidence records (WS/REST)
- **Code / Disassembly** — Memory Map, Flow Graph, Annotated Listing,
  PC/source/evidence links (REST)
- **Inspect** — frozen VIC inspect, visual-to-RAM/code links, promoted evidence
  (WS/REST)
- **Snapshots / Branches / Export** — dump/undump, checkpoint/rewind/branch
  views, export (WS/REST)

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
- Additional gate: the shell started with `--project <external-project>` shows
  only that project's media/knowledge by default. Repo samples appear only when
  `--dev-samples` is explicitly enabled.

#### 724.2e — Browser Drag & Drop Media Ingress (Spec 709 UI Closure)

This is not a new requirement. Spec 709 already defines reproducible media
ingress and UI drag/drop. 724B must make that existing contract visible in the
one UI shell and close the old split where runtime ingress existed but the UI
was not coherently wired.

The one UI shell must support dropping media files directly into the browser.
This is human workflow, not a dev convenience, and it must call the Spec 709
backend media-ingress service rather than inventing another browser-side path.

Supported file types:

- `.d64`
- `.g64`
- `.prg`
- `.crt`

Required behavior:

| Drop type | UI/runtime action |
|---|---|
| `.d64` | Copy/register into the active project media area, mount as drive 8, keep current runtime unless mount policy requires reset. |
| `.g64` | Copy/register into the active project media area, mount as drive 8, keep current runtime unless mount policy requires reset. |
| `.crt` | Copy/register into the active project media area, insert cartridge, perform reset/cold boot so the cartridge starts. |
| `.prg` | Copy/register into the active project media area, load PRG into C64 memory, then type/execute `RUN` or equivalent KERNAL-safe start policy. |

Rules:

- The dropped file becomes a project artifact. It is not only a transient browser
  upload.
- The operation emits/uses the Spec 709 media-ingress event and media identity.
- Path handling follows the 724A resolver and the path-portability rule from
  Specs 727-729.
- The UI uses backend media/runtime APIs; it must not implement a second media
  loader in the browser.
- After the action, the UI shows the resulting media/runtime state clearly:
  mounted disk, inserted cartridge, loaded PRG, reset/run status and errors.
- If a file type is unsupported or a mount/load fails, the UI must show a clear
  failure with the project path/artifact id; no silent fallback to repo samples.

Gate:

- Drop a `.d64` fixture into an external-project workspace → artifact appears,
  drive 8 mounted.
- Drop a `.g64` fixture → artifact appears, drive 8 mounted.
- Drop a `.crt` fixture → artifact appears, cartridge inserted, cold boot
  performed.
- Drop a `.prg` fixture → artifact appears, PRG loaded and `RUN` executed.
- Existing 709 media-ingress probes remain green; if a gap exists in the old
  adapter/UI contract, fix that path instead of adding a second ingress path.

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
