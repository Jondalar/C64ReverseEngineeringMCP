# Workspace UI Spike

## Purpose

This spike adds a visible end-to-end workspace viewer on top of the Project Knowledge Layer.

It is intentionally thin:

- the backend still owns knowledge, evidence, and view derivation
- the UI consumes a stable workspace snapshot from `/api/workspace`
- React does not reinterpret reverse-engineering outputs on its own

## Pieces

1. `src/workspace-ui/server.ts`
   Small local HTTP server.
   Exposes:
   - `/api/config`
   - `/api/workspace?projectDir=...`
   - static delivery of `ui/dist` after build

2. `ui/`
   Vite + React spike application.
   Renders:
   - dashboard metrics
   - open tasks / open questions / recent findings
   - memory map
   - cartridge layout
   - disk layout
   - flow graph overview
   - annotated listing
   - entity inspector

3. `ProjectKnowledgeService.buildWorkspaceUiSnapshot()`
   Builds a no-side-effect snapshot for UI use.
   This is important: UI refreshes do not append timeline events.

## Commands

Use the seeded example project:

```bash
npm run refresh:example-example
npm run ui:build
npm run ui:serve -- --project examples/example-project
```

Then open:

- `http://127.0.0.1:4310`

For local UI iteration in two terminals:

```bash
npm run ui:api
npm run ui:dev
```

Then open:

- `http://127.0.0.1:4311`

## Design Notes

- The visual shell borrows layout spirit from `/Users/alex/Development/easyflash_image_builder`, especially the panel/grid vocabulary, but not its cartridge-builder domain logic.
- The current UI is a spike, not a finished product.
- It is meant to answer one question quickly: does a persisted project-centric RE workspace feel materially more useful than tool-by-tool terminal output?

## Next Likely Steps

1. Add deep-linking into artifacts and evidence.
2. Add relation and finding drill-down views.
3. Add project switcher / recent projects.
4. Add screenshot- and export-friendly report layouts.
