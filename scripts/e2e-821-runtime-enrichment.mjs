#!/usr/bin/env node
// Spec 821 — the runtime producer, against a synthetic capture and a graph the
// static slices could have seeded. No daemon: the runtime endpoint is pointed at a
// closed port and `runtimeDaemon.traceRead` is spied on — it must never be called.
//
//   capture (encoded with the repo's own encoders, in the producer's record order —
//   the accesses of an instruction, THEN its retiring CPU_STEP, bus pc = live pc):
//     $1000 ldy #0 ; $1002/$1005/$1008 lda ($20),y → $A734 $A735 $A736
//     $100C sta $D018 ×3, values $15 $15 $1D
//     $1011 sta ($FB),y → $0400 (old $20)
//     IRQ entry (3 pushes, SP delta 3) → $1020 inc $D019 ; $1023 rti
//     $1013 jsr $1030 ; $1030 lda $A000 ; $1035 sta $01 ← $35 ; $1037 lda $A000 ; rts
//     $2000 sta $D020 — a pc no routine contains and no static edge names
//   static side seeded directly (819 routines, 820-shaped access edges) — hermetic.
//
//   asserts: D2 rows (count, values, via_zp, flow, bank_ctx), D3 (static rows byte-
//   identical after import, both origins from writers(), a forged origin refused),
//   D6 (same file twice = same dump hash; same runId different bytes = replaced;
//   removal), D7 (HANDLES_IRQ), the §4 invariant, empty stderr.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:821

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------- no daemon, and a spy on the one DuckDB door
process.env.C64RE_RUNTIME_ENDPOINT = "ws://127.0.0.1:1";
process.env.C64RE_RUNTIME_AUTOSTART = "0";
const ROOT = resolve(import.meta.dirname, "..");
const { runtimeDaemon } = await import(join(ROOT, "dist/runtime/daemon-client.js"));
let traceReadCalls = 0;
runtimeDaemon.traceRead = async () => { traceReadCalls += 1; throw new Error("trace/read must not be called by the 821 importer"); };

const { importRuntimeTrace, removeRuntimeRun, runNodeIdFor } = await import(join(ROOT, "dist/knowledge-graph/producers/runtime.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { pointerTargets, runtimeObservations, runs, unconfirmed, unexplained, irqHandlers, executions } = await import(join(ROOT, "dist/knowledge-graph/query-runtime.js"));
const { encodeFileHeader, encodeCpuStep, encodeMemAccess, encodeMark, TraceOp, ACCESS_READ, ACCESS_WRITE } = await import(join(ROOT, "dist/trace/binary-format.js"));
const { IdRuleError } = await import(join(ROOT, "dist/knowledge-graph/ids.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const hex = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;

// ---------------------------------------------------------------- project + the static side
const project = mkdtempSync(join(tmpdir(), "c64re-821-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 821 fixture", slug: "s821", rootPath: project }));

const R = (a) => `s821:ram/fixture:routine:${a}`;
const MAIN = R("1000"), HANDLER = R("1020"), BANK = R("1030");
let store = GraphStore.open(project);
store.replaceGenerated("819", "fixture", [
  { id: MAIN, kind: "routine", name: "W1000", endAddress: 0x1017, attrs: { entry_source: "load", provenance: "confirmed_code" }, origin: "static", confidence: "certain" },
  { id: HANDLER, kind: "routine", name: "W1020", endAddress: 0x1023, attrs: { provenance: "confirmed_code" }, origin: "static", confidence: "certain" },
  { id: BANK, kind: "routine", name: "W1030", endAddress: 0x103a, attrs: { provenance: "confirmed_code" }, origin: "static", confidence: "certain" },
], [
  { from: MAIN, type: "CALLS", to: BANK, evidenceKey: "src:1013", origin: "static", confidence: "certain", evidence: { source_address: 0x1013, mnemonic: "jsr", instruction: "jsr $1030" } },
]);
// what a memory-access producer (820) would have written: the claim, with the target unknown where it is unknown
const st = (from, type, to, pc, extra, confidence = "certain") => ({ from, type, to, evidenceKey: `pc:${pc.toString(16).padStart(4, "0")}`, origin: "static", confidence, evidence: { pc, ...extra } });
store.replaceGenerated("820", "fixture", [], [
  st(MAIN, "READS_INDIRECT", "c64:zp:0020", 0x1002, { pointer_zp: 0x20, mnemonic: "lda", addr_mode: "(zp),y" }, "heuristic"),
  st(MAIN, "READS_INDIRECT", "c64:zp:0020", 0x1005, { pointer_zp: 0x20, mnemonic: "lda", addr_mode: "(zp),y" }, "heuristic"),
  st(MAIN, "READS_INDIRECT", "c64:zp:0020", 0x1008, { pointer_zp: 0x20, mnemonic: "lda", addr_mode: "(zp),y" }, "heuristic"),
  st(MAIN, "WRITES", "c64:io:d018", 0x100c, { mnemonic: "sta", addr_mode: "abs" }),
  st(MAIN, "WRITES_INDIRECT", "c64:zp:00fb", 0x1011, { pointer_zp: 0xfb, mnemonic: "sta", addr_mode: "(zp),y" }, "heuristic"),
  st(HANDLER, "READS", "c64:io:d019", 0x1020, { mnemonic: "inc", addr_mode: "abs" }),
  st(HANDLER, "WRITES", "c64:io:d019", 0x1020, { mnemonic: "inc", addr_mode: "abs" }),
  st(BANK, "READS", "c64:rom:a000", 0x1030, { mnemonic: "lda", addr_mode: "abs" }),
  st(BANK, "WRITES", "c64:zp:0001", 0x1035, { mnemonic: "sta", addr_mode: "zp" }),
  st(BANK, "READS", "c64:rom:a000", 0x1037, { mnemonic: "lda", addr_mode: "abs" }),
]);
const staticDump = (s) => s.canonicalDump().split("\n").filter((l) => l && !l.includes('"producer":"821"')).join("\n");
const staticBefore = staticDump(store);
const staticRowsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer <> '821'").get().n;
store.close();

// ---------------------------------------------------------------- the capture
const RUN_ID = "run_s821_fixture";
function buildCapture({ extraTail = false } = {}) {
  const header = encodeFileHeader({ runId: RUN_ID, defId: "d821", defVersion: 1, defName: "821 fixture", defJson: "{}", domains: ["c64-cpu", "memory"], cycleStart: 0, createdAt: "2026-09-06T00:00:00.000Z" });
  const buf = new Uint8Array(8192);
  const dv = new DataView(buf.buffer);
  let off = 0;
  let cycle = 0;
  const step = (pc, opcode, { a = 0, x = 0, y = 0, sp = 0xfd, p = 0x24, b1 = 0, b2 = 0, dc = 2 } = {}) => {
    cycle += dc;
    off = encodeCpuStep(dv, off, buf.length, TraceOp.CPU_STEP, cycle, pc, opcode, a, x, y, sp, p, b1, b2);
  };
  // the bus pc is the LIVE pc: already past the operand bytes — the producer's convention
  const rd = (addr, value, livePc) => { cycle += 1; off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, cycle, addr, value, livePc, ACCESS_READ); };
  const wr = (addr, value, livePc, old) => { cycle += 1; off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, cycle, addr, value, livePc, ACCESS_WRITE, old); };

  step(0x1000, 0xa0, { b1: 0 });                                                   // ldy #0
  rd(0x20, 0x34, 0x1004); rd(0x21, 0xa7, 0x1004); rd(0xa734, 0x11, 0x1004); step(0x1002, 0xb1, { a: 0x11, y: 0, b1: 0x20 });
  step(0x1004, 0xc8, { a: 0x11, y: 1, dc: 1 });                                     // iny
  rd(0x20, 0x34, 0x1007); rd(0x21, 0xa7, 0x1007); rd(0xa735, 0x22, 0x1007); step(0x1005, 0xb1, { a: 0x22, y: 1, b1: 0x20 });
  step(0x1007, 0xc8, { a: 0x22, y: 2, dc: 1 });
  rd(0x20, 0x34, 0x100a); rd(0x21, 0xa7, 0x100a); rd(0xa736, 0x33, 0x100a); step(0x1008, 0xb1, { a: 0x33, y: 2, b1: 0x20 });
  for (const v of [0x15, 0x15, 0x1d]) {
    step(0x100a, 0xa9, { a: v, y: 2, b1: v });                                       // lda #v
    wr(0xd018, v, 0x100f); step(0x100c, 0x8d, { a: v, y: 2, b1: 0x18, b2: 0xd0 });  // sta $D018 (I/O: no old value)
  }
  step(0x100f, 0xa9, { a: 0, y: 0, b1: 0 });                                        // lda #0 (y reset for the fixture)
  rd(0xfb, 0x00, 0x1013); rd(0xfc, 0x04, 0x1013); wr(0x0400, 0x00, 0x1013, 0x20); step(0x1011, 0x91, { a: 0, y: 0, b1: 0xfb });
  off = encodeMark(dv, off, buf.length, cycle, "fixture");
  // hardware IRQ: PCH, PCL, P pushed, then the handler's first instruction retires with SP 3 lower
  wr(0x01fd, 0x10, 0x1020, 0xff); wr(0x01fc, 0x13, 0x1020, 0xff); wr(0x01fb, 0x24, 0x1020, 0xff);
  rd(0xd019, 0x81, 0x1023); wr(0xd019, 0x81, 0x1023); step(0x1020, 0xee, { sp: 0xfa, b1: 0x19, b2: 0xd0, dc: 6 }); // inc $D019
  rd(0x01fb, 0x24, 0x1024); rd(0x01fc, 0x13, 0x1024); rd(0x01fd, 0x10, 0x1024); step(0x1023, 0x40, { sp: 0xfd, dc: 6 }); // rti
  wr(0x01ff, 0x10, 0x1015, 0xff); wr(0x01fe, 0x15, 0x1015, 0xff); step(0x1013, 0x20, { sp: 0xfb, b1: 0x30, b2: 0x10, dc: 6 }); // jsr $1030
  rd(0xa000, 0x94, 0x1033); step(0x1030, 0xad, { a: 0x94, sp: 0xfb, b1: 0x00, b2: 0xa0 });                                // lda $A000 (ROM, $01 still the default)
  step(0x1033, 0xa9, { a: 0x35, sp: 0xfb, b1: 0x35 });                                                                        // lda #$35
  wr(0x0001, 0x35, 0x1037, 0x37); step(0x1035, 0x85, { a: 0x35, sp: 0xfb, b1: 0x01 });                                       // sta $01
  rd(0xa000, 0x00, 0x103a); step(0x1037, 0xad, { a: 0x00, sp: 0xfb, b1: 0x00, b2: 0xa0 });                                    // lda $A000 (RAM under ROM now)
  rd(0x01fe, 0x15, 0x103b); rd(0x01ff, 0x10, 0x103b); step(0x103a, 0x60, { sp: 0xfd, dc: 6 });                                // rts
  wr(0xd020, 0x00, 0x2003); step(0x2000, 0x8d, { b1: 0x20, b2: 0xd0 });                                                        // sta $D020 — nobody's routine
  if (extraTail) { wr(0xd020, 0x01, 0x2003); step(0x2000, 0x8d, { a: 1, b1: 0x20, b2: 0xd0 }); }

  const file = new Uint8Array(header.length + off);
  file.set(header, 0);
  file.set(buf.subarray(0, off), header.length);
  return file;
}
mkdirSync(join(project, "traces"), { recursive: true });
const tracePath = join(project, "traces", "fixture.c64retrace");
writeFileSync(tracePath, buildCapture());

// ---------------------------------------------------------------- import
const r1 = importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture" });
console.log(`  info  import: events=${r1.eventCount} steps=${r1.cpuSteps} accesses=${r1.accesses} rows=${JSON.stringify(r1.rows)} addr=${r1.addrNodes} notes=${JSON.stringify(r1.notes)} pc_source=${r1.pcSource} ${r1.ms.toFixed(1)} ms`);
check(r1.runId === RUN_ID && r1.runNodeId === runNodeIdFor("s821", RUN_ID), `run node ${r1.runNodeId} (D6)`);
check(r1.pcSource === "retire", "accesses attributed to the retiring CPU_STEP, not the bus pc");

const RUN = r1.runNodeId;
let graph = Graph.open(project);
const ev = (e) => e.evidence;
const invariant = (db) => Number(db.prepare("SELECT (SELECT COUNT(*) FROM edges WHERE producer='821' AND (origin<>'runtime' OR confidence<>'observed' OR layer<>'generated')) + (SELECT COUNT(*) FROM nodes WHERE producer='821' AND (origin<>'runtime' OR confidence<>'observed' OR layer<>'generated')) AS n").get().n);
check(invariant(graph.store.db) === 0, "invariant: producer='821' ⇒ origin=runtime ∧ confidence=observed ∧ layer=generated (0 violations)");

// D2/D3 — the indirect reads, confirmed beside the static unknown
const out = graph.edgesOutOf(MAIN).filter((e) => e.origin === "runtime");
const a7 = out.filter((e) => e.type === "READS" && ev(e).via_zp === 0x20 && !ev(e).role).sort((a, b) => ev(a).ea - ev(b).ea);
check(a7.length === 3 && a7.map((e) => ev(e).ea).join() === [0xa734, 0xa735, 0xa736].join(), `three runtime READS through $20 → $A734 $A735 $A736 (${a7.map((e) => hex(ev(e).ea)).join(" ")})`);
check(a7.every((e) => e.origin === "runtime" && e.confidence === "observed" && ev(e).count === 1 && ev(e).run_id === RUN_ID && ev(e).flow === "main"), "each carries origin=runtime · observed · count=1 · run_id · flow=main");
check(a7.every((e) => ev(e).mnemonic === "lda" && ev(e).addr_mode === "(zp),y" && ev(e).bank_ctx_conf === "inferred"), "instruction from the retiring step (lda (zp),y); bank_ctx inferred before any $01 write");
const ptr = out.filter((e) => e.type === "READS" && ev(e).role === "pointer");
const ptrEas = [...new Set(ptr.map((e) => ev(e).ea))].sort((a, b) => a - b);
check(ptr.length === 8 && ptrEas.join() === [0x20, 0x21, 0xfb, 0xfc].join() && ptr.every((e) => ev(e).count === 1), `pointer fetches are their own rows per pc, role=pointer (8 rows over ${ptrEas.map(hex).join(" ")})`);
const indirectStatic = graph.edgesOutOf(MAIN).filter((e) => e.type === "READS_INDIRECT");
check(indirectStatic.length === 3 && indirectStatic.every((e) => e.origin === "static" && e.confidence === "heuristic"), "the static READS_INDIRECT rows are still there — static · heuristic (D3: confirms, never promotes)");

// D2/D3 — $D018: count 3, values [21,29]; writers() returns both origins
const w18 = graph.writers("$D018");
const rt18 = w18.filter((e) => e.origin === "runtime");
const st18 = w18.filter((e) => e.origin === "static");
check(rt18.length === 1 && ev(rt18[0]).count === 3 && JSON.stringify(ev(rt18[0]).values) === "[21,29]", `runtime WRITES($D018): count=3 values=[21,29] (${JSON.stringify(ev(rt18[0])?.values)})`);
check(st18.length === 1 && st18[0].confidence === "certain", "the static WRITES($D018) row is still certain");
check(w18.length === 2 && rt18[0].from === MAIN && st18[0].from === MAIN, "writers($D018) returns both rows, from the same routine, each labelled by origin (D1)");
check(rt18[0].evidenceKey === `run:${RUN_ID}:pc:100c`, `evidence_key = run:<run_id>:pc:<hex4> (${rt18[0].evidenceKey})`);

// D7 — IRQ
const d19 = graph.edgesInto("c64:io:d019").filter((e) => e.origin === "runtime" && (e.type === "READS" || e.type === "WRITES"));
check(d19.length === 2 && d19.every((e) => ev(e).flow === "irq" && e.from === HANDLER), `inc $D019: READS + WRITES rows carry flow=irq from the handler routine (${d19.map((e) => e.type).join("+")})`);
const irqs = irqHandlers(graph);
check(irqs.length === 1 && irqs[0].type === "HANDLES_IRQ" && irqs[0].from === RUN && irqs[0].to === HANDLER && ev(irqs[0]).count === 1, `HANDLES_IRQ run → ${HANDLER}, count=1`);
const pushes = graph.edgesOutOf(HANDLER).filter((e) => e.origin === "runtime" && ev(e).role === "interrupt-push");
check(pushes.length === 3 && pushes.every((e) => ev(e).ea >= 0x1fb && ev(e).ea <= 0x1fd), "the three entry pushes are labelled role=interrupt-push, not data");

// D5 — bank context
const a000 = graph.edgesOutOf(BANK).filter((e) => e.origin === "runtime" && e.type === "READS" && ev(e).ea === 0xa000).sort((a, b) => ev(a).pc - ev(b).pc);
check(a000.length === 2, `two $A000 reads from the bank routine (${a000.length})`);
check(a000[0] && ev(a000[0]).pc === 0x1030 && a000[0].to === "c64:rom:a000" && ev(a000[0]).bank_ctx === "01=37 dd00=97 cart=-" && ev(a000[0]).bank_ctx_conf === "inferred", `before the $01 write: → c64:rom:a000, bank_ctx "01=37 dd00=97 cart=-" inferred`);
check(a000[1] && ev(a000[1]).pc === 0x1037 && a000[1].to === "s821:ram:addr:a000" && ev(a000[1]).bank_ctx === "01=35 dd00=97 cart=-" && ev(a000[1]).bank_ctx_conf === "observed", `after sta $01 ← $35: → s821:ram:addr:a000 (RAM under ROM), bank_ctx "01=35 …" observed`);
const w01 = graph.edgesOutOf(BANK).filter((e) => e.origin === "runtime" && e.type === "WRITES" && ev(e).ea === 1);
check(w01.length === 1 && w01[0].to === "c64:zp:0001" && ev(w01[0]).mutations === 1 && JSON.stringify(ev(w01[0]).values) === "[53]", "the $01 write itself: → c64:zp:0001, mutations=1, values=[53]");

// the sta ($FB),y observation; the pc nobody owns
const fb = out.filter((e) => e.type === "WRITES" && ev(e).via_zp === 0xfb);
check(fb.length === 1 && fb[0].to === "c64:ram:0400" && ev(fb[0]).mutations === 1 && ev(fb[0]).note === undefined, `sta ($FB),y → c64:ram:0400 (VICSCN), mutations=1, no note`);
const stray = graph.edgesOutOf("s821:ram:addr:2000").filter((e) => e.origin === "runtime");
check(stray.some((e) => e.type === "WRITES" && e.to === "c64:io:d020" && ev(e).note === "no static edge"), "sta $D020 at $2000: from the addr node, note='no static edge'");
check(!graph.resolve("s821:ram:addr:2000").dangling && graph.resolve("s821:ram:addr:2000").kind === "addr", "the addr node for $2000 exists (shared, ownerless)");
const ex = executions(graph, MAIN);
check(ex.length === 1 && ex[0].from === RUN && ev(ex[0]).steps === 15 && ev(ex[0]).distinct_pcs === 11, `EXECUTES run → main: steps=15 distinct_pcs=11 (${ev(ex[0])?.steps}/${ev(ex[0])?.distinct_pcs})`);
const uz = graph.edgesOutOf(MAIN).filter((e) => e.type === "USES_ZP" && e.origin === "runtime" && ev(e).ea === 0x20);
const uh = graph.edgesOutOf(MAIN).filter((e) => e.type === "USES_HARDWARE" && e.origin === "runtime" && e.to === "c64:io:d018");
check(uz.length === 3 && uz.reduce((n, e) => n + ev(e).reads, 0) === 3 && uh.length === 1 && ev(uh[0]).writes === 3, `USES_ZP($20): 3 rows (one per pc), 3 reads; USES_HARDWARE($D018): writes=3 — derived from the READS/WRITES rows`);
const stackRows = graph.edgesOutOf(BANK).filter((e) => e.origin === "runtime" && ev(e).role === "stack");
check(stackRows.length === 2 && stackRows.every((e) => e.type === "READS" && ev(e).pc === 0x103a && ev(e).note === undefined), "rts pops are role=stack rows and carry no 'no static edge' note (implied, 820 OQ2)");

// queries (§5)
const pt20 = pointerTargets(graph, "$20");
check(pt20.length === 1 && pt20[0].spans.length === 1 && pt20[0].spans[0].start === 0xa734 && pt20[0].spans[0].end === 0xa736 && pt20[0].spans[0].reads === 3 && pt20[0].spans[0].distinct === 3, `pointerTargets($20) → one span $A734-$A736, 3 reads, 3 distinct`);
const ptfb = pointerTargets(graph, 0xfb);
check(ptfb[0]?.spans.length === 1 && ptfb[0].spans[0].start === 0x400 && ptfb[0].spans[0].writes === 1, "pointerTargets($FB) → $0400, 1 write");
const obs = runtimeObservations(graph, MAIN);
check(Object.keys(obs.byRun).length === 1 && obs.byRun[RUN_ID].length === out.length + 1 && obs.byRun[RUN_ID].some((o) => o.type === "EXECUTES"), `runtimeObservations(main) grouped by run: ${obs.byRun[RUN_ID]?.length} rows under ${RUN_ID}`);
const obsD018 = runtimeObservations(graph, "$D018");
check(obsD018.byRun[RUN_ID]?.some((o) => o.type === "WRITES" && o.count === 3), "runtimeObservations($D018) finds the WRITES row by address");
const uc = unconfirmed(graph, MAIN);
check(uc.notSeen.length === 0 && uc.confirmed.length === 5 && uc.executedIn.join() === RUN_ID, `unconfirmed(main): 0 not seen, 5 confirmed, executed in ${uc.executedIn.join()}`);
const ucH = unconfirmed(graph, HANDLER);
check(ucH.notSeen.length === 0 && ucH.confirmed.length === 2, "unconfirmed(handler): the inc $D019 pair confirmed");
const ux = unexplained(graph, RUN_ID);
check(ux.length === 2 && ux.every((o) => o.pc === 0x2000 && o.note === "no static edge") && r1.notes.noStaticEdge === 1, `unexplained(run) = the $2000 rows only (${ux.length}: ${ux.map((o) => o.type).join("+")})`);
check(runs(graph).length === 1 && runs(graph)[0].runId === RUN_ID && runs(graph)[0].attrs.cpu_steps === r1.cpuSteps && runs(graph)[0].attrs.marks.join() === "fixture", "runs() lists the run node with its header, counts and MARK labels");
graph.close();

// ---------------------------------------------------------------- D3 — confirmation adds rows, never updates
store = GraphStore.open(project);
check(staticDump(store) === staticBefore, "every non-821 row is byte-identical after the import (confirmation = a new row, never an update)");
check(Number(store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer <> '821'").get().n) === Number(staticRowsBefore), `static row count unchanged (${staticRowsBefore})`);
const h1 = store.contentHash();
const c1 = store.counts();
store.close();

// ---------------------------------------------------------------- D6 — idempotence, replacement, removal
importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture" });
store = GraphStore.open(project);
check(store.contentHash() === h1, `same file twice → identical canonical dump (${h1.slice(0, 16)})`);
check(JSON.stringify(store.counts()) === JSON.stringify(c1), `same file twice → same row counts (${c1.nodes} nodes, ${c1.edges} edges)`);
store.close();

// forged origin / confidence: refused, nothing written
for (const forged of [{ origin: "static" }, { confidence: "certain" }]) {
  let threw;
  try { importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture", ...forged }); } catch (e) { threw = e; }
  check(threw instanceof IdRuleError && /^runtime-/u.test(threw.rule), `importRuntimeTrace(${JSON.stringify(forged)}) is refused by name (${threw?.rule})`);
}
store = GraphStore.open(project);
check(store.contentHash() === h1, "the refused imports wrote nothing (dump hash unchanged)");
graph = Graph.open(project);
check(invariant(graph.store.db) === 0, "invariant still 0 after the refusals");
graph.close();
store.close();

// same runId, different bytes → replaced in place, no orphans
writeFileSync(tracePath, buildCapture({ extraTail: true }));
const r2 = importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture" });
graph = Graph.open(project);
const ownerRows2 = Number(graph.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer='821' AND owner=?").get(RUN_ID).n);
const stray2 = graph.edgesOutOf("s821:ram:addr:2000").find((e) => e.type === "WRITES" && e.origin === "runtime");
check(ownerRows2 === Object.values(r2.rows).reduce((x, y) => x + y, 0) - r2.rows.collapsedSpans && ev(stray2).count === 2 && JSON.stringify(ev(stray2).values) === "[0,1]", `same runId, different bytes → the run's rows replaced (${ownerRows2} rows, $D020 count now 2, values [0,1])`);
check(runs(graph)[0].attrs.cycle_end === r2.cycleEnd && r2.cycleEnd > r1.cycleEnd, `the Run node is updated in place (cycle_end ${r1.cycleEnd} → ${r2.cycleEnd})`);
check(Number(graph.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='run'").get().n) === 1, "one run node, not two");
graph.close();

const rm = removeRuntimeRun(project, RUN_ID);
graph = Graph.open(project);
check(rm.deletedEdges === ownerRows2 && Number(graph.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer='821'").get().n) === 0 && Number(graph.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='run'").get().n) === 0, `removing the run removes its ${rm.deletedEdges} edges and the run node`);
check(graph.edgesOutOf(MAIN).filter((e) => e.origin === "static").length === 6 && !graph.resolve("s821:ram:addr:2000").dangling, "static rows and the shared addr node survive the removal");
graph.close();

// ---------------------------------------------------------------- no daemon
check(traceReadCalls === 0, "runtimeDaemon.traceRead was never called (D4: the binary log, never the DuckDB)");

// ---------------------------------------------------------------- stderr must be empty (a child process, so the warning filter is exercised)
{
  const child = mkdtempSync(join(tmpdir(), "c64re-821-child-"));
  mkdirSync(join(child, "knowledge"), { recursive: true });
  writeFileSync(join(child, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "c", name: "child", slug: "s821c", rootPath: child }));
  const script = `
    import { importRuntimeTrace } from ${JSON.stringify(join(ROOT, "dist/knowledge-graph/producers/runtime.js"))};
    import { Graph } from ${JSON.stringify(join(ROOT, "dist/knowledge-graph/query.js"))};
    import { pointerTargets } from ${JSON.stringify(join(ROOT, "dist/knowledge-graph/query-runtime.js"))};
    const r = importRuntimeTrace({ projectDir: ${JSON.stringify(child)}, tracePath: ${JSON.stringify(tracePath)} });
    const g = Graph.open(${JSON.stringify(child)});
    process.stdout.write(JSON.stringify({ rows: r.rows, spans: pointerTargets(g, "$20")[0].spans.length }));
    g.close();`;
  let stdout = "", stderr = "";
  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, C64RE_RUNTIME_ENDPOINT: "ws://127.0.0.1:1", C64RE_RUNTIME_AUTOSTART: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { stderr = `${e.stderr ?? ""}${e.message}`; }
  const parsed = (() => { try { return JSON.parse(stdout); } catch { return undefined; } })();
  check(stderr === "" && parsed && parsed.spans === 1, `child import + query: stderr empty, output ${stdout.slice(0, 80)}${stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""}`);
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 821: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
