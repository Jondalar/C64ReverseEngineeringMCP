#!/usr/bin/env node
// Spec 236 smoke — VICE first-divergence diff.
//
// All cases use a synthetic DiffBackendFactory that returns in-memory event
// streams, so no real DuckDB stores are required. Tests cover:
//   S1: identical streams → null (no divergence)
//   S2: deliberate cpu_register payload mismatch → divergence detected
//   S3: classification correct (cpu_step → "cpu_register")
//   S4: context window includes ±20 events; sharedPrefix counted
//   S5: missing baseline → null with diagnostic (no crash)
//   S6: iec_line family → classification "iec_line"
//   S7: stream-length mismatch (vice has extra event) → divergence
//   S8: cycleRange filter accepted (narrow window, no divergence)

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const { diffAgainstVice } =
  await import(`${repoRoot}/dist/runtime/headless/v2/vice-diff.js`);

// ---------------------------------------------------------------------------
// Synthetic DiffBackendFactory
// ---------------------------------------------------------------------------
//
// The factory is called twice by diffAgainstVice: first for the VICE path,
// second for the headless path. We use call order (via a counter) to return
// the correct event set for each side.
//
// Paths: we supply real existing paths so existsSync passes in diffAgainstVice.
// Two DIFFERENT real paths are used so the factory can tell them apart.

const VICE_SENTINEL_PATH = `${repoRoot}/package.json`;          // guaranteed to exist
const HEADLESS_SENTINEL_PATH = `${repoRoot}/tsconfig.json`;     // guaranteed to exist
const MISSING_PATH = `${repoRoot}/__does_not_exist_xyz__/trace.duckdb`;

/** Build a query object with real paths pointing to sentinel files. */
function makeQuery(extra = {}) {
  return {
    scenarioId: "test-scenario",
    vicePath: VICE_SENTINEL_PATH,
    headlessPath: HEADLESS_SENTINEL_PATH,
    ...extra,
  };
}

/** Convert a typed EventRow to the DB-row shape that rowFromDb expects. */
function eventToDbRow(e) {
  const base = { clock: e.cycle };
  switch (e.family) {
    case "cpu_step":
      return { ...base, pc: e.pc, opcode: e.opcode, a: e.a, x: e.x, y: e.y, sp: e.sp, p: e.flags };
    case "mem_read":
      return { ...base, kind: "read", pc: e.pc, addr: e.addr, value: e.value };
    case "mem_write":
      return { ...base, kind: "write", pc: e.pc, addr: e.addr, value: e.value };
    case "irq_assert":
      return { ...base, kind: "irq_assert", chip: e.source };
    case "irq_ack":
      return { ...base, kind: "irq_ack", chip: e.source };
    case "drive_atn_change":
      return { ...base, kind: "line_change", line_atn: e.level };
    case "drive_data_change":
      return { ...base, kind: "line_change", line_data: e.level };
    case "drive_clk_change":
      return { ...base, kind: "line_change", line_clk: e.level };
    default:
      return base;
  }
}

/** Infer which EventFamily a given SQL query targets (params are ? placeholders). */
function inferFamilyFromSql(sql, params) {
  if (sql.includes("FROM instructions")) return "cpu_step";
  if (sql.includes("FROM bus_events") || sql.includes("FROM chip_events")) {
    // The kind filter is passed as a param (the second param after run_id).
    const kind = params?.[1];
    if (kind === "read") return "mem_read";
    if (kind === "write") return "mem_write";
    if (kind === "irq_assert") return "irq_assert";
    if (kind === "irq_ack") return "irq_ack";
    if (kind === "nmi_assert") return "nmi_assert";
    if (kind === "timer_underflow") return "cia_timer_underflow";
    if (kind === "line_change") return "drive_atn_change"; // covers all 3 line families
    if (kind === "byte_ready") return "gcr_byte";
    if (kind === "trap_fire") return "trap_fire";
  }
  return null;
}

/**
 * Build a DiffBackendFactory that returns synthetic event streams.
 *
 * Call order: first openReadOnly call → vice side, second → headless side.
 * The VICE_SENTINEL_PATH and HEADLESS_SENTINEL_PATH are used so existsSync
 * passes. The factory distinguishes them by path.
 */
function buildFactory(viceEvents, headlessEvents) {
  return {
    async openReadOnly(path) {
      const isVice = path === VICE_SENTINEL_PATH;
      const events = isVice ? viceEvents : headlessEvents;
      const runId = isVice ? "vice-run" : "headless-run";

      return {
        runId,
        backend: {
          async exec(sql, params) {
            const familyFromSql = inferFamilyFromSql(sql, params);
            // Return empty for unknown/unrecognized families — they have no
            // events in our synthetic data.
            if (!familyFromSql) return [];
            // Filter: return events matching the queried family.
            const filtered = events.filter((e) =>
              e.family === familyFromSql ||
              // "line_change" covers all 3 drive-line families:
              (familyFromSql === "drive_atn_change" &&
                ["drive_atn_change", "drive_data_change", "drive_clk_change"].includes(e.family)),
            );
            return filtered.map(eventToDbRow);
          },
        },
        async close() {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const results = [];
function pass(name) {
  results.push({ name, pass: true });
  console.log(`  PASS  ${name}`);
}
function fail(name, msg) {
  results.push({ name, pass: false });
  console.log(`  FAIL  ${name}: ${msg}`);
}

function cpuStep(cycle, pc, a = 0) {
  return { runId: "x", family: "cpu_step", cycle, pc, opcode: 0xa9, a, x: 0, y: 0, sp: 0xff, flags: 0x20 };
}
function iecLine(cycle, family = "drive_data_change", level = 0) {
  return { runId: "x", family, cycle, level };
}

console.log("=== Spec 236 — VICE first-divergence diff ===\n");

// ---------------------------------------------------------------------------
// S1: identical streams → null (no divergence)
// ---------------------------------------------------------------------------
try {
  const events = [
    cpuStep(100, 0x0800, 0x42),
    cpuStep(200, 0x0802, 0x42),
    cpuStep(300, 0x0804, 0x42),
  ];
  const factory = buildFactory(events, [...events]);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result !== null) throw new Error(`expected null, got divergence at cycle ${result.firstDivergeCycle}`);
  pass("S1: identical streams → null (no divergence)");
} catch (e) {
  fail("S1: identical streams → null", e.message);
}

// ---------------------------------------------------------------------------
// S2: deliberate cpu_register payload mismatch → divergence detected
// ---------------------------------------------------------------------------
try {
  const viceEvents = [
    cpuStep(100, 0x0800, 0x42),  // A=0x42
    cpuStep(200, 0x0802, 0x42),
  ];
  const headlessEvents = [
    cpuStep(100, 0x0800, 0xFF),  // A=0xFF — deliberate cpu bug
    cpuStep(200, 0x0802, 0x42),
  ];
  const factory = buildFactory(viceEvents, headlessEvents);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result === null) throw new Error("expected divergence, got null");
  if (result.firstDivergeCycle !== 100) throw new Error(`expected cycle 100, got ${result.firstDivergeCycle}`);
  pass("S2: cpu_register bug → divergence detected at cycle 100");
} catch (e) {
  fail("S2: cpu_register bug → divergence detected", e.message);
}

// ---------------------------------------------------------------------------
// S3: classification correct (cpu_step family → "cpu_register")
// ---------------------------------------------------------------------------
try {
  const viceEvents = [cpuStep(100, 0x0800, 0x42)];
  const headlessEvents = [cpuStep(100, 0x0800, 0x10)];  // different A register
  const factory = buildFactory(viceEvents, headlessEvents);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result === null) throw new Error("expected divergence");
  if (result.classification !== "cpu_register")
    throw new Error(`expected cpu_register, got ${result.classification}`);
  if (result.divergenceFamily !== "cpu_step")
    throw new Error(`expected cpu_step, got ${result.divergenceFamily}`);
  pass("S3: classification cpu_step → cpu_register");
} catch (e) {
  fail("S3: classification correct", e.message);
}

// ---------------------------------------------------------------------------
// S4: context window includes ±20 events; sharedPrefix counted
// ---------------------------------------------------------------------------
try {
  // 50 identical events, then 1 mismatch at index 50, then 10 more identical.
  const viceEvents = [];
  const headlessEvents = [];
  for (let i = 0; i < 50; i++) {
    viceEvents.push(cpuStep(i * 10, 0x0800 + i, 0x42));
    headlessEvents.push(cpuStep(i * 10, 0x0800 + i, 0x42));
  }
  // Divergence at cycle 500:
  viceEvents.push(cpuStep(500, 0x0C00, 0xAA));
  headlessEvents.push(cpuStep(500, 0x0C00, 0xBB));  // different A
  for (let i = 0; i < 10; i++) {
    viceEvents.push(cpuStep(510 + i * 10, 0x0D00 + i, 0x42));
    headlessEvents.push(cpuStep(510 + i * 10, 0x0D00 + i, 0x42));
  }

  const factory = buildFactory(viceEvents, headlessEvents);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result === null) throw new Error("expected divergence");
  if (result.context.sharedPrefix !== 50)
    throw new Error(`expected sharedPrefix=50, got ${result.context.sharedPrefix}`);
  // Window: ±20 around the divergence point (index 50 of 61 total):
  // vice has 61 events, diverge at index 50, window = [30..61] = 31 events (capped to min(50+20+1=71, 61)=61, start=max(0,50-20)=30)
  // So window size = min(61, 71) - 30 = 31
  if (result.context.viceWindow.length < 20)
    throw new Error(`expected ≥20 events in viceWindow, got ${result.context.viceWindow.length}`);
  if (result.context.headlessWindow.length < 20)
    throw new Error(`expected ≥20 events in headlessWindow, got ${result.context.headlessWindow.length}`);
  pass("S4: context window ≥20 events, sharedPrefix=50 counted correctly");
} catch (e) {
  fail("S4: context window + sharedPrefix", e.message);
}

// ---------------------------------------------------------------------------
// S5: missing baseline → null with diagnostic (no crash)
// ---------------------------------------------------------------------------
try {
  let warnMessage = "";
  const origWarn = console.warn;
  console.warn = (...args) => { warnMessage = args.join(" "); };
  try {
    const result = await diffAgainstVice(
      { openReadOnly: async () => { throw new Error("should not be called"); } },
      { scenarioId: "__nonexistent_scenario_xyz__" },
    );
    if (result !== null) throw new Error("expected null for missing baseline");
    if (!warnMessage.includes("no baseline"))
      throw new Error(`unexpected warn message: "${warnMessage}"`);
  } finally {
    console.warn = origWarn;
  }
  pass("S5: missing baseline → null with diagnostic");
} catch (e) {
  fail("S5: missing baseline → null with diagnostic", e.message);
}

// ---------------------------------------------------------------------------
// S6: iec_line family → classification "iec_line"
// ---------------------------------------------------------------------------
try {
  const viceEvents = [iecLine(100, "drive_data_change", 1)];
  const headlessEvents = [iecLine(100, "drive_data_change", 0)];  // level differs
  const factory = buildFactory(viceEvents, headlessEvents);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result === null) throw new Error("expected divergence");
  if (result.classification !== "iec_line")
    throw new Error(`expected iec_line, got ${result.classification}`);
  pass("S6: drive_data_change divergence → iec_line classification");
} catch (e) {
  fail("S6: iec_line classification", e.message);
}

// ---------------------------------------------------------------------------
// S7: stream-length mismatch — vice has extra event → divergence
// ---------------------------------------------------------------------------
try {
  const viceEvents = [
    cpuStep(100, 0x0800, 0x42),
    cpuStep(200, 0x0802, 0x42),  // extra event on VICE side
  ];
  const headlessEvents = [
    cpuStep(100, 0x0800, 0x42),
  ];
  const factory = buildFactory(viceEvents, headlessEvents);
  const result = await diffAgainstVice(factory, makeQuery());
  if (result === null) throw new Error("expected divergence for length mismatch");
  pass("S7: stream-length mismatch (vice longer) → divergence reported");
} catch (e) {
  fail("S7: stream-length mismatch", e.message);
}

// ---------------------------------------------------------------------------
// S8: cycleRange filter accepted, identical sub-range → null
// ---------------------------------------------------------------------------
try {
  // Build a factory that honours cycleRange.
  // The factory receives SQL with "BETWEEN ? AND ?" for cycle filters.
  // In our synthetic backend the params contain cycle bounds.
  const viceEventsAll = [
    cpuStep(50, 0x0800, 0xAA),   // outside [100,200]
    cpuStep(100, 0x0802, 0x42),  // inside
    cpuStep(150, 0x0804, 0x42),  // inside
    cpuStep(300, 0x0810, 0xFF),  // outside - would be a divergence if included
  ];
  const headlessEventsAll = [
    cpuStep(50, 0x0800, 0x00),   // different but outside range
    cpuStep(100, 0x0802, 0x42),  // same as vice
    cpuStep(150, 0x0804, 0x42),  // same as vice
    cpuStep(300, 0x0810, 0x00),  // different but outside range
  ];

  // Build a factory that applies cycleRange manually to the events.
  function buildRangeAwareFactory(vEvents, hEvents) {
    return {
      async openReadOnly(path) {
        const isVice = path === VICE_SENTINEL_PATH;
        const events = isVice ? vEvents : hEvents;
        const runId = isVice ? "vice-run" : "headless-run";

        return {
          runId,
          backend: {
            async exec(sql, params) {
              const familyFromSql = inferFamilyFromSql(sql, params);
              // Extract cycleRange from params — when cycleRange is provided,
              // "clock BETWEEN ? AND ?" comes after run_id (and optional kind).
              let minCycle = 0;
              let maxCycle = Infinity;
              if (sql.includes("BETWEEN") && params.length >= 3) {
                // params = [runId, (optional kind), cycleMin, cycleMax]
                const kindInParams = sql.includes("kind = ?");
                const cycleMinIdx = kindInParams ? 2 : 1;
                minCycle = Number(params[cycleMinIdx]);
                maxCycle = Number(params[cycleMinIdx + 1]);
              }
              if (!familyFromSql) return [];
              const filtered = events.filter((e) =>
                (e.family === familyFromSql ||
                 (familyFromSql === "drive_atn_change" &&
                   ["drive_atn_change", "drive_data_change", "drive_clk_change"].includes(e.family))) &&
                e.cycle >= minCycle &&
                e.cycle <= maxCycle,
              );
              return filtered.map(eventToDbRow);
            },
          },
          async close() {},
        };
      },
    };
  }

  const rangeFactory = buildRangeAwareFactory(viceEventsAll, headlessEventsAll);
  const result = await diffAgainstVice(rangeFactory, {
    ...makeQuery(),
    cycleRange: [100, 200],
  });
  if (result !== null)
    throw new Error(`expected null within [100,200], got divergence at cycle ${result?.firstDivergeCycle}`);
  pass("S8: cycleRange filter — identical sub-range → null");
} catch (e) {
  fail("S8: cycleRange filter", e.message);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalPass = results.filter((r) => r.pass).length;
const totalFail = results.filter((r) => !r.pass).length;

console.log(`\nSpec 236 vice-diff: ${totalPass}/${results.length} PASS${totalFail > 0 ? `, ${totalFail} FAIL` : ""}`);
if (totalFail > 0) {
  process.exit(1);
}
process.exit(0);
