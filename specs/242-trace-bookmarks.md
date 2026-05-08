# Spec 242 — Trace bookmarks / annotations

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 trace store
**Master:** 230 / 240

## Goal

Agent (or human) marks points in a trace with a label + free-form
note: "stage-1 handshake start", "crash here", "IRQ-handler entry".
Persisted alongside trace, queryable, displayed in swimlane render.

## Surface (sketch)

```ts
interface TraceBookmark {
  id: string;
  runId: string;
  cycle: number;
  family?: EventFamily;     // optional: tied to specific event
  eventKey?: Record<string, unknown>;
  label: string;
  note?: string;
  authorTag?: "agent" | "human";
  tags?: string[];
}

addBookmark(b: TraceBookmark): void;
listBookmarks(runId: string, range?: [number, number]): TraceBookmark[];
removeBookmark(id: string): void;
```

Storage: DuckDB `trace_bookmarks` table next to event tables.

## Render integration

`SwimlaneSlice` (Spec 234) gains optional `bookmarks` field. Markdown
renderer prepends ▶ row at bookmarked cycles.

## Open questions

- **OQ1:** Do bookmarks bind to (runId, cycle) only, or rebind to
  semantically-equivalent cycle on replay? (= follow event-key
  across runs)
- **OQ2:** Should bookmarks survive `dedupe_artifact_registry` /
  trace eviction?
- **OQ3:** Does each bookmark generate a `save_finding` automatically
  or stays separate from project knowledge?
- **OQ4:** Allow multi-bookmark per cycle, or one-per-cycle?

## Acceptance (draft)

- Add/list/remove bookmarks via API.
- Bookmarks survive scenario re-run when `family + eventKey` set
  and replay is byte-identical (Spec 231).
- Swimlane render highlights bookmarked rows.
