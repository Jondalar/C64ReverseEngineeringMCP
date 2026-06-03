#!/usr/bin/env node
// scripts/e2e-753-trace-memory-map.mjs — Spec 753 acceptance gate.
//
// Proves the C64 CPU memory-access capture (the single missing wire) end to end:
//   A) the CPU bus-trace harness now emits exact effective addresses for ALL
//      addressing modes — crucially `STA ($zp),Y` ($91), whose target the
//      instruction-decode path (pc/opcode/b1/b2) CANNOT resolve — plus the
//      pre-write `oldValue` (the mutation / persistence surface).
//   B) those accesses reach the trace-store `bus_events` table (DuckDB) via the
//      existing producer → chunk → store path, with the indirect EA present.
//   C) gating: a trace WITHOUT the `memory` domain emits ZERO bus rows (opt-in /
//      zero overhead).
//   D) `trace_memory_map` reconstructs the page map, surfaces the indirect write,
//      reports an untouched page free, and reconcile-with-static flags a
//      statically-owned-but-untouched page.  (added with P3)
//
// In-process (no daemon): startIntegratedSession({enableBusAccessTrace:true}) +
// ensureRuntimeController + ctrl.traceRun.start(captureAllDef(['c64-cpu','memory'])).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/runtime/headless/integrated-session-manager.js"))) {
  console.error("build:mcp first"); process.exit(2);
}

// ---- the fixture: abs, abs,X, zp, (zp),Y stores + a 2nd write for old≠new ----
// $C000 SEI                  ; no IRQ preemption while we step
//       LDA #$AA  STA $C800  ; absolute       → $C800 = $AA
//       LDX #$05  LDA #$BB  STA $C900,X       ; abs,X          → $C905 = $BB
//       LDA #$CC  STA $FB                     ; zero-page      → $00FB = $CC
//       LDA #$00 STA $FD  LDA #$C7 STA $FE     ; ptr $FD/$FE = $C700
//       LDY #$03  LDA #$DD  STA ($FD),Y        ; (zp),Y INDIRECT → $C703 = $DD
//       LDA #$EE  STA $C800                    ; 2nd abs write  → old=$AA new=$EE
//       BRK
const CODE = [
  0x78,
  0xa9, 0xaa, 0x8d, 0x00, 0xc8,
  0xa2, 0x05, 0xa9, 0xbb, 0x9d, 0x00, 0xc9,
  0xa9, 0xcc, 0x85, 0xfb,
  0xa9, 0x00, 0x85, 0xfd, 0xa9, 0xc7, 0x85, 0xfe,
  0xa0, 0x03, 0xa9, 0xdd, 0x91, 0xfd,
  0xa9, 0xee, 0x8d, 0x00, 0xc8,
  0x00,
];
const PRG = Buffer.from([0x00, 0xc0, ...CODE]);      // load $C000
const STEPS = 17;                                    // SEI..2nd STA $C800 (before BRK)
const EA = { abs: 0xc800, absX: 0xc905, zp: 0x00fb, indirect: 0xc703 };

const dir = mkdtempSync(join(tmpdir(), "c64re-753-"));
const prgPath = join(dir, "memfixture.prg");
writeFileSync(prgPath, PRG);

const { startIntegratedSession, stopIntegratedSession } =
  await import("../dist/runtime/headless/integrated-session-manager.js");

function loadFixture(session) {
  session.resetCold("pal-default");
  session.loadPrgIntoRam(prgPath);
  session.c64Cpu.pc = 0xc000;
}

// =====================================================================
// Part A — direct CPU bus-listener: deterministic EA + oldValue proof.
// =====================================================================
console.log("Spec 753 — Part A: CPU bus-trace EA capture (incl indirect)\n");
{
  const { session, sessionId } = startIntegratedSession({ enableBusAccessTrace: true });
  try {
    loadFixture(session);
    const writes = [];
    session.c64Cpu.addBusListener((ev) => { if (ev.kind === "WRITE") writes.push({ addr: ev.addr, value: ev.value, old: ev.oldValue }); });
    session.c64Cpu.enableBusTrace(true);
    for (let i = 0; i < STEPS; i++) session.stepC64Instruction();

    const find = (a, v) => writes.find((w) => w.addr === a && w.value === v);
    ok("A1 absolute STA $C800=$AA captured", !!find(EA.abs, 0xaa), `${writes.length} writes`);
    ok("A2 abs,X STA $C900,X → EA $C905=$BB captured", !!find(EA.absX, 0xbb));
    ok("A3 zero-page STA $FB=$CC captured", !!find(EA.zp, 0xcc));
    ok("A4 INDIRECT STA ($FD),Y → EA $C703=$DD captured (decode path cannot resolve this)", !!find(EA.indirect, 0xdd),
      writes.map((w) => "$" + w.addr.toString(16)).join(" "));
    const second = writes.find((w) => w.addr === EA.abs && w.value === 0xee);
    ok("A5 2nd STA $C800=$EE carries oldValue=$AA (mutation/persistence surface)", !!second && second.old === 0xaa,
      second ? `old=$${(second.old ?? -1).toString(16)}` : "missing");
    const ramWrite = find(EA.absX, 0xbb);
    ok("A6 RAM write (<$D000) has a defined oldValue (pre-read fired)", ramWrite && typeof ramWrite.old === "number");
  } finally { stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part B — real trace into the trace-store: bus_events holds the EAs.
// =====================================================================
console.log("\nSpec 753 — Part B: bus_events (DuckDB) holds exact EAs + old_value\n");
let storePathB, runIdB;
{
  const { ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
  const { captureAllDef } = await import("../dist/server-tools/runtime-trace-sink.js");
  const { session, sessionId } = startIntegratedSession({ enableBusAccessTrace: true });
  try {
    loadFixture(session);
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    storePathB = join(dir, "trace753.duckdb");
    const run = await ctrl.traceRun.start(captureAllDef(["c64-cpu", "memory"]), { controller: ctrl, outputPath: storePathB });
    runIdB = run.runId;
    for (let i = 0; i < STEPS; i++) session.stepC64Instruction();
    await ctrl.traceRun.stop();
    await ctrl.traceRun.awaitIndex();
  } finally { stopIntegratedSession(sessionId); }

  ok("B0 trace store written", storePathB && existsSync(storePathB), storePathB);
  try {
    const duckdb = await import("@duckdb/node-api");
    const inst = await duckdb.DuckDBInstance.create(storePathB, { access_mode: "READ_ONLY" });
    const conn = await inst.connect();
    const rows = (await conn.runAndReadAll(
      `SELECT addr, value, old_value FROM bus_events WHERE cpu='c64' AND kind='write' ORDER BY seq`
    )).getRows().map((r) => ({ addr: Number(r[0]), value: Number(r[1]), old: r[2] === null ? null : Number(r[2]) }));
    inst.closeSync?.();
    const has = (a, v) => rows.find((r) => r.addr === a && r.value === v);
    ok("B1 bus_events has absolute write $C800=$AA", !!has(EA.abs, 0xaa), `${rows.length} write rows`);
    ok("B2 bus_events has abs,X EA $C905=$BB", !!has(EA.absX, 0xbb));
    ok("B3 bus_events has zp write $00FB=$CC", !!has(EA.zp, 0xcc));
    ok("B4 bus_events has INDIRECT EA $C703=$DD (the row the decode path can't produce)", !!has(EA.indirect, 0xdd));
    const second = rows.find((r) => r.addr === EA.abs && r.value === 0xee);
    ok("B5 bus_events 2nd $C800 write old_value=$AA", !!second && second.old === 0xaa, second ? `old=${second.old}` : "missing");
  } catch (e) { ok("B1-B5 query bus_events", false, e.message); }
}

// =====================================================================
// Part C — gating: NO memory domain → zero bus rows (opt-in / no overhead).
// =====================================================================
console.log("\nSpec 753 — Part C: gating (no `memory` domain → zero bus rows)\n");
{
  const { ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
  const { captureAllDef } = await import("../dist/server-tools/runtime-trace-sink.js");
  const { session, sessionId } = startIntegratedSession({ enableBusAccessTrace: true });
  let storeC;
  try {
    loadFixture(session);
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    storeC = join(dir, "trace753-nomem.duckdb");
    await ctrl.traceRun.start(captureAllDef(["c64-cpu"]), { controller: ctrl, outputPath: storeC });
    for (let i = 0; i < STEPS; i++) session.stepC64Instruction();
    await ctrl.traceRun.stop();
    await ctrl.traceRun.awaitIndex();
  } finally { stopIntegratedSession(sessionId); }
  try {
    const duckdb = await import("@duckdb/node-api");
    const inst = await duckdb.DuckDBInstance.create(storeC, { access_mode: "READ_ONLY" });
    const conn = await inst.connect();
    const n = Number((await conn.runAndReadAll(`SELECT count(*) FROM bus_events WHERE cpu='c64' AND kind='write'`)).getRows()[0][0]);
    inst.closeSync?.();
    ok("C1 no `memory` domain → zero c64 write rows (channel stays off)", n === 0, `rows=${n}`);
  } catch (e) {
    // table may not exist at all when no bus capture — that's also a pass.
    ok("C1 no `memory` domain → zero c64 write rows (channel stays off)", /bus_events/.test(e.message), "no bus_events table");
  }
}

// =====================================================================
// Part D — trace_memory_map reconstruction + reconcile-with-static.
// =====================================================================
console.log("\nSpec 753 — Part D: trace_memory_map reconstruction + reconcile\n");
{
  const { buildMemoryMap, renderMemoryMap } = await import("../dist/server-tools/trace-memory-map.js");
  const duckdb = await import("@duckdb/node-api");
  const N = (v) => (v === null || v === undefined ? 0 : Number(v));
  try {
    const inst = await duckdb.DuckDBInstance.create(storePathB, { access_mode: "READ_ONLY" });
    const conn = await inst.connect();
    const aggSql = `SELECT (addr>>8) AS page, COUNT(*) FILTER (WHERE kind='write') AS writes, COUNT(*) FILTER (WHERE kind='read') AS reads, COUNT(*) FILTER (WHERE kind='write' AND old_value IS NOT NULL AND old_value<>value) AS mut, MIN(clock) AS f, MAX(clock) AS l, COUNT(DISTINCT pc) FILTER (WHERE kind='write') AS wp FROM bus_events WHERE cpu='c64' AND kind IN ('write','read') AND addr IS NOT NULL GROUP BY page ORDER BY page`;
    const codeSql = `SELECT DISTINCT (pc>>8) AS page FROM instructions WHERE cpu='c64' AND pc IS NOT NULL`;
    const aggRows = (await conn.runAndReadAll(aggSql)).getRows();
    const codeRows = (await conn.runAndReadAll(codeSql)).getRows();
    inst.closeSync?.();
    const pageRows = aggRows.map((r) => ({ page: N(r[0]), writes: N(r[1]), reads: N(r[2]), mutations: N(r[3]), firstClk: N(r[4]), lastClk: N(r[5]), writerPcs: N(r[6]) }));
    const codePages = new Set(codeRows.map((r) => N(r[0]) & 0xff));
    // static_ranges: claim page $05 is module-owned (it is untouched in the run → must
    // be flagged NOT provably free). Page $C0 is the executed code page.
    const map = buildMemoryMap({ cpu: "c64", pageRows, codePages, staticRanges: [{ from: 0x0500, to: 0x05ff, label: "fake-module" }] });
    const txt = renderMemoryMap(map, { runLabel: runIdB });

    ok("D1 map reconstructs all 256 pages", map.pages.length === 256);
    ok("D2 indirect target page $C7 classified DATA-W (the EA the decode path can't bind)", map.pages[0xc7].writes > 0 && /data-w/.test(map.pages[0xc7].role), `${map.pages[0xc7].role} w=${map.pages[0xc7].writes}`);
    ok("D2b executed page $C0 classified CODE", /code/.test(map.pages[0xc0].role), map.pages[0xc0].role);
    ok("D3 an untouched page is reported provably-free", map.freeHoles.length > 0 && map.totals.freePages > 0, `${map.totals.freePages} free pages`);
    ok("D4 EF-legal free hole present (<$8000 or $C000-CFFF)", map.freeHoles.some((h) => h.efLegal));
    ok("D5 reconcile flags static-owned-but-untouched page $0500", map.staticUntouched.some((p) => p.page === 0x05), map.staticUntouched.map((p) => "$" + p.page.toString(16)).join(" "));
    ok("D6 static-owned page $05 is NOT provably free", map.pages[0x05].provablyFree === false);
    ok("D7 mandatory coverage banner present (run-only + Spec 752 boundary)", /COVERAGE = THIS RUN ONLY/.test(txt) && /Spec 752/.test(txt));
    ok("D8 ASCII page grid rendered (16 rows)", /page map/.test(txt) && txt.split("\n").filter((l) => /\$[0-9A-F]x00/.test(l)).length === 16);
  } catch (e) { ok("D1-D8 trace_memory_map", false, e.message); }
}

globalThis.__store753 = storePathB; globalThis.__run753 = runIdB; globalThis.__dir753 = dir;

console.log("\n---");
if (fail.length === 0) { console.log(`GREEN e2e:753 — ${pass} checks pass.`); process.exit(0); }
console.log(`RED: ${pass} pass, ${fail.length} fail → ${fail.join(", ")}`); process.exit(1);
