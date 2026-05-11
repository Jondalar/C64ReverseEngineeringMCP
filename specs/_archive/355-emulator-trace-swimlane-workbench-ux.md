# Spec 355 — Emulator trace swimlane workbench UX

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 217, 234, 242, 350

## Goal

Provide a dedicated Trace tab for zoomable runtime evidence. This is a
normal reverse-engineering tool, not a one-off debug export. It should
make transaction-by-transaction questions answerable without reading
gigabytes of JSONL.

## Top-level placement

The Emulator Workbench has exactly two top-level tabs in this UX cut:

- `Live`
- `Trace`

Trace gets its own tab because swimlanes require horizontal and vertical
space.

## Core layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Trace                                                                      │
│ range [────────────] families [cpu][vic][cia][iec][drive] search [...]      │
├────────────────────────────────────────────────────────────────────────────┤
│ Overview timeline / rollup                                                 │
├────────────────────────────────────────────────────────────────────────────┤
│ CPU       ──instr──────instr──────irq────────────                           │
│ VIC       ─badline────raster irq────dma steal────                           │
│ CIA1      ─timer────keyboard────irq────────────                             │
│ CIA2/IEC  ─dd00────ATN────CLK────DATA────byte────                           │
│ 1541 CPU  ─instr────via irq────gcr────                                      │
│ Drive     ─motor────track────sync────byte────                               │
├────────────────────────────────────────────────────────────────────────────┤
│ selected event details / bookmarks / jump actions                           │
└────────────────────────────────────────────────────────────────────────────┘
```

## Required abilities

- Zoom out to rollups.
- Zoom in to instruction/event-level detail.
- Filter by event family.
- Filter by C64 PC, drive PC, memory address, IO address, and cycle
  range where trace data supports it.
- Search for PC/address/value patterns.
- Select an event/transaction.
- Add bookmark at selected cycle.
- Jump from selected event to Live/Monitor context when runtime state is
  available.
- Export selected slice, not the whole raw trace by default.

## Lanes

Minimum visible lanes:

- C64 CPU
- VIC
- CIA1
- CIA2 / IEC
- 1541 CPU
- VIA
- Drive media/GCR
- Bookmarks

The UI may collapse lanes, but the canonical C64/1541 transaction view
must remain available.

## Backend expectations

Trace UI should prefer DuckDB-backed trace queries from Spec 217 instead
of raw JSONL scans.

It consumes:

- rollup queries;
- bounded event slice queries;
- swimlane transaction queries from Spec 234;
- bookmarks from Spec 242.

If trace backend is not configured, show a clear empty state with what
is missing and how to enable it. Do not render a raw red exception as
the main view.

## Acceptance

- Trace tab opens without raw backend exceptions.
- A configured trace run shows overview rollups and swimlanes.
- Selecting an event shows details and offers bookmark creation.
- Filtered slice export works for a bounded range.
- Trace selection can jump to monitor/live context once runtime state
  lookup exists.
