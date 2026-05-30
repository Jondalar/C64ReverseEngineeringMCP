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
| Scrub + Reclassify | no | `/api/artifact/raw` + `/api/scrub/annotate-segment` + `/api/segment/{confirm,reject}` | Media ▸ Assets / Scrub | DONE 724B.3 |

## 724B.3 — Scrub / Reclassify (human workbench, not dev-only)

Correction: Scrub + reclassify are HUMAN-WORKBENCH tools for the MCP user
(view bitmap/asset, validate extraction/disasm output, classify/re-classify),
not dev-only. They are now in the v3 shell as the **Assets / Scrub** tab, reusing
the shared `C64GraphicsView` decoder (`ui/src/components`) + the existing HTTP API:

- **View:** graphics-candidate list (`/api/graphics`).
- **Reclassify heuristic output:** Confirm / Reject a candidate segment
  (`/api/segment/confirm` · `/api/segment/reject`) — writes back to the project.
- **Scrub:** pick a PRG/CRT/raw, scroll the offset (`/api/artifact/raw` byte
  slice), render any slice as sprite / charset / hires-bitmap / multicolor-bitmap
  via the shared decoder.
- **Annotate (authoring):** save the current window as a graphics segment into
  `<prg>_annotations.json` (`/api/scrub/annotate-segment`) — picked up by the next
  `disasm_prg`. Result visible in the project (annotations file + next analysis).

## Migration shape

v3 tabs reuse the existing HTTP API + the shared graphics decoder — no second
project logic, project path from the 724A resolver. Read tabs render view models;
the Assets tab additionally writes (confirm/reject/annotate) through the SAME
endpoints v1 used.

## v1 retirement decision

After 724B.3: every v1 screen — including the interactive Scrub + reclassify
authoring — is reachable in the v3 shell. Normal human-workbench operation no
longer needs v1 at all. The v1 entry is kept (not deleted, no capability lost)
but flagged legacy; it can be redirected to v3 in a later cleanup.
