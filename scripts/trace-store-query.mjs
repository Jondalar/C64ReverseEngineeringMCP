#!/usr/bin/env node
// Spec 217 Spike B — trace-store query CLI.
//
// Subcommands:
//   info                       — meta + counts
//   top-pcs --cpu c64|drive8 [--limit N] [--source vice|headless]
//   anchor-list                — all anchors + occurrence counts
//   anchor-find <name> [N]     — list occurrences (optionally filtered to N)
//   bus-find --addr 0xDD00 [--limit N]
//   zoom --anchor <name> --occurrence N [--before 200] [--after 200]
//   sql '<query>'              — raw SQL (read-only)

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");

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
const args = parseArgs(process.argv.slice(2));
const subcmd = args._[0];

const dbPath = args.db
  ? resolvePath(args.db)
  : null;
if (!dbPath) {
  console.error(`usage: trace-store-query.mjs --db <path/to/trace.duckdb> <subcommand> [...args]`);
  console.error(`subcommands: info | top-pcs | anchor-list | anchor-find | bus-find | zoom | sql`);
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`store not found: ${dbPath}`);
  process.exit(2);
}

const duck = await import("@duckdb/node-api");
const inst = await duck.DuckDBInstance.create(dbPath);
const conn = await inst.connect();

// helpers
function fmtHex(n) {
  if (n === null || n === undefined) return "null";
  const v = typeof n === "bigint" ? Number(n) : n;
  return "$" + v.toString(16).padStart(4, "0");
}
function fmtRows(rows) {
  return rows.map((r) => r.map((c) => typeof c === "bigint" ? c.toString() : c).join("\t")).join("\n");
}

async function run(sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRows();
}

switch (subcmd) {
  case "info": {
    const meta = await run("SELECT key, value FROM meta ORDER BY key");
    console.log("meta:");
    for (const [k, v] of meta) console.log(`  ${k} = ${v}`);
    const counts = await run(`
      SELECT 'instructions', count(*) FROM instructions
      UNION ALL SELECT 'bus_events', count(*) FROM bus_events
      UNION ALL SELECT 'chip_events', count(*) FROM chip_events
      UNION ALL SELECT 'anchors', count(*) FROM anchors
      UNION ALL SELECT 'rollups', count(*) FROM rollups
    `);
    console.log("\ntable counts:");
    for (const [t, n] of counts) console.log(`  ${t} = ${n}`);
    const range = await run(`
      SELECT MIN(master_clock), MAX(master_clock) FROM instructions WHERE master_clock IS NOT NULL
    `);
    if (range[0] && range[0][0] !== null) {
      console.log(`\nmaster_clock range: ${range[0][0]} .. ${range[0][1]}`);
    }
    break;
  }
  case "top-pcs": {
    const cpu = args.cpu ?? "c64";
    const limit = Number(args.limit ?? 20);
    const rows = await run(`
      SELECT pc, count(*) AS n
      FROM instructions
      WHERE cpu = '${cpu}'
      GROUP BY pc
      ORDER BY n DESC
      LIMIT ${limit}
    `);
    console.log(`top ${limit} PCs for cpu=${cpu}:`);
    for (const [pc, n] of rows) console.log(`  ${fmtHex(pc)}\t${n}`);
    break;
  }
  case "anchor-list": {
    const rows = await run(`
      SELECT name, cpu, pc, count(*) AS n, MIN(clock) AS first_clock, MAX(clock) AS last_clock
      FROM anchors
      GROUP BY name, cpu, pc
      ORDER BY n DESC
    `);
    if (rows.length === 0) {
      console.log("(no anchors built yet — run anchor-builder first)");
      break;
    }
    console.log(`anchor\tcpu\tpc\toccurrences\tfirst_clock\tlast_clock`);
    for (const r of rows) {
      console.log(`${r[0]}\t${r[1]}\t${fmtHex(r[2])}\t${r[3]}\t${r[4]}\t${r[5]}`);
    }
    break;
  }
  case "anchor-find": {
    const name = args._[1];
    if (!name) { console.error("anchor-find <name> [<occurrence>]"); process.exit(2); }
    const occ = args._[2];
    const occWhere = occ !== undefined ? ` AND occurrence = ${Number(occ)}` : "";
    const rows = await run(`
      SELECT occurrence, pc, clock, seq
      FROM anchors
      WHERE name = '${name}' ${occWhere}
      ORDER BY occurrence
      LIMIT 200
    `);
    console.log(`occurrences of '${name}' (showing up to 200):`);
    console.log(`occ\tpc\tclock\tseq`);
    for (const r of rows) console.log(`${r[0]}\t${fmtHex(r[1])}\t${r[2]}\t${r[3]}`);
    break;
  }
  case "bus-find": {
    const addr = args.addr;
    if (!addr) { console.error("bus-find --addr 0xDD00 [--limit N]"); process.exit(2); }
    const addrNum = Number.isInteger(Number(addr)) ? Number(addr) : parseInt(addr, 16);
    const limit = Number(args.limit ?? 50);
    const rows = await run(`
      SELECT seq, cpu, kind, master_clock, pc, addr, value, old_value
      FROM bus_events
      WHERE addr = ${addrNum}
      ORDER BY seq
      LIMIT ${limit}
    `);
    console.log(`first ${limit} bus_events at addr=${fmtHex(addrNum)}:`);
    console.log(`seq\tcpu\tkind\tmclk\tpc\taddr\tvalue\told`);
    for (const r of rows) {
      console.log([r[0], r[1], r[2], r[3], fmtHex(r[4]), fmtHex(r[5]), r[6], r[7]].join("\t"));
    }
    break;
  }
  case "zoom": {
    const name = args.anchor;
    const occ = Number(args.occurrence ?? 1);
    const before = Number(args.before ?? 200);
    const after = Number(args.after ?? 200);
    if (!name) { console.error("zoom --anchor <name> --occurrence N [--before 200] [--after 200]"); process.exit(2); }
    const a = await run(`
      SELECT clock, seq, pc, cpu FROM anchors
      WHERE name = '${name}' AND occurrence = ${occ}
      LIMIT 1
    `);
    if (a.length === 0) { console.error(`no occurrence ${occ} of anchor '${name}'`); process.exit(1); }
    const [clock, seq, pc, cpu] = a[0];
    console.log(`zoom @ anchor=${name} occ=${occ}  cpu=${cpu}  pc=${fmtHex(pc)}  clock=${clock}  seq=${seq}`);
    console.log(`window: clock-${before} .. clock+${after}`);
    const win = await run(`
      SELECT pc, cpu, clock, seq
      FROM instructions
      WHERE clock BETWEEN ${BigInt(clock) - BigInt(before)} AND ${BigInt(clock) + BigInt(after)}
      ORDER BY clock
      LIMIT 500
    `);
    console.log(`pc\tcpu\tclock\tseq`);
    for (const r of win) console.log([fmtHex(r[0]), r[1], r[2], r[3]].join("\t"));
    break;
  }
  case "sql": {
    const q = args._[1];
    if (!q) { console.error("sql '<read-only query>'"); process.exit(2); }
    const lc = q.toLowerCase().trim();
    if (!lc.startsWith("select") && !lc.startsWith("with")) {
      console.error("sql subcommand only allows SELECT/WITH (read-only)");
      process.exit(2);
    }
    const rows = await run(q);
    console.log(fmtRows(rows));
    break;
  }
  default:
    console.error(`unknown subcommand: ${subcmd}`);
    console.error(`subcommands: info | top-pcs | anchor-list | anchor-find | bus-find | zoom | sql`);
    process.exit(2);
}

inst.closeSync();
