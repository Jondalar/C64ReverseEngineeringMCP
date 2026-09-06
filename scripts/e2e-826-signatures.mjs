#!/usr/bin/env node
// Spec 826 — routine signatures, against the §5 fixture analysed by the real
// pipeline and seeded by the real producers (819 → 820 → 826.0 resolve → 826).
//
//   $1000 entry:   lda #$01 ; ldx #$12 ; ldy #$05 ; jsr $1100 ; bcs err ; sta $FC ; jsr $FFD2 ; err: rts
//   $1020 caller2: lda #$02 ; ldx #$13 ; ldy #$00 ; jsr $1100 ; rts
//   $1030 caller3: lda #$03 ; jsr $1100 ; rts
//   $1100 svc:     sta $F3 ; stx $F4 ; sty $F5 ; lda $F3 ; cmp #$03 ; beq fin ; lda ($F4),y ; clc ; rts ; fin: sec ; rts
//   $1140 keep:    pha ; txa ; pha ; lda #$00 ; sta $D020 ; pla ; tax ; pla ; rts
//   $1160 disp:    lda #$11 ; pha ; lda #$7F ; pha ; rts
//   $1180 tgt:     rts
//   $1190 patch:   lda #$07 ; sta $11A1 ; jsr $11A0 ; rts
//   $11A0 usesop:  lda #$00 ; rts
//   $11B0 caller4: pla ; pla ; rts
//   $11C0 partial: jsr $3000 ; rts
//
// Every §5 assert except the runtime one (`args_observed`, another slice).
// Exit 0 = pass, 1 = fail.   npm run e2e:826

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
const { resolveAddresses } = await import(join(ROOT, "dist/knowledge-graph/producers/resolve.js"));
const { seedSignatures } = await import(join(ROOT, "dist/knowledge-graph/producers/signatures.js"));
const { signatureOf, argsDomain, formatSignature, formatArgs } = await import(join(ROOT, "dist/knowledge-graph/query-signatures.js"));
const { effects, MNEMONICS } = await import(join(ROOT, "dist/knowledge-graph/isa-6502.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const setEq = (xs, ys) => xs.length === ys.length && [...xs].sort().every((x, i) => x === [...ys].sort()[i]);

// ---------------------------------------------------------------- fixture

const project = mkdtempSync(join(tmpdir(), "c64re-826-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
mkdirSync(join(project, "analysis"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 826 fixture", slug: "s826", rootPath: project }));

const image = new Uint8Array(0x200).fill(0xea); // $1000-$11FF, NOPs
const put = (addr, bytes) => image.set(bytes, addr - 0x1000);
put(0x1000, [0xa9, 0x01, 0xa2, 0x12, 0xa0, 0x05, 0x20, 0x00, 0x11, 0xb0, 0x05, 0x85, 0xfc, 0x20, 0xd2, 0xff, 0x60]);
put(0x1020, [0xa9, 0x02, 0xa2, 0x13, 0xa0, 0x00, 0x20, 0x00, 0x11, 0x60]);
put(0x1030, [0xa9, 0x03, 0x20, 0x00, 0x11, 0x60]);
put(0x1100, [0x85, 0xf3, 0x86, 0xf4, 0x84, 0xf5, 0xa5, 0xf3, 0xc9, 0x03, 0xf0, 0x04, 0xb1, 0xf4, 0x18, 0x60, 0x38, 0x60]);
put(0x1140, [0x48, 0x8a, 0x48, 0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x68, 0xaa, 0x68, 0x60]);
put(0x1160, [0xa9, 0x11, 0x48, 0xa9, 0x7f, 0x48, 0x60]);
put(0x1180, [0x60]);
put(0x1190, [0xa9, 0x07, 0x8d, 0xa1, 0x11, 0x20, 0xa0, 0x11, 0x60]);
put(0x11a0, [0xa9, 0x00, 0x60]);
put(0x11b0, [0x68, 0x68, 0x60]);
put(0x11c0, [0x20, 0x00, 0x30, 0x60]);
const prg = new Uint8Array(image.length + 2);
prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
const prgPath = join(project, "analysis", "fixture.prg");
const analysisPath = join(project, "analysis", "fixture_analysis.json");
writeFileSync(prgPath, prg);
// every routine of the fixture is an entry point: 819 makes routine nodes of entries and jsr targets, and $1180 is
// reached only through the rts-dispatch, $1140 / $11B0 by nobody
execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000,1020,1030,1100,1140,1160,1180,1190,11a0,11b0,11c0"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });

const cf = seedControlFlow({ projectDir: project, analysisPath });
const ma = seedMemoryAccess({ projectDir: project, analysisPath });
const rs = resolveAddresses(project);
const r1 = seedSignatures({ projectDir: project });
console.log(`  info  819: routines=${cf.routines} edges=${JSON.stringify(cf.edges)} | 820: edges=${JSON.stringify(ma.edges)} | resolve: ${rs.resolved}`);
console.log(`  info  826: routines=${r1.routines} signed=${r1.signed} partial=${r1.partial} unknownStack=${r1.unknownStack} passes=${r1.passes} dispatches=${r1.dispatches} sccRounds=${r1.sccRounds} ${r1.ms.toFixed(1)} ms`);

const R = (a) => `s826:ram/fixture:routine:${a}`;
let graph = Graph.open(project);
const sig = (a) => signatureOf(graph, R(a));
const locs = (xs) => (xs ?? []).map((x) => x.loc);

// ---- the ISA table covers the whole opcode table
check(MNEMONICS.length === 75, `isa-6502: ${MNEMONICS.length} mnemonics (56 documented + 19 undocumented)`);
const adc = effects("adc", "abs");
check(setEq(adc.reads, ["A", "C"]) && setEq(adc.writes, ["A", "N", "Z", "C", "V"]) && adc.memRead && !adc.memWrite, "effects(adc abs): reads A C, writes A N Z C V, reads the cell");
const aslA = effects("asl", "acc");
check(aslA.reads.includes("A") && aslA.writes.includes("A") && !aslA.memRead && !aslA.memWrite, "effects(asl acc): A in and out, no memory");
check(effects("lda", "(zp),y").reads.includes("Y") && effects("sta", "abs,x").reads.includes("X"), "index registers are read by their modes");
check(Number.isNaN(effects("txs", "impl").stack) && effects("jsr", "abs").stack === 2 && effects("rti", "impl").stack === -3 && effects("jam", "impl").terminal === true, "stack deltas and terminals");

// ---- svc
const svc = sig("1100");
check(svc !== undefined, "svc $1100 has a signature");
console.log(`  info  svc: ${svc ? formatSignature(svc) : "—"}`);
check(svc && setEq(locs(svc.in), ["A", "X", "Y"]), `svc.in = {A, X, Y} (${locs(svc?.in).join(" ")})`);
check(svc && svc.in.every((i) => i.confidence === "certain"), "svc.in all certain");
check(svc && svc.in.find((i) => i.loc === "A")?.first_use === "$1100 sta $F3", `svc.in A first_use "$1100 sta $F3" (${svc?.in.find((i) => i.loc === "A")?.first_use})`);
for (const l of ["zp:$F3", "zp:$F4", "zp:$F5", "C"]) check(svc && locs(svc.out).includes(l), `svc.out ∋ ${l}`);
check(svc && !locs(svc.in).includes("Z") && !locs(svc.in).includes("N"), "Z / N not in svc.in");
check(svc && svc.stack.balanced && svc.stack.delta === 0 && svc.partial === null, "svc: stack balanced, not partial");
check(svc && svc.out.find((o) => o.loc === "C")?.last_def !== undefined, `svc.out C last_def ${svc?.out.find((o) => o.loc === "C")?.last_def}`);

// ---- keep
const keep = sig("1140");
console.log(`  info  keep: ${keep ? formatSignature(keep) : "—"}`);
check(keep && setEq(keep.preserves, ["A", "X"]), `keep.preserves = {A, X} (${keep?.preserves.join(" ")})`);
check(keep && !locs(keep.in).includes("A") && !locs(keep.in).includes("X"), "keep.in has neither A nor X (the push is a save, not a use)");
check(keep && !keep.clobbers.includes("A") && !keep.clobbers.includes("X") && keep.stack.balanced, "keep: preserved registers are not clobbers; stack balanced");
check(keep && locs(keep.out).includes("mem:$D020"), "keep.out ∋ mem:$D020");

// ---- disp
const disp = sig("1160");
console.log(`  info  disp: ${disp ? formatSignature(disp) : "—"}`);
const jumps = graph.edgesOutOf(R("1160"), ["JUMPS_TO"]);
check(jumps.some((e) => e.to === R("1180") && e.evidence.via === "rts-dispatch"), `disp JUMPS_TO $1180 via rts-dispatch (${jumps.map((e) => `${e.to}/${e.evidence.via}`).join(",")})`);
check(disp && disp.stack.tricks.some((t) => t.startsWith("rts-dispatch")) && disp.partial === null, "disp: stack trick rts-dispatch recorded, not partial");

// ---- patch / usesop
const patch = sig("1190");
const usesop = sig("11a0");
console.log(`  info  patch: ${patch ? formatSignature(patch) : "—"}`);
console.log(`  info  usesop: ${usesop ? formatSignature(usesop) : "—"}`);
check(patch && locs(patch.out).includes("op:$11A1"), "patch.out ∋ op:$11A1");
check(usesop && locs(usesop.in).includes("op:$11A1") && usesop.in.find((i) => i.loc === "op:$11A1")?.confidence === "certain", "usesop.in ∋ op:$11A1 (certain)");
const patchPasses = graph.edgesOutOf(R("1190"), ["PASSES"]).find((e) => e.to === R("11a0"));
check(patchPasses && patchPasses.evidence.args["op:$11A1"]?.source === "imm" && patchPasses.evidence.args["op:$11A1"]?.value === 7, `patch → usesop passes op:$11A1 = imm $07 (${JSON.stringify(patchPasses?.evidence.args)})`);

// ---- caller4
const caller4 = sig("11b0");
console.log(`  info  caller4: ${caller4 ? formatSignature(caller4) : "—"}`);
check(caller4 && caller4.stack.returns_to === "caller's caller" && caller4.stack.delta === -2, "caller4 records returns_to: caller's caller (delta −2)");
check(caller4 && locs(caller4.in).length === 0, "caller4.in is empty (the popped return address is not a parameter)");

// ---- partial
const partial = sig("11c0");
console.log(`  info  partial: ${partial ? formatSignature(partial) : "—"}`);
check(partial && partial.partial && partial.partial.site === "$11C0 jsr $3000", `partial.signature.partial.site = "$11C0 jsr $3000" (${partial?.partial?.site})`);
check(graph.edgesOutOf(R("11c0"), ["SIGNATURE"])[0]?.confidence === "inferred", "a partial signature is `inferred`");

// ---- entry: args and the CHROUT summary
const entry = sig("1000");
console.log(`  info  entry: ${entry ? formatSignature(entry) : "—"}`);
const e2s = graph.edgesOutOf(R("1000"), ["PASSES"]).find((e) => e.to === R("1100"));
const a = e2s?.evidence.args ?? {};
check(e2s && a.A?.source === "imm" && a.A.value === 1 && a.X?.source === "imm" && a.X.value === 0x12 && a.Y?.source === "imm" && a.Y.value === 5, `args entry → svc = A imm 1, X imm $12, Y imm 5 (${JSON.stringify(a)})`);
check(e2s && a.A?.site === "$1000 lda #$01", `arg A site "$1000 lda #$01" (${a.A?.site})`);
check(e2s && e2s.evidenceKey === "src:1006" && graph.edgesOutOf(R("1000"), ["CALLS"]).some((c) => c.to === R("1100") && c.evidenceKey === "src:1006"), "PASSES and CALLS share (from, to, evidence_key) — joinable");
check(entry && !locs(entry.in).includes("A"), "CHROUT's in=[A] does not make A live-in of entry: A is written at $1000 first");
check(entry && locs(entry.out).includes("zp:$FC") && entry.stack.balanced, "entry.out ∋ zp:$FC, stack balanced");
const chrout = graph.edgesOutOf(R("1000"), ["PASSES"]).find((e) => e.to === "c64:rom:ffd2");
check(chrout && chrout.evidence.args.A?.source === "callee" && chrout.evidence.args.A.from === R("1100"), `entry → CHROUT passes A left by the previous jsr (source callee, from svc) (${JSON.stringify(chrout?.evidence.args)})`);

// ---- the domain across callers
const dom = argsDomain(graph, R("1100"));
const aDom = dom.domain.A ?? [];
console.log(`  info  args $1100:\n${formatArgs(dom).split("\n").map((l) => `        ${l}`).join("\n")}`);
check(dom.sites === 3 && setEq(aDom.map((e) => e.key), ["$01", "$02", "$03"]) && aDom.every((e) => e.sites.length === 1), "args $1100: A ∈ {$01, $02, $03} from three sites");
check(formatArgs(dom).startsWith("A ∈ {$01 ×1, $02 ×1, $03 ×1}"), `formatArgs prints A ∈ {$01 ×1, $02 ×1, $03 ×1}`);
check((dom.domain.Y ?? []).some((e) => e.key === "$05") && (dom.domain.Y ?? []).some((e) => e.key === "$00"), "args $1100: Y domain has $05 and $00");
check(formatSignature(svc).startsWith("in: A X Y · out: "), `formatSignature(svc) starts with "in: A X Y · out: "`);
graph.close();

// ---- idempotence + the human layer survives
let store = GraphStore.open(project);
const h1 = store.contentHash();
const dump1 = store.canonicalDump();
store.upsertHuman({ id: R("1100"), kind: "routine", name: "svc", attrs: { abi: "A = mode (01 read / 02 write / 03 finish)" }, origin: "user", confidence: "user_asserted" });
store.close();
const r2 = seedSignatures({ projectDir: project });
store = GraphStore.open(project);
const same = store.contentHash() === h1;
check(same, `seed twice → identical canonical dump (${h1.slice(0, 16)})`);
if (!same) {
  const d2 = store.canonicalDump().split("\n");
  const d1 = dump1.split("\n");
  const diff = d2.filter((l) => !d1.includes(l)).concat(d1.filter((l) => !d2.includes(l)));
  console.log(diff.slice(0, 6).map((l) => `        ${l.slice(0, 200)}`).join("\n"));
}
check(r2.routines === r1.routines && r2.passes === r1.passes && r2.dispatches === r1.dispatches, "second seed reports the same counts");
store.close();
graph = Graph.open(project);
const human = graph.resolve(R("1100"));
check(human.name === "svc" && human.attrs.abi === "A = mode (01 read / 02 write / 03 finish)", "the human name and `abi` annotation survive the re-seed");
check(signatureOf(graph, R("1100")) !== undefined, "and the signature is still there beside it");
check(graph.resolve(R("1100")).attrs.signature === undefined, "the signature is not written into 819's node attrs (it is the SIGNATURE edge)");
graph.close();

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 826: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
