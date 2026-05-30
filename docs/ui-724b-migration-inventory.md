# Spec 724B — v1 → v3 One-UI migration inventory

Read-only consolidation. Every v1 screen's data is already exposed by the
workspace-ui HTTP API (`/api/workspace` snapshot views + `/api/docs` +
`/api/graphics`), so the v3 tabs render the SAME project model — no new heavy
endpoint, no runtime, no raw SQL, project path from the 724A resolver.

| v1 screen | in v3 (724B.1)? | backend (read-only) | v3 target group/tab | status |
|---|---|---|---|---|
| Dashboard | yes | `/api/workspace` `.views.projectDashboard` | Project ▸ Knowledge | DONE 724B.1 |
| Findings | yes | `/api/workspace` `.findings` | Project ▸ Knowledge | DONE 724B.1 |
| Entities | yes | `/api/workspace` `.entities` | Project ▸ Knowledge | DONE 724B.1 |
| Trace marks/PCs/events | yes (new) | `/api/traces`, `/api/trace/*` | Project ▸ Trace Files | DONE 724B.1 |
| Questions | no | `/api/workspace` `.openQuestions` | Project ▸ Knowledge | DONE 724B.2 |
| Docs | no | `/api/docs` + `/api/document` | Project ▸ Docs | DONE 724B.2 |
| Memory Map | no | `/api/workspace` `.views.memoryMap` | Analysis ▸ Memory Map | DONE 724B.2 |
| Payloads | no | `/api/workspace` `.views.loadSequence` + `.artifacts` | Analysis ▸ Payloads | DONE 724B.2 |
| Annotated Listing | no | `/api/workspace` `.views.annotatedListing` | Analysis ▸ Annotated Listing | DONE 724B.2 |
| Flow Graph | no | `/api/workspace` `.views.flowGraph` + `.flows` | Analysis ▸ Flow Graph | DONE 724B.2 |
| Disk | no | `/api/workspace` `.views.diskLayout` | Media ▸ Disk | DONE 724B.2 |
| Cartridge | no | `/api/workspace` `.views.cartridgeLayout` | Media ▸ Cartridge | DONE 724B.2 |
| Graphics | no | `/api/graphics` | Media ▸ Graphics | DONE 724B.2 |
| Scrub | n/a | (segment-annotate editor) | — | NOT migrated (interactive editor; v1 dev-only) |

## Migration shape

v3 read-only tabs render the existing view models + knowledge lists. They show
the data and link artifacts; they do NOT reimplement v1's interactive editors
(Scrub segment-annotate, in-place re-classify). Those stay v1-only / dev-only —
they are authoring tools, not normal product viewing, and are out of the 724B
"make the project state visible in one shell" scope.

## v1 retirement decision

After 724B.2: every v1 VIEW screen is reachable in the v3 shell. The v1 entry is
kept but marked legacy/dev-only (interactive authoring: Scrub, in-place
annotation editing). Normal product viewing no longer needs v1.
