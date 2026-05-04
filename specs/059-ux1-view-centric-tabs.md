# Spec 059 — UX1: view-centric tab structure (16 → 11)

## Problem

The workspace UI currently exposes 16 top-level tabs, with one tab
per knowledge record kind (Entities, Flows, Relations) plus
sibling tabs for derived views (Memory Map, Flow Graph, Annotated
Listing, Load Sequence). Result:

- Entities / Flows / Relations / Load Sequence tabs render raw record
  lists that the user almost never navigates directly. Real
  navigation happens via Memory Map / Flow Graph / Listing / Disk.
- Tab strip wraps onto two rows in the screenshot
  (`2026-05-03 12.23.59`), eats vertical space.
- Same knowledge is reachable through multiple paths — confusing.

## Decision: view-centric organisation

Tabs are organised by what the user is LOOKING AT (memory, code,
disk, cart, graphics), not by what record type they want to inspect.
Knowledge (entities / findings / relations) is surfaced INSIDE every
view via three layered mechanisms (see "Knowledge surfacing" below).

Power-user / debug access to the raw record stores is removed from
the UI entirely. Anyone who needs the JSON dumps reads
`knowledge/*.json` from the filesystem, calls the
`list_findings` / `list_entities` / `list_relations` / `list_flows` MCP
tools, or asks the LLM to summarise into a markdown report on
demand.

## Final tab set (11)

| # | Tab | Notes |
|---|---|---|
| 1 | Dashboard | Counter tiles + recent activity widget folded in. |
| 2 | Questions | Active backlog — keep as own tab; this is workspace, not view. |
| 3 | Docs | Markdown surface, unchanged. |
| 4 | Memory Map | $0000-$FFFF cells, with finding overlays + entity badges. |
| 5 | Graphics | Sprite / charset / bitmap previews + confirm / reject. |
| 6 | Scrub | Free-form memory browser. |
| 7 | Disk | Disk layout, file list, sector heatmap. |
| 8 | Cartridge | Bank / chunk grid (only visible when project has CRT artifacts). |
| 9 | Payloads | What this project loads. UX2 cleanup tracked separately (dedupe + click-to-inspect). |
| 10 | Flow Graph | Three sub-modes: Structure / Load / Runtime — Load mode replaces the standalone Load Sequence tab. |
| 11 | Annotated Listing | Listing entries with overlays for findings + status. |

### Removed

- **Entities** tab — entity lists now live inside the inspector pane
  for any view item; `list_entities` MCP tool covers raw access.
- **Flows** tab — flow records were just the source for Flow Graph;
  now consumed only by the graph builder.
- **Relations** tab — same; relations are edges in the graph.
- **Load Sequence** tab — folded into Flow Graph as the "Load" sub-mode.
- **Recent Activity** tab — collapsed into a compact timeline widget
  on the right side of the Dashboard.

## Knowledge surfacing inside views

Three layered mechanisms apply to every view:

### A. Inspector pane (right)

When the user clicks any view item (memory cell, listing entry, flow
node, disk file, sprite candidate, payload row, cartridge chunk),
the inspector renders a uniform layout:

```
Header:  [item title]            [phase badge] [confirmed/rejected]
Path:    [where this item lives]

Linked Entities (N)
  · entity name (kind)              → click to scope view to entity

Linked Findings (N)
  · finding title (status, conf)    → expand for summary

Linked Relations (N)
  · → target entity (kind)
  · ← source entity (kind)

Linked Artifacts (N)
  · artifact title                  → click opens hex / asm overlay

Actions
  [Open in hex] [Open in listing] [Mark confirmed] [Mark rejected]
  [Save question] [Save finding]
```

Per item-type extras layer on top of the uniform header:
- Memory map cell: RAM / IO / ROM badge, region kind, owning bank.
- Sprite item: 24x21 rendered preview, alignment + density metrics.
- Charset item: 8x8 glyph grid preview.
- Listing entry: instruction count, segment kind, rebuild status.
- Flow node: in/out edges grouped by kind.
- Disk file: sector chain, packer hint, payload entity if linked.
- Cartridge chunk: bank, slot, chip path, payload load address.
- Payload row: load address, depacker chain, ASM artifact ids.

Inspector content always filters via the existing
`LineageVisibilityContext` + `InternalVisibilityContext` so the lists
honour the header toggles.

### B. Overlays / badges on view items

Visual-scan affordances on the items themselves:
- Memory Map cell: corner badge `N` for finding count; cell border
  colour for confidence.
- Listing entry: status icon (annotated, confirmed, rejected, blocked).
- Flow Graph node: confidence colour ring; selection highlights linked
  edges.
- Disk file row: hint colour overlay (drive-code, protected,
  raw-unanalyzed, bad-crc, gap — Spec 037).
- Graphics item: confirmed / rejected bucket border; finding count
  badge.
- Cartridge chunk: phase badge; payload-linked indicator.
- Payload row: phase badge; depacker chip.

Hover tooltip on every overlay shows summary (top finding title,
confidence, status).

### C. Filter facets per view

Side-rail with view-specific facets, all defaulting to "show
everything":
- Memory Map: filter by region kind, by entity kind, by finding
  status, by confidence threshold.
- Flow Graph: filter by node kind, by edge kind, by confidence,
  by phase.
- Annotated Listing: by segment kind, by finding presence, by status.
- Disk: by file kind, by hint, by extracted vs raw.
- Graphics: existing `Hide rejected` toggle plus `Hide unconfirmed`.
- Payloads: by load address range, by packer, by phase.

Filter selections persist per view in URL query string so links
share state.

## Migration

Big bang: one PR removes the four standalone tabs (Entities, Flows,
Relations, Load Sequence), folds Recent Activity into Dashboard,
adds the Flow-Graph "Load" sub-mode, and lands the inspector +
overlay + filter wiring for every remaining view.

Risk acceptance: feature branch, two-person team. No staged rollout
needed.

## Out of scope

- UX2 (Payloads dedupe + click-to-inspect pattern) tracked as separate
  spec.
- Sprint to add filter facets to ALL views — first pass ships only the
  inspector + overlays for every view, plus filters for the views that
  most benefit (Memory Map, Flow Graph, Annotated Listing). Other views
  get filters in a follow-up sprint.
- Server-side endpoint changes — the existing `/api/findings`,
  `/api/entities`, `/api/relations`, `/api/flows` endpoints stay; they
  become consumed by inspector / overlay / filter logic instead of by
  standalone tabs.

## Cross-reference

- UX2: Payloads tab cleanup. Same screenshot batch.
- Spec 054 (Bug 24): latest-version-per-lineage filter. Inspector
  + overlay paths must respect `LineageVisibilityContext`.
- Spec 058 (Bug 26): hide-internal-files filter. Same — respect
  `InternalVisibilityContext`.
- Spec 050 (Sprint 43): UI phase badges + quality columns + heatmap
  overlay. Spec 059 reuses badge components for the inspector header
  and overlay layer.
- Spec 051 (Sprint 44): annotation draft viewer side-panel. Lives
  inside Listing tab; survives the consolidation unchanged.
