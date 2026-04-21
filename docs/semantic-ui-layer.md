# Semantic UI Layer

Persistent project-knowledge store + workspace UI. Together they turn the
heuristic + LLM analysis output into a navigable RE workspace that
survives across sessions and chunks the work into LLM-sized windows.

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
npm run ui:spike         # build + serve against the polarbear example
```

The UI is React + Vite, no global state library. Tabs map 1:1 to views.

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

CORS is open (`Access-Control-Allow-Origin: *`) so the dev server on
`:4311` can hit the API server on `:4310` during UI iteration.

## Example workspace

`examples/polarbear-in-space-example/` is bootstrapped from real CRT + D64
inputs and contains the full set of knowledge files + rendered views. The
`refresh-polarbear-example` script re-runs the import + view pipeline so
the example keeps tracking schema changes.

```sh
node scripts/refresh-polarbear-example.mjs
node scripts/project-knowledge-smoke.mjs
```
