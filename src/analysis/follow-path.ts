// Spec 233 — Follow-a-path tracing.
//
// Given an end event, walks backwards through the causal chain using
// five causality rules: pc_predecessor, stack_frame, mem_dep,
// irq_origin, io_dep.  Cross-domain bridge via IEC line events.

import type { EventFamily, EventRow } from "./trace-events.js";
import type { QueryEventsBackend } from "./query-events.js";
import { queryEvents } from "./query-events.js";

// ---- Public types --------------------------------------------------------

export interface PathQuery {
  runId: string;
  endEventCycle: number;
  endEventFamily: EventFamily;
  /** Family-specific predicate fields matched against the end event. */
  endEventKey: Record<string, unknown>;
  maxDepth?: number;
  cycleWindow?: number;
  /** Default true — recurse c64↔drive across IEC line events. */
  crossDomain?: boolean;
}

export interface PathStep {
  rule: "pc_predecessor" | "stack_frame" | "mem_dep" | "irq_origin" | "io_dep";
  event: EventRow;
  reason: string;
}

export interface PathChain {
  /** Steps ordered earliest first; last step is the end event itself. */
  steps: PathStep[];
  truncated: boolean;
}

// ---- IEC boundary families -----------------------------------------------

const IEC_FAMILIES: ReadonlySet<EventFamily> = new Set([
  "drive_atn_change",
  "drive_clk_change",
  "drive_data_change",
]);

// ---- IO register ranges --------------------------------------------------

function isIoAddress(addr: number): boolean {
  // VIC $D000-$D3FF, SID $D400-$D7FF, CIA1 $DC00-$DCFF, CIA2 $DD00-$DDFF
  return (addr >= 0xd000 && addr <= 0xddff);
}

function isStackAddress(addr: number): boolean {
  return addr >= 0x0100 && addr <= 0x01ff;
}

// ---- Row predicate matching ----------------------------------------------

function rowMatchesKey(row: EventRow, key: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(key)) {
    if ((row as any)[k] !== v) return false;
  }
  return true;
}

// ---- Helpers for querying backwards ---------------------------------------

async function findEndEvent(
  backend: QueryEventsBackend,
  runId: string,
  family: EventFamily,
  cycle: number,
  key: Record<string, unknown>,
): Promise<EventRow | null> {
  // Query a small window around the given cycle to locate the event.
  const window = 32;
  const rows = await queryEvents(backend, {
    runId,
    family,
    cycleRange: [cycle - window, cycle + window],
    limit: 200,
  });
  for (const row of rows) {
    if (row.cycle === cycle && rowMatchesKey(row, key)) return row;
  }
  // Relax: just match cycle
  for (const row of rows) {
    if (row.cycle === cycle) return row;
  }
  return null;
}

async function lastCpuStepBefore(
  backend: QueryEventsBackend,
  runId: string,
  beforeCycle: number,
  cycleFloor: number,
): Promise<EventRow | null> {
  const rows = await queryEvents(backend, {
    runId,
    family: "cpu_step",
    cycleRange: [cycleFloor, beforeCycle - 1],
    limit: 10000,
  });
  if (rows.length === 0) return null;
  // Return the last one (rows ordered by clock ASC)
  return rows[rows.length - 1];
}

async function lastMemWriteBefore(
  backend: QueryEventsBackend,
  runId: string,
  addr: number,
  beforeCycle: number,
  cycleFloor: number,
): Promise<EventRow | null> {
  const rows = await queryEvents(backend, {
    runId,
    family: "mem_write",
    addrRange: [addr, addr],
    cycleRange: [cycleFloor, beforeCycle - 1],
    limit: 10000,
  });
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}

async function lastIrqAssertBefore(
  backend: QueryEventsBackend,
  runId: string,
  beforeCycle: number,
  cycleFloor: number,
): Promise<EventRow | null> {
  const rows = await queryEvents(backend, {
    runId,
    family: "irq_assert",
    cycleRange: [cycleFloor, beforeCycle - 1],
    limit: 10000,
  });
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}

async function lastIecChangeBefore(
  backend: QueryEventsBackend,
  runId: string,
  beforeCycle: number,
  cycleFloor: number,
): Promise<EventRow | null> {
  // Try all three IEC line families, pick the latest.
  const families: EventFamily[] = ["drive_atn_change", "drive_clk_change", "drive_data_change"];
  let best: EventRow | null = null;
  for (const fam of families) {
    const rows = await queryEvents(backend, {
      runId,
      family: fam,
      cycleRange: [cycleFloor, beforeCycle - 1],
      limit: 10000,
    });
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (!best || last.cycle > best.cycle) best = last;
    }
  }
  return best;
}

async function lastStackWriteBefore(
  backend: QueryEventsBackend,
  runId: string,
  beforeCycle: number,
  cycleFloor: number,
): Promise<EventRow | null> {
  // Find the most recent mem_write to stack region.
  const rows = await queryEvents(backend, {
    runId,
    family: "mem_write",
    addrRange: [0x0100, 0x01ff],
    cycleRange: [cycleFloor, beforeCycle - 1],
    limit: 10000,
  });
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}

// ---- Causality rules for a given event -----------------------------------

interface RuleResult {
  rule: PathStep["rule"];
  event: EventRow;
  reason: string;
}

async function applyRules(
  backend: QueryEventsBackend,
  runId: string,
  currentRow: EventRow,
  cycleFloor: number,
  crossDomain: boolean,
): Promise<RuleResult | null> {
  const cycle = currentRow.cycle;
  const family = currentRow.family;

  // Rule 1: pc_predecessor — last cpu_step before this event.
  // Always applicable for events that have a pc field.
  if (family === "cpu_step" || family === "mem_write" || family === "mem_read") {
    const pred = await lastCpuStepBefore(backend, runId, cycle, cycleFloor);
    if (pred) {
      const pcHex = `$${(pred as any).pc?.toString(16).toUpperCase().padStart(4, "0") ?? "????"}`;
      return {
        rule: "pc_predecessor",
        event: pred,
        reason: `PC predecessor: last cpu_step at cycle ${pred.cycle} (PC=${pcHex}) before ${family} at cycle ${cycle}`,
      };
    }
  }

  // Rule 5: io_dep — if reading an IO register, find last register write.
  if (family === "mem_read") {
    const row = currentRow as { addr?: number };
    if (row.addr !== undefined && isIoAddress(row.addr)) {
      const addrHex = `$${row.addr.toString(16).toUpperCase().padStart(4, "0")}`;
      const writer = await lastMemWriteBefore(backend, runId, row.addr, cycle, cycleFloor);
      if (writer) {
        return {
          rule: "io_dep",
          event: writer,
          reason: `IO dependency: mem_read from ${addrHex} at cycle ${cycle} depends on mem_write at cycle ${writer.cycle}`,
        };
      }
      // Try cross-domain: IEC line change
      if (crossDomain && row.addr >= 0xdc00 && row.addr <= 0xddff) {
        const iec = await lastIecChangeBefore(backend, runId, cycle, cycleFloor);
        if (iec) {
          return {
            rule: "io_dep",
            event: iec,
            reason: `IO cross-domain: CIA read at ${addrHex} cycle ${cycle} caused by IEC ${iec.family} at cycle ${iec.cycle}`,
          };
        }
      }
    }
  }

  // Rule 3: mem_dep — mem_write to address read by the instruction.
  if (family === "mem_write") {
    const row = currentRow as { addr?: number; pc?: number };
    if (row.addr !== undefined && !isStackAddress(row.addr) && !isIoAddress(row.addr)) {
      const addrHex = `$${row.addr.toString(16).toUpperCase().padStart(4, "0")}`;
      const prior = await lastMemWriteBefore(backend, runId, row.addr, cycle, cycleFloor);
      if (prior) {
        return {
          rule: "mem_dep",
          event: prior,
          reason: `Memory dependency: write to ${addrHex} at cycle ${cycle} follows earlier write at cycle ${prior.cycle}`,
        };
      }
    }
  }

  // Rule 2: stack_frame — if event touches stack, walk to JSR via stack writes.
  if (family === "mem_write") {
    const row = currentRow as { addr?: number };
    if (row.addr !== undefined && isStackAddress(row.addr)) {
      const jsrWrite = await lastStackWriteBefore(backend, runId, cycle, cycleFloor);
      if (jsrWrite) {
        return {
          rule: "stack_frame",
          event: jsrWrite,
          reason: `Stack frame: stack write at $${(row.addr).toString(16).toUpperCase()} (cycle ${cycle}) walked to prior stack write at cycle ${jsrWrite.cycle}`,
        };
      }
    }
  }

  // Rule 4: irq_origin — if target is in IRQ handler range ($FF48-$FFFF or $FE43-$FEBC typical),
  // find the irq_assert that woke it.
  if (family === "cpu_step") {
    const row = currentRow as { pc?: number };
    const pc = row.pc ?? 0;
    // Heuristic: kernal IRQ handler range
    const inIrqHandler = (pc >= 0xea31 && pc <= 0xffff) || (pc >= 0xfe43 && pc <= 0xfebc);
    if (inIrqHandler) {
      const irq = await lastIrqAssertBefore(backend, runId, cycle, cycleFloor);
      if (irq) {
        return {
          rule: "irq_origin",
          event: irq,
          reason: `IRQ origin: cpu_step at PC=$${pc.toString(16).toUpperCase().padStart(4, "0")} (cycle ${cycle}) is in IRQ handler; irq_assert at cycle ${irq.cycle}`,
        };
      }
    }
  }

  // Cross-domain bridge (B2): if we hit an IEC boundary event, jump to
  // the cycle region of the opposite domain.
  if (crossDomain && IEC_FAMILIES.has(family)) {
    const iec = await lastIecChangeBefore(backend, runId, cycle, cycleFloor);
    if (iec) {
      return {
        rule: "io_dep",
        event: iec,
        reason: `IEC cross-domain bridge: ${family} at cycle ${cycle} preceded by ${iec.family} at cycle ${iec.cycle}`,
      };
    }
  }

  // Fallback: pc_predecessor for any remaining event.
  if (family !== "cpu_step" && family !== "mem_write" && family !== "mem_read") {
    const pred = await lastCpuStepBefore(backend, runId, cycle, cycleFloor);
    if (pred) {
      const pcHex = `$${(pred as any).pc?.toString(16).toUpperCase().padStart(4, "0") ?? "????"}`;
      return {
        rule: "pc_predecessor",
        event: pred,
        reason: `PC predecessor for ${family}: last cpu_step at cycle ${pred.cycle} (PC=${pcHex})`,
      };
    }
  }

  return null;
}

// ---- Main entry point ----------------------------------------------------

export async function followPath(
  backend: QueryEventsBackend,
  q: PathQuery,
): Promise<PathChain> {
  const maxDepth = q.maxDepth ?? 50;
  const cycleWindow = q.cycleWindow ?? 100_000;
  const crossDomain = q.crossDomain !== false;  // default true
  const runId = q.runId;
  const cycleFloor = Math.max(0, q.endEventCycle - cycleWindow);

  // Locate the end event.
  const endRow = await findEndEvent(
    backend, runId, q.endEventFamily, q.endEventCycle, q.endEventKey,
  );
  if (!endRow) {
    return { steps: [], truncated: false };
  }

  // Walk backwards, collecting steps (most-recent-first internally,
  // then we reverse at the end).
  const stepsReversed: PathStep[] = [];
  let current = endRow;
  let truncated = false;

  // Track visited (cycle, family) to avoid cycles.
  const visited = new Set<string>();
  visited.add(`${current.cycle}:${current.family}`);

  for (let depth = 0; depth < maxDepth; depth++) {
    if (current.cycle <= cycleFloor) {
      truncated = true;
      break;
    }

    const result = await applyRules(backend, runId, current, cycleFloor, crossDomain);
    if (!result) break;

    const key = `${result.event.cycle}:${result.event.family}`;
    if (visited.has(key)) break;
    visited.add(key);

    stepsReversed.push({
      rule: result.rule,
      event: result.event,
      reason: result.reason,
    });

    current = result.event;

    if (current.cycle <= cycleFloor) {
      truncated = true;
      break;
    }
  }

  // Reverse so steps are earliest-first; then append end event.
  stepsReversed.reverse();
  const endStep: PathStep = {
    rule: "pc_predecessor",  // sentinel for the end event itself
    event: endRow,
    reason: `End event: ${q.endEventFamily} at cycle ${q.endEventCycle}`,
  };
  const steps = [...stepsReversed, endStep];

  return { steps, truncated };
}
