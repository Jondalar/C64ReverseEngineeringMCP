// Spec 217 — AnchorBuilder
//
// Reads the persisted instructions table and writes anchor occurrences
// to the anchors table. Post-hoc; not in hot path.

import type { DuckDbStore } from "./duckdb-store.js";

export interface AnchorDef {
  name: string;
  cpu: "c64" | "drive8";
  pc: number;
}

// Default motm anchors (Spec 217 §Anchors).
export const DEFAULT_MOTM_ANCHORS: AnchorDef[] = [
  { name: "ab_entry",                cpu: "c64",    pc: 0x4000 },
  { name: "bitbang_tx_24bit",        cpu: "c64",    pc: 0x425c },
  { name: "bitbang_tx_inner",        cpu: "c64",    pc: 0x4294 },
  { name: "rx_wait",                 cpu: "c64",    pc: 0x43c7 },
  { name: "rx_byte",                 cpu: "c64",    pc: 0x43cf },
  { name: "wait_loader_completion",  cpu: "c64",    pc: 0x4370 },
  { name: "game_handoff",            cpu: "c64",    pc: 0xf500 },
  { name: "drive_rx_wait",           cpu: "drive8", pc: 0x07be },
  { name: "drive_rx_active",         cpu: "drive8", pc: 0x0714 },
  { name: "drive_rom_idle_a",        cpu: "drive8", pc: 0xf55d },
  { name: "drive_rom_idle_b",        cpu: "drive8", pc: 0xf560 },
];

export async function buildAnchors(
  store: DuckDbStore,
  defs: AnchorDef[] = DEFAULT_MOTM_ANCHORS,
): Promise<{ anchorsWritten: number }> {
  // Clear anchors for this run first.
  await store.conn.run(`DELETE FROM anchors WHERE run_id = '${store.meta.runId}'`);

  let total = 0;
  for (const def of defs) {
    // Use a window function so each occurrence gets a sequential N.
    const sql = `
      INSERT INTO anchors (run_id, source, cpu, name, pc, occurrence, clock, seq)
      SELECT
        run_id,
        source,
        cpu,
        '${def.name}' AS name,
        pc,
        ROW_NUMBER() OVER (ORDER BY clock, seq) AS occurrence,
        clock,
        seq
      FROM instructions
      WHERE run_id = '${store.meta.runId}'
        AND cpu = '${def.cpu}'
        AND pc = ${def.pc & 0xffff}
    `;
    await store.conn.run(sql);
    const r = await store.conn.runAndReadAll(
      `SELECT COUNT(*) FROM anchors WHERE run_id = '${store.meta.runId}' AND name = '${def.name}'`,
    );
    const count = r.getRows()[0][0];
    const countNum = typeof count === "bigint" ? Number(count) : Number(count);
    total += countNum;
  }
  return { anchorsWritten: total };
}
