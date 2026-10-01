# Spec 885 — A large project loads in seconds, not minutes

**Status:** IMPLEMENTED 2026-10-01 (D1–D7) — proposed as a pull request from a user project; D8 dropped (§5).
**Repo:** C64RE only. TRX64: no change.
**Number:** 885 (registry: `specs/README.md`).
**Origin:** a user report from a real project (D42 Analysis: ~920 MB on disk, ~26k files;
artifacts 10,371, entities 22,965, findings 7,292, relations 8,162, flows 1,092;
`graph.sqlite` 153 MB). The workspace UI took about a minute to be usable after a restart,
and every `agent_onboard` / `project_status` cost 25 s / 8 s. TRX64 itself started in under
a second; traces played no part (none existed).

---

## §1 What was measured

Workspace UI, fresh `ui.ps1 restart`:

| step | before |
|---|---|
| `npm run build:mcp` on every start | 11 s |
| `GET /api/workspace` | 21–26 s, **185 MB** pretty-printed, uncompressed, `no-store` |
| the same snapshot again from Assets, Knowledge, Project Views | each a full rebuild + download |
| `GET /api/audit` | 9.2 s |

MCP over stdio, fresh process: `agent_onboard` 25.5 s, `project_status` 8.0 s — and the
second `project_status` no faster than the first. A CPU profile put the time in
(1) whole-graph projections (`listEntities` / `listFindings`) called from
`syncWorkflowState`, and (2) a project audit that never hit its cache.

## §2 Why

- **D1 — the audit cache could not hit.** `syncWorkflowState` runs on every status, onboard
  and snapshot, and rewrote `knowledge/workflow-state.json` each time only to move its
  `updatedAt` / `lastUpdatedAt` stamps. That file is in the audit fingerprint
  (`KNOWLEDGE_FILES`), so every call invalidated the cache it was about to read.
- **D2 — counting by projecting.** The workflow phase gates need five numbers (entities,
  relations, flows, findings, address-grounded findings) and read them by projecting every
  entity and finding into records — seconds on a big graph — on every call.
- **D3 — 185 MB on the wire.** `jsonResponse` indented every body, and nothing was
  compressed. Gzip makes the same snapshot 7.4 MB in under a second.
- **D4 — no snapshot reuse.** `buildWorkspaceUiSnapshot()` was rebuilt from scratch per
  request (and read the graph twice: itself, and again inside `syncWorkflowState`).
- **D5 — every tab fetched and parsed it again.**
- **D6 — tsc on every start** of an unchanged checkout.
- **D7 — no way to keep a project's own bulk trees out of the walks.** The docs scan walks
  the whole project tree on every call; a project's build/tool output (here `work/`, 12k
  files) has no off switch.

## §3 What changed

| D | Change | Where |
|---|---|---|
| D1 | `syncWorkflowState` writes only when the state changed apart from timestamps; an unchanged phase keeps its `lastUpdatedAt` | `project-knowledge/service.ts` |
| D2 | `workflowSignals()`: the phase gates read `records.counts()` plus a new SQL `groundedFindingCount()` (same rule as the projection; checked equal — 7,226 = 7,226 — on the reporting project, 16 ms vs 424 ms); a caller holding a bundle passes it | `service.ts`, `knowledge-graph/records.ts` |
| D3 | compact JSON; `send()` gzips JSON/text bodies ≥ 1 KB when the client accepts gzip | `workspace-ui/server.ts` |
| D4 | `/api/workspace` kept per project until any file in `knowledge/` or `views/` changes size or mtime (the graph's WAL included; `workflow-state.json` excluded as derived); `ETag` + `Cache-Control: no-cache`, `304` on `If-None-Match`; `?fresh=1` forces a rebuild | `workspace-ui/server.ts` |
| D5 | the workbench client keeps the last snapshot with its ETag and shares one in-flight request; an unchanged snapshot comes back as 304 and is not parsed again | `ui/src/workbench/rest-client.ts` |
| D6 | `scripts/build-if-stale.mjs`: build only when `src/`, `tsconfig.json` or `package.json` is newer than the stamp of the last successful build; used by `npm run workspace` and the generated `ui.ps1` (`-NoBuild` still skips the check) | `scripts/`, `package.json`, `project-knowledge/ui-launcher.ts` |
| D7 | `knowledge/inventory-patterns.json` takes `"skipDirs": ["work", "build/out"]` — project-relative directories the registration delta and the docs scan never enter (`intentional` still walks a folder and then ignores what it finds) | `project-knowledge/inventory-patterns.ts`, `lib/registration-delta.ts`, `docs/scan.ts` |

## §4 Result (same project, same machine)

| | before | after |
|---|---|---|
| UI start (`ui.ps1 start`, unchanged checkout) | 11 s build + listen | listen in ~1.5 s |
| `/api/workspace` first request | 21–26 s, 185 MB | 24 s (build), **7.4 MB** gzip |
| `/api/workspace` again, unchanged | 21–26 s, 185 MB | **0.19 s** (cached), or **7 ms / 304** with the ETag |
| `/api/audit` second call | 9.2 s | **1.2 s** (cache hits) |
| `agent_onboard` | 25.5 s | **13.9 s** |
| `project_status` | 8.0 s | **5.7 s** |

The first snapshot build is still the cost of projecting the whole graph and composing every
view; on this project most of that graph is auto-seeded rows from ~600 data files that the
project's contract does not count, which is a project-side fix (`graph_remove_owner`).

## §5 Not done / open

- **D8 dropped — a memo of the full entity / finding projections** (keyed on the graph
  file, cloned per caller). Built and measured: under 0.5 s off `project_status` here,
  because the remaining time is elsewhere. Not worth its memory and clone cost.
- **Per-tab endpoints.** The tabs still take the whole snapshot (now shared, cached and
  compressed). Serving each tab only its part (`views.flowGraph`, `entities`, …) is the
  next step and a larger UI change.
- **What `project_status` still spends** (profile, ~5.7 s): the contract footer's critique
  and slot report (~4 s, which do project entities/findings), the docs scan's tree walk
  (~2.8 s), `loadArtifacts` / `loadFlows` JSON parses (~2 s). A follow-up could cache the
  docs listing by directory mtimes and give the critique the counts it needs.
- `scripts/project-knowledge-smoke.mjs` fails at its clean-audit assertion (`'medium' !==
  'ok'`, line 139) on master as well as on this branch — not caused here.
