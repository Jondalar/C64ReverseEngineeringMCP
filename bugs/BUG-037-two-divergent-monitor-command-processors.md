# Bug: Two divergent monitor command processors with disagreeing command sets

- **ID:** BUG-037
- **Date:** 2026-06-03
- **Reporter:** llm (recon during monitor-concept review)
- **Area:** ui-v3
- **Severity:** medium (duplication + inconsistent behaviour; blocks building richer commands cleanly)
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened
There are **two separate monitor command processors** with overlapping-but-different
command sets and transports:

1. **Live path (canonical, in use):** `MonitorPanel` (mounted in the Live tab,
   `ui/src/v3/tabs/Live.tsx`) → WS `monitor/exec` → a VICE-syntax parser in
   `src/workspace-ui/v3-ws-server.ts:~1633`. Handles `r/m/d/bk/z/n/until/delete/
   dump/undump/trace/tracedb`.
2. **Second path:** a `Monitor.tsx` tab + `ui/src/v3/monitor-cmd-parser.ts` →
   WS `runtime/call` → `AgentQueryApi`. Handles `r/m/d/g/z/n/ret/until/w/bk/watch/
   delete/disable/enable/bookmark` — but NOT `dump/undump`, and `g` is goto-only.

The two parsers disagree (e.g. `dump`/`undump` exist in #1 not #2; the breakpoint/
watch verbs differ; `g` semantics differ). Same conceptual "monitor", two
implementations, two grammars to maintain — and the command a user gets depends on
which component is mounted.

## Expected
ONE canonical monitor command processor + grammar, behind one transport, reused by
whatever UI surface shows a monitor. Consolidate per the "one UI shell — integrate,
don't delete" doctrine (Spec 724.2): keep all working commands, retire the duplicate
parser, single source of truth for the command table.

## Repro steps
1. Inspect `v3-ws-server.ts` `monitor/exec` handler vs `ui/src/v3/monitor-cmd-parser.ts`.
2. Note the two command tables differ (dump/undump only in one; g semantics differ).
3. The live workbench uses `MonitorPanel`→`monitor/exec`; the `Monitor.tsx` tab uses
   the other → typing the same command in each can behave differently.

## Evidence
- Backend VICE parser: `src/workspace-ui/v3-ws-server.ts:~1633` (`this.on("monitor/exec", ...)`).
- UI-side parser: `ui/src/v3/monitor-cmd-parser.ts` (command table ~66–195) +
  `ui/src/v3/tabs/Monitor.tsx` dispatch (~170–339, `runtime/call`).
- Live mount: `ui/src/v3/tabs/Live.tsx` imports `MonitorPanel` (→ `monitor/exec`),
  with a fallback note "monitor/exec may not exist yet — fall back to inline parser"
  (`ui/src/v3/components/MonitorPanel.tsx:~68`).

## Notes
This is the prerequisite cleanup for the monitor-evolution spec: build richer
commands on ONE parser, not two.
