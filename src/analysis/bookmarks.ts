// Spec 242 — Trace bookmarks / annotations.
//
// Bookmarks persist alongside the trace in the DuckDB `trace_bookmarks`
// table (created in applySchema). Each bookmark is tied to a cycle and
// optionally to a specific event via family + event_key (JSON). The
// bind_mode controls how the bookmark is re-resolved across replays:
//   "cycle"     — cycle number is canonical; never re-resolved.
//   "event-key" — re-resolve by matching family + event_key in new run.
//   "both"      — primary: event-key match; fallback: cycle.

import { randomUUID } from "node:crypto";
import type { EventFamily } from "./trace-events.js";

// ---- Public types ----

export type BindMode = "cycle" | "event-key" | "both";

export interface TraceBookmark {
  id: string;
  runId: string;
  cycle: number;
  family?: EventFamily;
  /** Serialised JSON object — key fields that identify the event. */
  eventKey?: Record<string, unknown>;
  label: string;
  note?: string;
  authorTag?: "agent" | "human";
  tags?: string[];
  bindMode: BindMode;
}

// ---- Backend interface (matches DuckDbQueryBackend) ----

export interface BookmarkBackend {
  exec(sql: string, params: unknown[]): Promise<any[]>;
}

// ---- Helpers ----

/** Inline a single param for DuckDB SQL (mirrors duckdb-backend.ts). */
function inline(p: unknown): string {
  if (p === null || p === undefined) return "NULL";
  if (typeof p === "number") return String(p);
  if (typeof p === "bigint") return p.toString();
  if (typeof p === "boolean") return p ? "TRUE" : "FALSE";
  if (typeof p === "string") return `'${p.replace(/'/g, "''")}'`;
  throw new Error(`unsupported param type: ${typeof p}`);
}

function normaliseTags(raw: unknown): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  // DuckDB node-api returns TEXT[] columns as { items: string[] }
  if (typeof raw === "object" && !Array.isArray(raw) && raw !== null) {
    const items = (raw as any).items;
    if (Array.isArray(items)) return items as string[];
  }
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as string[]; } catch { return undefined; }
  }
  return undefined;
}

function rowToBookmark(r: any): TraceBookmark {
  return {
    id:        String(r.id),
    runId:     String(r.run_id),
    cycle:     Number(r.cycle),
    family:    r.family ?? undefined,
    eventKey:  r.event_key ? JSON.parse(r.event_key) : undefined,
    label:     String(r.label),
    note:      r.note ?? undefined,
    authorTag: (r.author_tag as "agent" | "human") ?? undefined,
    tags:      normaliseTags(r.tags),
    bindMode:  (r.bind_mode ?? "both") as BindMode,
  };
}

// ---- API ----

/**
 * Persist a new bookmark. `id` is generated if not supplied.
 * Returns the assigned id.
 */
export async function addBookmark(
  backend: BookmarkBackend,
  b: Omit<TraceBookmark, "id"> & { id?: string },
): Promise<string> {
  const id = b.id ?? randomUUID();
  const bindMode: BindMode = b.bindMode ?? "both";
  const eventKeyJson = b.eventKey ? JSON.stringify(b.eventKey) : null;

  // DuckDB native array literal — cannot use inline() for arrays.
  const tagsLiteral = b.tags && b.tags.length > 0
    ? `[${b.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ")}]`
    : "NULL::TEXT[]";

  const sql = `
    INSERT INTO trace_bookmarks
      (run_id, id, cycle, family, event_key, label, note, author_tag, tags, bind_mode)
    VALUES (
      ${inline(b.runId)},
      ${inline(id)},
      ${inline(b.cycle)},
      ${inline(b.family ?? null)},
      ${inline(eventKeyJson)},
      ${inline(b.label)},
      ${inline(b.note ?? null)},
      ${inline(b.authorTag ?? null)},
      ${tagsLiteral},
      ${inline(bindMode)}
    )
  `;

  await backend.exec(sql, []);
  return id;
}

/**
 * List bookmarks for a run, optionally filtered by cycle range.
 * Results are sorted ascending by cycle.
 */
export async function listBookmarks(
  backend: BookmarkBackend,
  runId: string,
  range?: [number, number],
): Promise<TraceBookmark[]> {
  let where = `run_id = ${inline(runId)}`;
  if (range) {
    where += ` AND cycle BETWEEN ${inline(range[0])} AND ${inline(range[1])}`;
  }
  const sql = `SELECT * FROM trace_bookmarks WHERE ${where} ORDER BY cycle`;
  const rows = await backend.exec(sql, []);
  return rows.map(rowToBookmark);
}

/**
 * Remove a bookmark by id. No-op if not found.
 */
export async function removeBookmark(
  backend: BookmarkBackend,
  id: string,
): Promise<void> {
  await backend.exec(`DELETE FROM trace_bookmarks WHERE id = ${inline(id)}`, []);
}

/**
 * Re-bind a bookmark to a different run.
 *
 * Strategy per bindMode:
 *   "cycle"     — only updates run_id (cycle unchanged).
 *   "event-key" — finds matching event in new run by family + event_key;
 *                 updates run_id + cycle. Throws if no match.
 *   "both"      — tries event-key first; falls back to cycle-only if
 *                 no match found (no throw on fallback).
 *
 * The caller must supply a `resolveEventCycle` function that searches
 * the new run's event tables for the matching event. Returning null
 * means "no match found".
 */
export async function rebindBookmark(
  backend: BookmarkBackend,
  id: string,
  newRunId: string,
  resolveEventCycle: (
    family: EventFamily,
    eventKey: Record<string, unknown>,
    runId: string,
  ) => Promise<number | null>,
): Promise<{ cycle: number; resolved: "event-key" | "cycle" }> {
  const rows = await backend.exec(
    `SELECT * FROM trace_bookmarks WHERE id = ${inline(id)}`,
    [],
  );
  if (rows.length === 0) throw new Error(`bookmark not found: ${id}`);
  const bm = rowToBookmark(rows[0]);

  let newCycle = bm.cycle;
  let resolved: "event-key" | "cycle" = "cycle";

  if (bm.bindMode !== "cycle" && bm.family && bm.eventKey) {
    const found = await resolveEventCycle(bm.family, bm.eventKey, newRunId);
    if (found !== null) {
      newCycle = found;
      resolved = "event-key";
    } else if (bm.bindMode === "event-key") {
      throw new Error(
        `rebindBookmark: no matching event found in run ${newRunId} for ` +
        `family=${bm.family} key=${JSON.stringify(bm.eventKey)}`,
      );
    }
    // "both" + no match → fall through with original cycle
  }

  await backend.exec(
    `UPDATE trace_bookmarks SET run_id = ${inline(newRunId)}, cycle = ${inline(newCycle)} WHERE id = ${inline(id)}`,
    [],
  );

  return { cycle: newCycle, resolved };
}
