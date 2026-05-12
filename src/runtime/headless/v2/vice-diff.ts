// Spec 236 — VICE first-divergence diff.
//
// Given a scenarioId, loads vendored baseline traces from
// samples/traces/v2-baseline/<scenarioId>/trace.duckdb (default) or from
// a caller-supplied vicePath, then streams both the VICE-side and the
// headless-side event streams ordered by cycle and returns the first
// EventRow pair that diverges, together with ±20-event context windows.
//
// Resolved decisions:
//   E1: Default = vendored-baseline replay (fast, ms). Live VICE capture
//       only when scenario absent from baseline OR forceLive: true. In V2.x
//       live capture is NOT implemented — a null DivergenceRecord with a
//       diagnostic note is returned instead.
//
// Algorithm:
//   1. Open both DuckDB stores (VICE baseline + headless store).
//   2. For each active EventFamily in parallel, query both sides with
//      optional cycleRange filter.
//   3. Merge all events into a single cycle-ordered stream per side.
//   4. Walk pairs; first family-keyed mismatch → DivergenceRecord.
//   5. Classify the divergence family into one of 8 classification buckets.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { EventFamily, EventRow } from "./trace-events.js";
import { ALL_EVENT_FAMILIES } from "./trace-events.js";
import type { QueryEventsBackend } from "./query-events.js";
import { queryEvents } from "./query-events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DivergenceClassification =
  | "cpu_register"
  | "memory_io"
  | "interrupt_timing"
  | "iec_line"
  | "cia_register"
  | "via_register"
  | "vic_register"
  | "drive_pc"
  | "unknown";

export interface DivergenceContext {
  viceWindow: EventRow[];     // up to 20 events around vice divergence point
  headlessWindow: EventRow[]; // up to 20 events around headless divergence point
  sharedPrefix: number;       // count of cycle-equal, family-equal events before divergence
}

export interface DivergenceRecord {
  scenarioId: string;
  firstDivergeCycle: number;
  divergenceFamily: EventFamily;
  vice: EventRow;
  headless: EventRow;
  context: DivergenceContext;
  classification: DivergenceClassification;
}

export interface DiffQuery {
  /** Scenario name — used to locate samples/traces/v2-baseline/<scenarioId>/ */
  scenarioId: string;
  /** Absolute path to a VICE DuckDB store. Overrides default baseline path. */
  vicePath?: string;
  /** Absolute path to a headless DuckDB store. Required when scenarioId has
   *  no vendored headless store. Falls back to headless-store sub-path in
   *  baseline dir when absent. */
  headlessPath?: string;
  /** Restrict diff to this cycle range [min, max] (inclusive). */
  cycleRange?: [number, number];
  /** Force live VICE capture (V2.x: not implemented — returns null with note). */
  forceLive?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimal subset of a DuckDB instance we need for opening stores. */
export interface DiffBackendFactory {
  /** Open a read-only DuckDB connection to `path` and return a
   *  QueryEventsBackend (with the store's run_id resolved). */
  openReadOnly(path: string): Promise<{ backend: QueryEventsBackend; runId: string; close(): Promise<void> }>;
}

/** Default repo-relative baseline root. */
function defaultBaselineRoot(): string {
  // __dirname equivalent for ESM:
  const selfPath = import.meta.url.replace(/^file:\/\//, "");
  // Navigate from src/runtime/headless/v2 → repo root → samples/traces/v2-baseline
  const repoRoot = resolvePath(selfPath, "../../../../../..");
  return resolvePath(repoRoot, "samples/traces/v2-baseline");
}

/** Classify a diverging family into one of 8 buckets. */
function classifyFamily(family: EventFamily): DivergenceClassification {
  switch (family) {
    case "cpu_step":
    case "cpu_jam":
      return "cpu_register";

    case "mem_read":
    case "mem_write":
    case "mem_indirect_resolve":
      return "memory_io";

    case "irq_assert":
    case "irq_ack":
    case "nmi_assert":
    case "reset_assert":
      return "interrupt_timing";

    case "drive_atn_change":
    case "drive_data_change":
    case "drive_clk_change":
      return "iec_line";

    case "cia_timer_underflow":
    case "cia_register_read":
    case "cia_register_write":
      return "cia_register";

    case "via_timer_underflow":
    case "via_register_read":
    case "via_register_write":
      return "via_register";

    case "vic_badline":
    case "vic_raster_irq":
    case "vic_sprite_collision":
    case "vic_dma_steal":
      return "vic_register";

    case "gcr_byte":
      return "drive_pc";

    default:
      return "unknown";
  }
}

/** Stable key for an EventRow for equality testing (excludes runId). */
function eventKey(e: EventRow): string {
  // Exclude runId — that always differs between vice/headless.
  const { runId: _rid, ...rest } = e as any;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Merge two sorted-by-cycle arrays into a single sorted stream. */
function mergeSorted(a: EventRow[], b: EventRow[]): EventRow[] {
  const out: EventRow[] = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    if (a[ai].cycle <= b[bi].cycle) {
      out.push(a[ai++]);
    } else {
      out.push(b[bi++]);
    }
  }
  while (ai < a.length) out.push(a[ai++]);
  while (bi < b.length) out.push(b[bi++]);
  return out;
}

// ---------------------------------------------------------------------------
// Core diff function
// ---------------------------------------------------------------------------

/**
 * Diff headless trace against VICE baseline.
 *
 * Returns null if no divergence found (traces match within the queried range).
 * Returns null with a console.warn when the scenario has no baseline and live
 * capture is not requested (or requested but unimplemented in V2.x).
 *
 * @param factory  Provides DuckDB connections. Pass a real DuckDbDiffFactory
 *                 in production; pass a synthetic one in tests.
 * @param query    Diff parameters.
 */
export async function diffAgainstVice(
  factory: DiffBackendFactory,
  query: DiffQuery,
): Promise<DivergenceRecord | null> {
  const { scenarioId, vicePath, headlessPath, cycleRange, forceLive } = query;

  // ------------------------------------------------------------------
  // 1. Resolve baseline path
  // ------------------------------------------------------------------
  const baselineRoot = defaultBaselineRoot();
  const scenarioDir = resolvePath(baselineRoot, scenarioId);

  const resolvedVicePath = vicePath
    ? resolvePath(vicePath)
    : resolvePath(scenarioDir, "trace.duckdb");

  const resolvedHeadlessPath = headlessPath
    ? resolvePath(headlessPath)
    : resolvePath(scenarioDir, "headless-store-2026-05-07", "trace.duckdb");

  // ------------------------------------------------------------------
  // 2. Handle missing baseline / live-capture fallback
  // ------------------------------------------------------------------
  if (forceLive) {
    console.warn(
      `[vice-diff] scenario=${scenarioId}: forceLive=true but live VICE capture ` +
      `is not implemented in V2.x. Returning null with diagnostic.`,
    );
    return null;
  }

  if (!existsSync(resolvedVicePath)) {
    console.warn(
      `[vice-diff] scenario=${scenarioId}: no baseline trace at ` +
      `${resolvedVicePath}. Live capture not implemented in V2.x. Returning null.`,
    );
    return null;
  }

  if (!existsSync(resolvedHeadlessPath)) {
    console.warn(
      `[vice-diff] scenario=${scenarioId}: no headless trace at ` +
      `${resolvedHeadlessPath}. Returning null.`,
    );
    return null;
  }

  // ------------------------------------------------------------------
  // 3. Open both stores
  // ------------------------------------------------------------------
  const viceHandle = await factory.openReadOnly(resolvedVicePath);
  const headlessHandle = await factory.openReadOnly(resolvedHeadlessPath);

  try {
    const viceBackend = viceHandle.backend;
    const headlessBackend = headlessHandle.backend;
    const viceRunId = viceHandle.runId;
    const headlessRunId = headlessHandle.runId;

    // ------------------------------------------------------------------
    // 4. Query all active event families from both sides
    // ------------------------------------------------------------------
    const ACTIVE_FAMILIES: EventFamily[] = ALL_EVENT_FAMILIES.filter(
      (f) => !["trap_fire", "hook_audit", "breakpoint_hit", "keyboard_press", "keyboard_release"].includes(f),
    );

    const viceAllEvents: EventRow[] = [];
    const headlessAllEvents: EventRow[] = [];

    await Promise.all(
      ACTIVE_FAMILIES.map(async (family) => {
        const [vRows, hRows] = await Promise.all([
          queryEvents(viceBackend, { runId: viceRunId, family, cycleRange, limit: 100000 }),
          queryEvents(headlessBackend, { runId: headlessRunId, family, cycleRange, limit: 100000 }),
        ]);
        viceAllEvents.push(...vRows);
        headlessAllEvents.push(...hRows);
      }),
    );

    // Sort both streams by cycle, then family (deterministic order).
    const sortFn = (a: EventRow, b: EventRow) =>
      a.cycle !== b.cycle ? a.cycle - b.cycle : a.family.localeCompare(b.family);
    viceAllEvents.sort(sortFn);
    headlessAllEvents.sort(sortFn);

    // ------------------------------------------------------------------
    // 5. Walk pairs, find first mismatch
    // ------------------------------------------------------------------
    const minLen = Math.min(viceAllEvents.length, headlessAllEvents.length);
    let sharedPrefix = 0;

    for (let i = 0; i < minLen; i++) {
      const v = viceAllEvents[i];
      const h = headlessAllEvents[i];

      // Events are "equal" if same cycle + same family + same payload key.
      if (eventKey(v) === eventKey(h)) {
        sharedPrefix++;
        continue;
      }

      // Found the divergence point.
      const divergenceFamily = v.family;
      const classification = classifyFamily(divergenceFamily);

      // Build ±20-event context windows.
      const windowRadius = 20;
      const viceWindow = viceAllEvents.slice(
        Math.max(0, i - windowRadius),
        Math.min(viceAllEvents.length, i + windowRadius + 1),
      );
      const headlessWindow = headlessAllEvents.slice(
        Math.max(0, i - windowRadius),
        Math.min(headlessAllEvents.length, i + windowRadius + 1),
      );

      return {
        scenarioId,
        firstDivergeCycle: v.cycle,
        divergenceFamily,
        vice: v,
        headless: h,
        context: {
          viceWindow,
          headlessWindow,
          sharedPrefix,
        },
        classification,
      };
    }

    // If one side has more events, the extra events are a divergence in count.
    if (viceAllEvents.length !== headlessAllEvents.length) {
      const i = minLen;
      const hasVice = i < viceAllEvents.length;
      // The side with more events has an extra event at position `i`.
      if (hasVice) {
        const v = viceAllEvents[i];
        // Headless is missing this event — synthesize a "null-like" record.
        // We can only provide vice side; headless side uses a cycle-matched
        // sentinel if available.
        const h = headlessAllEvents[i] ?? ({
          runId: headlessRunId,
          cycle: v.cycle,
          family: v.family,
        } as EventRow);

        const divergenceFamily = v.family;
        const classification = classifyFamily(divergenceFamily);
        const windowRadius = 20;
        return {
          scenarioId,
          firstDivergeCycle: v.cycle,
          divergenceFamily,
          vice: v,
          headless: h,
          context: {
            viceWindow: viceAllEvents.slice(Math.max(0, i - windowRadius), i + windowRadius + 1),
            headlessWindow: headlessAllEvents.slice(Math.max(0, i - windowRadius), i + windowRadius + 1),
            sharedPrefix,
          },
          classification,
        };
      } else {
        const h = headlessAllEvents[i];
        const v = viceAllEvents[i] ?? ({
          runId: viceRunId,
          cycle: h.cycle,
          family: h.family,
        } as EventRow);

        const divergenceFamily = h.family;
        const classification = classifyFamily(divergenceFamily);
        const windowRadius = 20;
        return {
          scenarioId,
          firstDivergeCycle: h.cycle,
          divergenceFamily,
          vice: v,
          headless: h,
          context: {
            viceWindow: viceAllEvents.slice(Math.max(0, i - windowRadius), i + windowRadius + 1),
            headlessWindow: headlessAllEvents.slice(Math.max(0, i - windowRadius), i + windowRadius + 1),
            sharedPrefix,
          },
          classification,
        };
      }
    }

    // No divergence in queried range.
    return null;
  } finally {
    await viceHandle.close();
    await headlessHandle.close();
  }
}
