# Spec 266 — Monitor + debugger panel

**Sprint:** 139
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Parallel-eligible with:** 267

## Goal

Combined VICE-monitor command-line + GUI panel. Wraps Spec 248
MonitorAPI + Spec 241 BreakpointManager + Spec 243 RewindManager.
Auto-branch on RAM/reg edits via E4 lock.

## Layout

```
┌──────────────────────────────────────────────────┐
│ [Run] [Pause] [Step] [Over] [Out] [Reset]        │
│ Reg: PC=$E5CD A=42 X=00 Y=00 SP=F8 NV-BDIZC      │
├──────────────┬───────────────────────────────────┤
│ Disasm       │ Memory                            │
│ $E5CD JSR    │ $0400 12 05 0E ...                │
│ $E5D0 LDA #  │ ...                               │
├──────────────┴───────────────────────────────────┤
│ Breakpoints                                      │
│  ☑ bp1 PC=$5000 hits=3                           │
│  ☐ bp2 mem_write @ $0763 (= disabled)            │
├──────────────────────────────────────────────────┤
│ > w $5000 ea ea ea           [submit]            │
└──────────────────────────────────────────────────┘
```

## VICE-syntax commands

Minimum (Spec 248 already supports):
- `r` — registers
- `m <range>` — memory
- `d <addr>` — disasm
- `g <addr>` — goto
- `z` — step
- `n` — step over
- `ret` — step out
- `bk <addr>` — break
- `bk <addr> if <cond>` — conditional
- `watch <addr>` — watchpoint
- `delete <id>` / `disable <id>` / `enable <id>`
- `until <addr>` — run-until

V3 additions:
- `w <addr> <bytes>` — write memory (= triggers PokePatch + branch)
- `r a=<val>` — set register (= PokePatch + branch)
- `bookmark <label>` — add trace bookmark at current cycle

## Auto-branch on edit

Every `w`, `r set`, click-in-memory-and-edit:
1. Construct PokePatch
2. Call `RewindManager.applyPatch(currentSnapshot, [patch])`
3. Snapshots tab tree updates with new branch node
4. Header shows "branch: <8-char-id>" indicator

Edits NEVER lost. User can rewind to root or any branch.

## MCP tool wiring

All buttons + commands route through Spec 237 AgentQueryApi:
- Step buttons → `api.stepInto/stepOver/stepOut`
- Memory write → `api.applyPatch([patch])`
- Breakpoint add → `api.addPcBreakpoint / addBreakpoint`
- Disasm refresh → `api.monitorDisasm(addr, count)`

## Acceptance

- Type `m c000 c0ff` → memory dump shown
- Type `w 5000 ea ea ea` → 3 NOPs at $5000, branch indicator
  appears, snapshots tab gets new node
- Click "Step Over" 10 times → executes 10 instructions safely
- Set conditional breakpoint via `bk $5000 if a > $80` → halts
  when A > 0x80 at PC=$5000
- Reset via toolbar → clean session, snapshots-tab branches kept
