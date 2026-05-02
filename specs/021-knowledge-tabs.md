# Spec 021: Knowledge Visibility Tabs (Findings, Entities, Flows, Relations)

## Problem

The structured knowledge layer (`save_finding`, `save_entity`,
`save_flow`, `save_relation`) is the unique value of c64re over
plain disassembly, yet it is invisible in the workspace UI. The Docs
tab renders Markdown only; findings/entities/flows/relations live in
JSON with no rendering surface. BUGREPORT Bug 15, REQUIREMENTS R12,
supersedes R10's markdown-render approach.

## Goal

A user can browse, filter, sort, and inspect every finding, entity,
flow, and relation in a project from the workspace UI without
running an external doc renderer. Cross-link from finding evidence
to the matching listing artifact at the right line.

## Approach

### Server endpoints

Add to `src/workspace-ui/server.ts`:

- `GET /api/findings?projectDir=...` → `{ items: FindingRecord[] }`
- `GET /api/entities?projectDir=...` → `{ items: EntityRecord[] }`
- `GET /api/flows?projectDir=...` → `{ items: FlowRecord[] }`
- `GET /api/relations?projectDir=...` → `{ items: RelationRecord[] }`

Each endpoint reads the corresponding `knowledge/*.json` store via
the existing storage helpers. Pagination optional in v1; use
client-side virtualisation instead.

### UI tabs

Add to `ui/src/App.tsx`:

- **Findings** tab — virtualised table with columns `title`, `kind`,
  `status`, `confidence`, `tags`, `evidence count`, `linked artifacts`.
  Filter by status/kind/tag. Sort by confidence/title/kind. Detail
  card on row click: body, evidence excerpts (with file + line link),
  linked entity/artifact ids.
- **Entities** tab — virtualised table with columns `name`, `kind`,
  `addressRange`, `confidence`, `tags`. Filter by kind. Detail card
  with linked findings, source artifacts, payload metadata if
  present.
- **Flows** tab — table + detail card. v1 renders flow steps as a
  numbered list; sequence-diagram view deferred.
- **Relations** tab — table with `source → target` columns. v1 renders
  as a list; graph view deferred.

### Cross-link to listing

Evidence rows that carry `artifactId` + `lineRange` link to the
existing listing inspector and scroll it to the right line. Reuse
the path the disk-file inspector already uses to open `*_disasm.asm`
artifacts.

### Virtualisation

Use a simple windowed list (intersection-observer or fixed row
height + offset math). Cap visible rows at 500 with a
`Refine filter to see more` hint when truncated, matching the
existing Questions tab pattern.

## Acceptance Criteria

- Opening the BWC project shows 2814 findings, 4499 entities, 376
  flows, 546 relations in their respective tabs without a separate
  build step.
- The UI stays responsive (interaction <100ms) when scrolling
  through 4000+ rows.
- Clicking a finding's evidence row opens the linked listing
  artifact at the right line.

## Tests

- Smoke: bootstrap the fixture project (Sprint 14), assert each
  endpoint returns the expected counts.
- Smoke: open every tab and assert no console error and at least one
  row renders for the BWC project.

## Out Of Scope

- Sequence diagrams for flows.
- Graph view for relations.
- R10 markdown export. Revisit only if exporting to an external doc
  system becomes a real requirement.

## Dependencies

- None (server + UI only). Land independently of Sprint 16/17.
