// Spec 217 — RollupBuilder (post-hoc).
//
// Reads instructions + chip_events + bus_events from the persisted
// store, emits rollup rows per fixed level. Levels per Spec 217:
//   level 0:    100_000 master-clocks  (~100 ms)
//   level 1:  1_000_000                (~1 s)
//   level 2: 10_000_000                (~10 s)
//   level 3: 100_000_000               (~100 s)

import type { DuckDbStore } from "./duckdb-store.js";

export const ROLLUP_LEVELS: ReadonlyArray<{ level: number; windowSize: bigint }> = [
  { level: 0, windowSize:        100_000n },
  { level: 1, windowSize:      1_000_000n },
  { level: 2, windowSize:     10_000_000n },
  { level: 3, windowSize:    100_000_000n },
];

export async function buildRollups(
  store: DuckDbStore,
): Promise<{ rollupsWritten: number }> {
  const runId = store.meta.runId;
  // Clear rollups for this run first.
  await store.conn.run(`DELETE FROM rollups WHERE run_id = '${runId}'`);

  let total = 0;
  for (const { level, windowSize } of ROLLUP_LEVELS) {
    for (const cpu of ["c64", "drive8"] as const) {
      // Top PCs per window.
      const topPcsSql = `
        WITH windowed AS (
          SELECT
            CAST(FLOOR(master_clock / ${windowSize.toString()}) AS UBIGINT) AS window_index,
            pc,
            COUNT(*) AS n
          FROM instructions
          WHERE run_id = '${runId}'
            AND cpu = '${cpu}'
            AND master_clock IS NOT NULL
          GROUP BY 1, 2
        ),
        ranked AS (
          SELECT
            window_index,
            pc,
            n,
            ROW_NUMBER() OVER (PARTITION BY window_index ORDER BY n DESC) AS rk
          FROM windowed
        )
        SELECT
          window_index,
          (SELECT source FROM instructions WHERE run_id = '${runId}' LIMIT 1) AS source,
          to_json(ARRAY_AGG({'pc': pc, 'count': n} ORDER BY n DESC)) AS top_pcs
        FROM ranked
        WHERE rk <= 16
        GROUP BY window_index
      `;
      const result = await store.conn.runAndReadAll(topPcsSql);
      const rows = result.getRows();
      if (rows.length === 0) continue;

      const app = await store.conn.createAppender("rollups");
      for (const row of rows) {
        const windowIndex = row[0] as bigint | number;
        const sourceStr = row[1] as string;
        const topPcs = row[2] as string;
        const widx = typeof windowIndex === "bigint" ? windowIndex : BigInt(windowIndex);
        const clockStart = widx * windowSize;
        const clockEnd = clockStart + windowSize;
        app.appendVarchar(runId);
        app.appendVarchar(sourceStr);
        app.appendUTinyInt(level);
        app.appendUBigInt(widx);
        app.appendUBigInt(clockStart);
        app.appendUBigInt(clockEnd);
        app.appendVarchar(cpu);
        app.appendVarchar(topPcs);
        app.appendVarchar("{}");        // bus_counts_json — placeholder
        app.appendVarchar("{}");        // irq_counts_json — placeholder
        app.appendNull();               // phase
        app.endRow();
        total++;
      }
      app.flushSync();
      app.closeSync();
    }
  }
  return { rollupsWritten: total };
}
