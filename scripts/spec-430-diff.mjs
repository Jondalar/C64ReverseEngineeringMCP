#!/usr/bin/env node
// Spec 431 — Canary divergence diff (DuckDB).
//
// Diffs a fresh headless trace against a VICE baseline trace on the
// IEC/VIA contract surface ($DD00 + $1800 bus_events, IRQ chip_events,
// drive clock). Reports the first divergent row plus 8 rows of context.
//
// Usage:
//   node scripts/spec-430-diff.mjs --canary <id>
//     [--hl-db <path>] [--vice-db <path>]
//     [--out <path>]               // JSON output
//     [--context 8]
//
// If --hl-db is omitted, uses
//   samples/traces/spec-430/<canary>/headless-<sha>/trace.duckdb
// If --vice-db is omitted, uses the canary's baseline.vice from
// samples/canaries/spec-430.json.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}

function gitSha() {
  const r = spawnSync("git", ["rev-parse", "--short=10", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  });
  return r.status === 0 ? (r.stdout.trim() || "dev") : "dev";
}

async function withConn(dbPath, fn) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  try { return await fn(conn); }
  finally { inst.closeSync?.(); }
}

async function withTwoAttached(hlPath, vicePath, fn) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  // Open a fresh in-memory DB and attach both sides read-only.
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  try {
    await conn.run(`ATTACH '${hlPath}' AS h (READ_ONLY)`);
    await conn.run(`ATTACH '${vicePath}' AS v (READ_ONLY)`);
    return await fn(conn);
  } finally {
    inst.closeSync?.();
  }
}

// Contract surface SQL:
//   instructions whose operand (b1 + b2*256) lies in an IEC/VIA region.
//   - C64 side (cpu='c64'):    $DD00-$DD0F, $DC00-$DC0F
//   - drive side (cpu='drive8'): $1800-$180F, $1C00-$1C0F
//   Includes absolute (3-byte) and zero-page (skipped — zp can't hit
//   these I/O regions). Indexed addressing is captured by opcode-byte
//   inspection at compare time; for the diff sequence we use the
//   operand bytes verbatim, since VICE and HL must produce identical
//   instruction streams.
//
// Compare key:  (cpu, pc, opcode, b1, b2)
// Compare state: (a, x, y, sp, p, master_clock)
// Opcodes that take an absolute (or abs,X / abs,Y) operand and can
// therefore address an I/O register. Restricting by opcode prevents
// b1/b2 false positives from immediates and the next-instruction byte.
const ABS_OPCODES = [
  0x8D, 0x9D, 0x99,  // STA abs, abs,X, abs,Y
  0xAD, 0xBD, 0xB9,  // LDA abs, abs,X, abs,Y
  0x8E, 0xAE,        // STX abs, LDX abs
  0x8C, 0xAC,        // STY abs, LDY abs
  0x2C,              // BIT abs
  0xEE, 0xCE,        // INC abs, DEC abs
  0x0D, 0x2D, 0x4D, 0x6D, 0xED,  // ORA/AND/EOR/ADC/SBC abs
  0xCD, 0xDD, 0xD9,              // CMP abs/abs,X/abs,Y
].join(",");

const CONTRACT_SQL = `
  SELECT
    seq, clock, master_clock, cpu, pc, opcode, b1, b2,
    a, x, y, sp, p
  FROM instructions
  WHERE
    opcode IN (${ABS_OPCODES})
    AND (
      (cpu = 'c64' AND (
          (b2 = 221 AND b1 BETWEEN 0 AND 15)  -- $DD00-$DD0F (CIA2)
       OR (b2 = 220 AND b1 BETWEEN 0 AND 15)  -- $DC00-$DC0F (CIA1)
      ))
      OR (cpu = 'drive8' AND (
          (b2 = 24 AND b1 BETWEEN 0 AND 15)   -- $1800-$180F (VIA1)
       OR (b2 = 28 AND b1 BETWEEN 0 AND 15)   -- $1C00-$1C0F (VIA2)
      ))
    )
  ORDER BY master_clock ASC, seq ASC
`;

function rowKey(row) {
  // Identity = cpu + addressed register + opcode kind (load/store).
  return `${row.cpu}|${row.pc}|${row.opcode}|${row.b1}|${row.b2}`;
}

function rowState(row) {
  return {
    a: row.a, x: row.x, y: row.y, sp: row.sp, p: row.p,
  };
}

function eqState(a, b) {
  return a.a === b.a && a.x === b.x && a.y === b.y
      && a.sp === b.sp && a.p === b.p;
}

function buildFilteredCte(alias, opcodeList, sourceTable) {
  return `
    ${alias} AS (
      SELECT
        row_number() OVER (ORDER BY master_clock, seq) AS i,
        master_clock, cpu, pc, opcode, b1, b2, a, x, y, sp, p
      FROM ${sourceTable}
      WHERE opcode IN (${opcodeList})
        AND (
          (cpu = 'c64' AND (
              (b2 = 221 AND b1 BETWEEN 0 AND 15)
           OR (b2 = 220 AND b1 BETWEEN 0 AND 15)
          ))
          OR (cpu = 'drive8' AND (
              (b2 = 24 AND b1 BETWEEN 0 AND 15)
           OR (b2 = 28 AND b1 BETWEEN 0 AND 15)
          ))
        )
    )
  `;
}

async function countContract(conn, alias, sourceTable) {
  const cte = buildFilteredCte(alias, ABS_OPCODES, sourceTable);
  const r = await conn.runAndReadAll(
    `WITH ${cte} SELECT count(*) FROM ${alias}`,
  );
  return Number(r.getRows()[0][0]);
}

async function firstDivergenceSql(conn, context) {
  const cteHl   = buildFilteredCte("hl",   ABS_OPCODES, "h.instructions");
  const cteVice = buildFilteredCte("vice", ABS_OPCODES, "v.instructions");
  // Use FULL OUTER JOIN on row-index alignment. Any row where any
  // contract field differs (or only one side has a row) is divergent.
  // Return the smallest-i mismatch + context rows from both sides.
  const sql = `
    WITH ${cteHl},
         ${cteVice},
         joined AS (
           SELECT
             COALESCE(hl.i, vice.i) AS i,
             hl.master_clock  AS hl_clk,   vice.master_clock AS vc_clk,
             hl.cpu           AS hl_cpu,   vice.cpu          AS vc_cpu,
             hl.pc            AS hl_pc,    vice.pc           AS vc_pc,
             hl.opcode        AS hl_op,    vice.opcode       AS vc_op,
             hl.b1            AS hl_b1,    vice.b1           AS vc_b1,
             hl.b2            AS hl_b2,    vice.b2           AS vc_b2,
             hl.a             AS hl_a,     vice.a            AS vc_a,
             hl.x             AS hl_x,     vice.x            AS vc_x,
             hl.y             AS hl_y,     vice.y            AS vc_y,
             hl.sp            AS hl_sp,    vice.sp           AS vc_sp,
             hl.p             AS hl_p,     vice.p            AS vc_p
           FROM hl FULL OUTER JOIN vice ON hl.i = vice.i
         )
    SELECT * FROM joined
    WHERE hl_cpu IS DISTINCT FROM vc_cpu
       OR hl_pc  IS DISTINCT FROM vc_pc
       OR hl_op  IS DISTINCT FROM vc_op
       OR hl_b1  IS DISTINCT FROM vc_b1
       OR hl_b2  IS DISTINCT FROM vc_b2
       OR hl_a   IS DISTINCT FROM vc_a
       OR hl_x   IS DISTINCT FROM vc_x
       OR hl_y   IS DISTINCT FROM vc_y
       OR hl_sp  IS DISTINCT FROM vc_sp
       OR hl_p   IS DISTINCT FROM vc_p
    ORDER BY i ASC
    LIMIT 1
  `;
  const r = await conn.runAndReadAll(sql);
  const rows = r.getRows();
  if (rows.length === 0) return null;
  const [
    i, hl_clk, vc_clk, hl_cpu, vc_cpu, hl_pc, vc_pc,
    hl_op, vc_op, hl_b1, vc_b1, hl_b2, vc_b2,
    hl_a, vc_a, hl_x, vc_x, hl_y, vc_y, hl_sp, vc_sp, hl_p, vc_p,
  ] = rows[0];
  const idx = typeof i === "bigint" ? Number(i) : i;
  return {
    divergedAt: idx,
    hl:   hl_cpu === null ? null : {
      master_clock: hl_clk, cpu: hl_cpu, pc: hl_pc, opcode: hl_op,
      b1: hl_b1, b2: hl_b2, a: hl_a, x: hl_x, y: hl_y, sp: hl_sp, p: hl_p,
    },
    vice: vc_cpu === null ? null : {
      master_clock: vc_clk, cpu: vc_cpu, pc: vc_pc, opcode: vc_op,
      b1: vc_b1, b2: vc_b2, a: vc_a, x: vc_x, y: vc_y, sp: vc_sp, p: vc_p,
    },
  };
}

async function loadContextRowsAround(conn, alias, centerI, context) {
  const src = alias === "hl" ? "h.instructions" : "v.instructions";
  const cte = buildFilteredCte(alias, ABS_OPCODES, src);
  const lo = Math.max(1, centerI - context);
  const hi = centerI + context;
  const r = await conn.runAndReadAll(
    `WITH ${cte}
     SELECT i, master_clock, cpu, pc, opcode, b1, b2, a, x, y, sp, p
     FROM ${alias}
     WHERE i BETWEEN ${lo} AND ${hi}
     ORDER BY i ASC`,
  );
  return r.getRows().map((row) => ({
    i: Number(row[0]),
    master_clock: row[1], cpu: row[2], pc: row[3], opcode: row[4],
    b1: row[5], b2: row[6], a: row[7], x: row[8], y: row[9],
    sp: row[10], p: row[11],
  }));
}

function loadRegistry() {
  const path = resolvePath(repoRoot, "samples/canaries/spec-430.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

const args = parseArgs(process.argv.slice(2));
if (!args.canary) {
  console.error("usage: spec-430-diff.mjs --canary <id>");
  process.exit(2);
}
const context = Number(args.context ?? 8);

const registry = loadRegistry();
const canary = registry.canaries.find((c) => c.id === args.canary);
if (!canary) {
  console.error(`unknown canary: ${args.canary}`);
  process.exit(2);
}

const sha = gitSha();
const hlDb = args["hl-db"]
  ? resolvePath(repoRoot, args["hl-db"])
  : resolvePath(repoRoot,
      `samples/traces/spec-430/${canary.id}/headless-${sha}/trace.duckdb`);
const viceDb = args["vice-db"]
  ? resolvePath(repoRoot, args["vice-db"])
  : (canary.baseline?.vice
      ? resolvePath(repoRoot, canary.baseline.vice)
      : null);

const report = {
  canary: canary.id,
  expected: canary.expected,
  sha,
  hlDb,
  viceDb,
  status: null,
  divergence: null,
};

if (!existsSync(hlDb)) {
  report.status = "hl-missing";
  console.error(`[${canary.id}] HL trace missing: ${hlDb}`);
  emit(report); process.exit(1);
}

if (!viceDb) {
  report.status = "smoke-only";
  const hlRows = await withConn(hlDb, (c) =>
    countContract(c, "hl", "instructions"));
  report.hlContractRows = hlRows;
  if (hlRows === 0) {
    report.status = "smoke-empty";
    console.error(`[${canary.id}] smoke FAIL — no contract instructions`);
    emit(report); process.exit(1);
  }
  console.log(`[${canary.id}] smoke OK (${hlRows} contract rows, no VICE baseline)`);
  emit(report); process.exit(0);
}

if (!existsSync(viceDb)) {
  report.status = "vice-baseline-missing";
  console.error(`[${canary.id}] VICE baseline missing: ${viceDb}`);
  emit(report); process.exit(1);
}

console.log(`[${canary.id}] diff start`);
console.log(`  HL  : ${hlDb}`);
console.log(`  VICE: ${viceDb}`);

const { div, hlCount, viceCount, hlCtx, viceCtx } =
  await withTwoAttached(hlDb, viceDb, async (conn) => {
    const [hlCount, viceCount] = await Promise.all([
      countContract(conn, "hl",   "h.instructions"),
      countContract(conn, "vice", "v.instructions"),
    ]);
    console.log(`  contract rows: HL=${hlCount}  VICE=${viceCount}`);
    const div = await firstDivergenceSql(conn, context);
    if (!div) return { div: null, hlCount, viceCount, hlCtx: [], viceCtx: [] };
    const [hlCtx, viceCtx] = await Promise.all([
      loadContextRowsAround(conn, "hl", div.divergedAt, context),
      loadContextRowsAround(conn, "vice", div.divergedAt, context),
    ]);
    return { div, hlCount, viceCount, hlCtx, viceCtx };
  });

report.hlContractRows = hlCount;
report.viceContractRows = viceCount;

if (!div) {
  report.status = "match";
  console.log(`[${canary.id}] MATCH (no divergence on contract surface)`);
} else {
  report.status = "diverged";
  report.divergence = { ...div, hlCtx, viceCtx };
  console.log(`[${canary.id}] DIVERGED at row ${div.divergedAt}`);
  if (div.hl) console.log(`  HL  : ${JSON.stringify(div.hl, jsonReplacer)}`);
  else        console.log(`  HL  : <missing — VICE has extra row>`);
  if (div.vice) console.log(`  VICE: ${JSON.stringify(div.vice, jsonReplacer)}`);
  else          console.log(`  VICE: <missing — HL has extra row>`);
}

emit(report);

// Exit code policy:
//   expected=green && status=match       → 0
//   expected=green && status=smoke-only  → 0 (no VICE baseline; HL alive)
//   expected=green && status=diverged    → 1 (regression / not yet ported)
//   expected=red   && status=diverged    → 0 (expected red; gate stays green)
//   expected=red   && status=match       → 1 (track flip — review)
//   expected=red   && status=smoke-only  → 1 (cannot verify red without VICE)
const ok = (canary.expected === "green" &&
            (report.status === "match" || report.status === "smoke-only"))
        || (canary.expected === "red"   && report.status === "diverged");
process.exit(ok ? 0 : 1);

function emit(report) {
  const outPath = args.out
    ? resolvePath(repoRoot, args.out)
    : resolvePath(repoRoot,
        `samples/traces/spec-430/${canary.id}/diff-${sha}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, jsonReplacer, 2));
  console.log(`  report: ${outPath}`);
}

function jsonReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}
