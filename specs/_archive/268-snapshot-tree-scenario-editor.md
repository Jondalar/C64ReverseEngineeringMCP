# Spec 268 — Snapshot tree + scenario editor

**Sprint:** 140
**Status:** PROPOSED 2026-05-09
**Master:** 260

## Goal

Branch-tree visualization of Spec 243 RewindManager state +
full scenario editor (Spec 231). Auto-branch nodes from monitor
RAM/reg edits (Spec 266) appear here. Promote branch → scenario.

## Snapshot tree panel

D3-style horizontal tree:
- Root = scenario start snapshot
- Internal nodes = applyPatch / runForward results
- Leaves = current frontier
- Node hover: cycle, label, patches (if any), child count
- Node click: restore to that snapshot (= session jumps)
- Right-click: "promote to scenario" / "delete subtree" / "diff to..."
- Pin button: lock node from ring eviction
- Color: leaf=green, internal=gray, current=yellow highlight

```
┌──────────────────────────┬─────────────────────────────┐
│ Tree (~30%)              │ Selected node detail (~70%) │
│  root                    │   Snapshot: bb-3a1f         │
│   ├ b1 (patch $0763=$11) │   Cycle: 1234567            │
│   │   └ b2 (run 50000)   │   Patches: [mem_byte $0763] │
│   └ b3 (run 100000)      │   Children: 1               │
│                          │   [Restore] [Promote] [Pin] │
│                          │   RAM diff vs root: 23 bytes│
└──────────────────────────┴─────────────────────────────┘
```

## Scenario editor panel

```
┌───────────────────────────────────────────────────────┐
│ Scenarios in project: [list]                          │
│  ✓ motm-stage-1                                       │
│  ✓ motm-bug-repro-0763                                │
│  ✓ mm-s1-boot                                         │
├───────────────────────────────────────────────────────┤
│ Selected: motm-stage-1                                │
│  diskPath: samples/motm.g64                           │
│  mode: true-drive                                     │
│  cycleBudget: 5000000                                 │
│  inputs (3): [timeline editor]                        │
│   ▎@cycle=1500000 keyboard "LOAD\\"*\\",8,1\\r"           │
│   ▎@cycle=2500000 keyboard "RUN\\r"                    │
│   ▎@cycle=4000000 joystick port=2 fire                │
│  [Add input] [Reorder] [Delete]                       │
├───────────────────────────────────────────────────────┤
│ [Replay] [Fork] [Compare to...] [Delete scenario]     │
└───────────────────────────────────────────────────────┘
```

## Features

- Scenario list: filter, search by name, sort by date
- Editor: timeline drag-to-retime inputs, add/remove
- Fork: "save as new scenario, base on current state" — uses
  Spec 243 promoteBranch
- Replay: calls `runScenario` → result shown in main Live tab
- Compare: 2 scenarios → side-by-side hash diff (Spec 231 result)

## MCP wiring

- `runtime_snapshot_tree` (new) — returns full RewindHandle.branches
- `runtime_promote_branch <branchId>` (new) — wraps promoteBranch
- `runtime_scenario_list` / `_save` / `_delete` (new)
- `runtime_run_scenario` (existing) — replay
- Monitor edits already trigger applyPatch → tree auto-updates

## Acceptance

- Open snapshots tab during motm session → root + any branches
  rendered as tree
- Make 5 RAM edits via monitor → 5 branch nodes appear
- Right-click branch → "promote to scenario" → new entry in
  scenario list
- Edit scenario inputs → save → replay produces different result
- Compare two scenarios shows hash diff
