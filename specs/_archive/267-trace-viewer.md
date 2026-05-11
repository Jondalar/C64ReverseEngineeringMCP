# Spec 267 — Trace viewer (swimlane + bookmarks)

**Sprint:** 139
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Parallel-eligible with:** 266

## Goal

Top-level UI tab for browsing event-indexed trace. Embeds
Spec 234 swimlane render + Spec 242 bookmarks layer + filter UI
+ cross-tab drilldown to monitor.

## Layout

```
┌───────────────────────────────────────────────────────┐
│ Cycle range: [0────────●─────●─────] 0..3M             │
│ Families: ☑cpu_step ☑mem_write ☐mem_read ☑irq_assert ...│
│ PC range: [$0000-$FFFF]   Addr range: [$0000-$FFFF]    │
│ Search: [_______________] [find]                       │
├───────────────────────────────────────────────────────┤
│ ▶ Bookmark: "stage-1 handshake start" @cycle=12345    │
│ Swimlane (compact):                                    │
│  cycle  c64_pc  c64_op       bus  drv_pc  drv_op      │
│  100    $E5CD   JSR $FFD2    A--  $E5CD   ...          │
│  ...                                                   │
├───────────────────────────────────────────────────────┤
│ [Add bookmark @ selected]  [Export JSONL]              │
└───────────────────────────────────────────────────────┘
```

## Features

- Cycle slider: scrub through 0..max
- Family checkboxes: 24 V2 EventFamily values
- PC/addr range filters
- Search: PC/value/byte-pattern → jump to first match
- Bookmark layer: ▶ markers at bookmark cycles, click to jump,
  right-click to add
- Cross-tab: click swimlane row → Monitor tab opens at that cycle
- Export JSONL via download button

## Renderer

Wraps Spec 234 `swimlaneSlice` + `renderMarkdown`. UI converts
Markdown to HTML table, virtualized rendering for ≥1000 rows.
Bookmark overlay drawn on top via Spec 242 `listBookmarks`.

## MCP backend

V3 server fetches via:
- `runtime_query_events` (existing)
- `runtime_swimlane_slice` (existing)
- `runtime_bookmark_list` / `_add` (existing)

## Acceptance

- Load motm-full-boot trace (~3M events) → renders without lag
- Filter to cpu_step + mem_write to $0763 → ≤50 rows shown
- Click bookmark → Monitor tab opens at correct cycle
- Add bookmark from trace tab → persists across reload
- Export 1000-row JSONL → file download works
