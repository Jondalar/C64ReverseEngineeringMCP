# Semantic UI Layer

Persistent project-knowledge store + workspace UI. Together they turn the
heuristic + LLM analysis output into a navigable RE workspace that
survives across sessions and chunks the work into LLM-sized windows.

This document is about the C64RE project UI layer, not only the emulator.
The Workspace UI remains the project browser. The V3 Emulator UI is a
runtime client that can feed new evidence back into the same project
knowledge layer.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Analysis output                                           │
│  (analysis JSON, manifests, traces, runtime sessions)      │
└──────────────────────────┬─────────────────────────────────┘
                           │ import_*
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Project knowledge store  (knowledge/*.json + notes.md)    │
│                                                            │
│   project · entities · findings · relations · flows ·      │
│   tasks · open-questions · labels · artifacts              │
└──────────────────────────┬─────────────────────────────────┘
                           │ build_*
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Views  (views/*.json)                                     │
│                                                            │
│   project-dashboard · memory-map · cartridge-layout ·      │
│   disk-layout · load-sequence · flow-graph ·               │
│   annotated-listing                                        │
└──────────────────────────┬─────────────────────────────────┘
                           │ /api/workspace
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Workspace UI  (Vite + React, served by workspace-ui      │
│  server, also speaks /api/document and /api/artifact/raw)  │
│                                                            │
│   tabs: dashboard · docs · memory · cartridge · disk ·    │
│         load · flow · listing · activity                   │
│   global hex overlay (mon icon on every artifact)         │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  V3 Emulator UI  (runtime client, WebSocket/API)           │
│                                                            │
│   live machine · monitor · media · inspector · trace       │
│   swimlanes · frozen explore to knowledge                  │
└────────────────────────────────────────────────────────────┘
```

## Knowledge store

Lives next to the project under `knowledge/`:

```
project.json            project metadata
entities.json           memory regions, routines, chips, assets, symbols
findings.json           observations, hypotheses, confirmed facts
relations.json          typed entity-to-entity links
flows.json              load chains, runtime phases, structural call graphs
tasks.json              outstanding work, statuses
open-questions.json     unresolved RE questions
labels.user.json        per-project user labels
artifacts.json          registered artifact paths + roles
notes.md                free-form notes
session/timeline.jsonl  append-only session activity log
session/checkpoints/    named knowledge snapshots
```

The [knowledge MCP tools](tools/knowledge.md) read and write these files.
LLM clients use the same tool surface to record findings, confirm
hypotheses, and tick off tasks.

## Views

`build_*` tools render the knowledge store into JSON views under
`views/`. The workspace UI consumes them directly. Each view is
self-contained — the UI never reads the raw knowledge store.

| View | Purpose |
|---|---|
| `project-dashboard.json` | Top-level metrics + section status. |
| `memory-map.json` | Memory regions + entity links (cells + legend). |
| `cartridge-layout.json` | Cart-type-aware bank grid. Each chip carries a `slot` (`ROML` / `ROMH` / `ULTIMAX_ROMH` / `EEPROM`); each bank carries `romlChipIndex` + `romhChipIndex`; `slotLayout` describes the cart geometry (Generic, FC3, Ocean, Funplay, Super Games, Magic Desk, EasyFlash, GMod2 + EEPROM, GMod3, Protovision MegaByter). |
| `disk-layout.json` | Per-disk file list + sector chains + circular layout polar coords. |
| `load-sequence.json` | Loader / depacker phases, ordered. |
| `flow-graph.json` | Three modes: structure, load, runtime. |
| `annotated-listing.json` | Semantic listing window with entity/finding links. |

## Workspace UI

```
npm run ui:build         # bundle React app
npm run ui:serve         # serve API + bundled UI on http://127.0.0.1:4310
npm run ui:dev           # live-reload via Vite on http://127.0.0.1:4311
```

The UI is React + Vite, no global state library. Tabs map 1:1 to views.

The Workspace UI is for project state: artifacts, docs, memory maps,
media layout, load sequence, flow graph, annotated listing, findings,
tasks, and activity. It should not become a second emulator.

## V3 Emulator UI

```
npm run v3:server        # Headless Runtime WebSocket/API server
npm run ui:v3:dev        # V3 browser client
```

The Emulator UI is for live machine work:

- C64 screen, power/reset, pause/resume, snapshots, and later rewind
- project media selection or drag/drop PRG/CRT/D64/G64
- monitor/debugger with VICE-compatible command syntax
- browser keyboard passthrough and virtual joystick
- runtime inspector for CPU, CIA, VIC, SID, IEC, drive, media, and trace
  state
- frozen explore: while paused, screen regions can become project
  artifacts/findings/entities
- trace swimlanes for C64 CPU, IO, IEC, drive CPU, VIA/GCR, and runtime
  events

The V3 UI must use the same Headless Runtime and project knowledge APIs
as the MCP tools. It must not fork a separate emulator path or maintain a
private knowledge store.

Header toggles (Spec 054 + Spec 058):
- `Show all versions` — default off; exposes V0..V(n-1) artifacts for
  debug. When off, every list filters to the highest `versionRank` per
  `lineageRoot`, then dedupes by `relativePath` to catch independent
  same-path registrations (Bug 10 family).
- `Show internal files` — default off; exposes manifests, analysis
  JSONs, annotations files, run-event-logs, rebuild-check binaries.
  When off, the same filter runs in every list site through
  `InternalVisibilityContext`.

Both filters are React contexts (`LineageVisibilityContext`,
`InternalVisibilityContext`) so nested panels honour them without prop
drilling. Inspector "Linked Artifacts" rows show a `+(N-1) older` badge
when the lineage has more versions than what's currently visible.

### Screenshots

Example MotM64 workspace captures from the bundled UI:

| Dashboard | Memory map |
|---|---|
| ![Dashboard](assets/ui/02-dashboard-clean-fullscreen.png) | ![Memory map](assets/ui/04-memory-map-fullscreen.png) |

| Disk layout | Load sequence |
|---|---|
| ![Disk layout](assets/ui/05-disk-layout-fullscreen.png) | ![Load sequence](assets/ui/07-load-sequence-fullscreen.png) |

| Flow graph | Annotated listing |
|---|---|
| ![Flow graph](assets/ui/08-flow-graph-fullscreen.png) | ![Annotated listing](assets/ui/11-annotated-listing-fullscreen.png) |

Additional captured views live under `docs/assets/ui/`:
dashboard with audit warnings, questions, payloads, graphics, and the
free-form scrubber.

### Hex overlay (mon icon)

Every artifact in the inspector — and every cart chip in the bank grid —
exposes a small `mon` button that opens a hex+ASCII overlay backed by the
`/api/artifact/raw` endpoint. Cart chips pass their `loadAddress` so the
address column shows the C64-side `$8000` / `$A000` / `$E000` instead of
the file offset. Press `Esc` or click outside to close.

### Cartridge bank grid

`CartridgeMemoryGrid.tsx` renders one row per slot per bank:

- ROML always
- ROMH only when `slotLayout.hasRomh`
- A separate EEPROM block when `slotLayout.hasEeprom` (e.g. GMod2)
- Each slot bar is clickable for entity selection and carries a `mon`
  icon that opens the chip's hex view

The grid scales relative to `slotLayout.bankSize` so half-empty banks
read as half-empty bars.

## Server endpoints

`src/workspace-ui/server.ts`:

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Default project dir + UI bundle status. |
| `GET /api/workspace` | Build and return the full workspace snapshot for a project dir. |
| `GET /api/document` | Read a project-relative markdown file (used by the docs tab). |
| `GET /api/artifact/raw` | Stream raw bytes of any project-relative artifact (max 8 MiB). Backs the hex overlay. |
| `GET /api/health` | Liveness probe. |
| `GET /api/graphics` | Sprite/charset/bitmap segments (de-duped by `*_analysis.json` path; `confirmed`/`rejected` flags inlined per item — Bug 23 Stage 2). |
| `POST /api/segment/confirm` | Mark a sprite/charset/bitmap segment confirmed; writes `confirmed: true` + `confirmedBy` into the analysis JSON; emits a confirmation finding. |
| `POST /api/segment/reject` | Mark a segment rejected; writes `rejected: true` + `rejectedReason` into the analysis JSON; emits a refutation finding. |
| `POST /api/segment/clear` | Strip confirmed/rejected flags from a segment (Bug 23 Stage 2 helper; no finding created). |
| `GET /api/graphics-marks` | Compat shim — derives marks from `/api/graphics` items (no shadow store). |
| `POST /api/graphics-marks` | Compat shim — routes to `service.markSegment*` / `clearSegmentMark`. |
| `GET /api/findings` | Findings with optional filters (kind/status/entity). |
| `GET /api/entities` | Entities with optional filters. |
| `GET /api/flows` | Flows. |
| `GET /api/relations` | Relations. |
| `GET /api/per-artifact-status` | Status table per source artifact (collapsed by lineage + same-path; internal artifacts skipped — Bug 24 + Bug 26). |
| `GET /api/artifact/lineage` | V0..Vn lineage chain for a given artifact. |
| `GET /api/containers` | Container sub-entries (Spec 025 R23). |
| `GET /api/annotations/draft` / `POST /api/annotations/save` | Annotation draft viewer endpoints (Spec 051). |

CORS is open (`Access-Control-Allow-Origin: *`) so the dev server on
`:4311` can hit the API server on `:4310` during UI iteration.

The V3 runtime server is separate from this Workspace UI server. Its
contract is specified in
[`specs/272-websocket-protocol.md`](../specs/272-websocket-protocol.md)
and the 350-series UX specs. Runtime-produced artifacts should still be
saved through the project knowledge layer when they become evidence.

## Example workspace

There is no in-tree sample workspace. Smoke coverage is provided by the
project-knowledge smoke harness.

```sh
node scripts/project-knowledge-smoke.mjs
```
