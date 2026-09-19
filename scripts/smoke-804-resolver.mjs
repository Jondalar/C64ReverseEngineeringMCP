#!/usr/bin/env node
// Spec 804 smoke — names are joined in C64RE: the resolver, residency and the generic
// monitor join, against a fixture project built through the product's own doors.
//
// No runtime: memory is a plain map the smoke loads payloads into, handed to the resolver
// as its byte source — the same interface the live runtime and a trace timeline serve.
// smoke-804-monitor.mjs runs the same fixture against a sandbox runtime.
//
//   node scripts/smoke-804-resolver.mjs          (needs `npm run build`)

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture804, PAYLOADS } from "./lib/fixture-804.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(join(ROOT, "dist", p));

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

const { SymbolResolver, formatName } = await dist("symbols/resolver.js");
const { decorateText, substituteNames, tokenize, isMonitorNumber } = await dist("symbols/monitor-names.js");
const { TraceTimeline } = await dist("symbols/trace-bytes.js");
const { nameTraceRows } = await dist("symbols/trace-rows.js");
const { explainPc } = await dist("symbols/resolve-pc.js");
const { parseSymbolFile } = await dist("symbols/sym-file.js");

console.log("Spec 804 — the resolver, residency, and the generic monitor join\n");
const { dir, paths } = await buildFixture804(ROOT);
const R = SymbolResolver.forProject(dir);

// ---------------------------------------------------------------- memory
const mem = new Map();
const wipe = () => mem.clear();
const put = (addr, bytes) => bytes.forEach((b, i) => mem.set((addr + i) & 0xffff, b));
const bytesSource = {
  async read(space, _lens, addrs) {
    const out = new Map();
    if (space !== "c64") return out; // nothing loaded into the drive
    for (const a of addrs) out.set(a, mem.get(a) ?? 0);
    return out;
  },
};
const ctx = { bytes: bytesSource, machine: { device: "c64", cartBank: null } };
const nameAt = async (addr, space = "c64", extra = {}) => {
  const [r] = await R.resolve([{ space, addr, ...extra }], ctx);
  return r.name ? formatName(r.name) : r.ambiguous ? `ambiguous:${r.ambiguous.map((a) => a.name).join("|")}` : null;
};

// ---------------------------------------------------------------- layers
console.log("[layers]");
const origins = new Set(R.layers.entries.map((e) => e.origin));
check(R.layers.sources.graph && R.size > 0, "the graph is read", `${R.size} names`);
check(origins.has("user") && origins.has("derived") && origins.has("build"), "all three layers are present", [...origins].join(","));
check(R.layers.sources.symbolFiles.length === 1, "assemble_source registered one build symbol file", R.layers.sources.symbolFiles.join(","));
check(!R.layers.entries.some((e) => /^code_|^unknown_|^entry_/u.test(e.name)), "generated descriptors (code_1000_1008, entry_1000) are not names");
const kick = parseSymbolFile("al C:0816 .print_string\nal 8:0500 .drv_loop\nal 9:0500 .other\n.label start=$810\nplain = $0400");
check(kick.length === 4 && kick[1].space === "drive8" && kick[0].space === "c64", "VICE memspace is kept: C: → c64, 8: → drive8, 9: skipped", JSON.stringify(kick.map((k) => `${k.name}@${k.space}`)));

// ---------------------------------------------------------------- residency
console.log("\n[residency — which payload is in memory decides the name]");
wipe(); put(PAYLOADS.alpha.load, PAYLOADS.alpha.bytes);
check(await nameAt(0x1000) === "alpha_main[u]", "alpha in memory → $1000 is alpha_main[u]", await nameAt(0x1000));
check(await nameAt(0x1010) === "set_border[u]", "alpha in memory → $1010 is set_border[u]", await nameAt(0x1010));
check(await nameAt(0x1002) === null, "alpha in memory → beta's W1002 is not shown");
wipe(); put(PAYLOADS.beta.load, PAYLOADS.beta.bytes);
check(await nameAt(0x1000) === "beta_main[u]", "beta in memory → the SAME address is beta_main[u]", await nameAt(0x1000));
check(await nameAt(0x1010) === "set_background[u]", "beta in memory → $1010 is set_background[u]", await nameAt(0x1010));
check(await nameAt(0x1002) === "W1002[?]", "a derived name shows where nothing better exists", await nameAt(0x1002));
wipe();
check(await nameAt(0x1000) === null, "neither in memory → no name at all");
const ex = await explainPc(R, { pc: 0x1000, space: "c64" }, ctx);
check(!ex.name && ex.candidates.length >= 4 && /none of their payloads/u.test(ex.note ?? ""), "resolve_pc says the names exist but none is resident", ex.note);
wipe(); put(PAYLOADS.alpha.load, PAYLOADS.alpha.bytes); put(0x1010, PAYLOADS.beta.bytes.slice(0x10));
check(await nameAt(0x1010) === null, "half alpha, half beta → no match, no name (never a wrong one)");
wipe(); put(PAYLOADS.alpha.load, PAYLOADS.alpha.bytes);
check(await nameAt(0x1000, "drive8") === null, "a drive8 address never gets a C64 name");

console.log("\n[relocation — the graph is keyed on the runtime address]");
wipe(); put(0xc000, PAYLOADS.delta.bytes);
check(await nameAt(0xc000) === "reloc_entry[u]", "delta running at $C000 → reloc_entry[u] (the routine outranks the segment it opens)", await nameAt(0xc000));
check(await nameAt(0xc005) === null, "inside a CODE segment a listing shows no name…");
check(await nameAt(0xc005, "c64", { containment: "all" }) === "reloc_block+$05[u]", "…but a question about that address gets the range", await nameAt(0xc005, "c64", { containment: "all" }));
wipe(); put(PAYLOADS.delta.load, PAYLOADS.delta.bytes);
check(await nameAt(0xc000) === null, "delta only at its stored $3000 → nothing is running at $C000, no name");

console.log("\n[build layer]");
wipe(); put(0x2000, [...readFileSync(paths.gamma)].slice(2));
check(await nameAt(0x2000) === "start[b]", "the assembled build in memory → start[b]", await nameAt(0x2000));
const psAddr = R.layers.entries.find((e) => e.name === "print_string").address;
check(await nameAt(psAddr) === "print_string[b]", `…and print_string[b] at $${psAddr.toString(16)}`);
wipe();
check(await nameAt(0x2000) === null, "the build's bytes gone → its names gone");

console.log("\n[ambiguity — two resident payloads, two names, one address]");
const tmp = mkdtempSync(join(tmpdir(), "c64re-804-amb-"));
const twin = (n) => { const p = join(tmp, `${n}.prg`); writeFileSync(p, readFileSync(paths.alpha)); return p; };
const synthetic = new SymbolResolver(tmp, {
  entries: ["twin_a", "twin_b"].map((n) => ({ name: `${n}_main`, origin: "user", space: "c64", address: 0x1000, endAddress: null, kind: "routine", range: null, payload: { kind: "prg", path: twin(n) }, bank: null, source: n })),
  relocations: new Map(), crtOwners: new Map(), sources: { graph: false, graphNodes: 0, symbolFiles: [] },
});
wipe(); put(PAYLOADS.alpha.load, PAYLOADS.alpha.bytes);
const [amb] = await synthetic.resolve([{ space: "c64", addr: 0x1000 }], ctx);
check(!amb.name && amb.ambiguous?.length === 2, "identical bytes, different names → no name, `ambiguous` lists both", JSON.stringify(amb.ambiguous));

console.log("\n[a dump row is a range: names inside it, the grid untouched]");
wipe(); put(PAYLOADS.alpha.load, PAYLOADS.alpha.bytes);
const [row] = await R.resolve([{ space: "c64", addr: 0x1000, len: 32 }], ctx);
check(row.inside?.map((n) => `${n.offset}:${n.name}`).join(",") === "0:alpha_main,16:set_border", "a 32-byte row names $1000 (+$00) and $1010 (+$10)", JSON.stringify(row.inside?.map((n) => n.name)));

console.log("\n[input — names in, addresses out, no verb looked at]");
const fakeCall = async (method, params) => {
  if (method !== "session/read_memory") throw new Error(`unexpected ${method}`);
  return { chunks: params.ranges.map((r) => ({ addr: r.addr, bytes: Buffer.from(Array.from({ length: r.len }, (_, i) => mem.get((r.addr + i) & 0xffff) ?? 0)).toString("base64") })) };
};
const sub = (c) => substituteNames(c, R, { space: "c64", call: fakeCall });
check((await sub("a 1100 jmp set_border")).command === "a 1100 jmp $1010", "a 1100 jmp set_border → a 1100 jmp $1010");
check((await sub("a 1100 lda abc")).command === "a 1100 lda abc", "numeric parse wins: `abc` stays hex");
check((await sub("m ram set_border alpha_main")).command === "m ram $1010 $1000", "every non-first token is a candidate, whatever the verb");
check((await sub("set_border 1000")).command === "set_border 1000", "the first token is never touched");
check((await sub("d beta_main")).command === "d beta_main", "a name whose payload is not resident is left for the runtime to refuse");
check((await sub('load "set_border" 1000')).command === 'load "set_border" 1000', "a quoted run is never substituted");
check((await substituteNames("d set_border", R, { space: "drive8", call: fakeCall })).command === "d set_border", "space-aware: a C64 name does not become a drive address");
check(isMonitorNumber("#$0a") && isMonitorNumber("%0101") && isMonitorNumber("0x10") && isMonitorNumber("c000") && !isMonitorNumber("loop"), "the monitor's number syntax");
check(tokenize("a 1000 jmp (vec),y").map((t) => t.text).join("|") === "a|1000|jmp|vec|y", "tokens split on whitespace , ( ) =");

console.log("\n[output — one function decorates every reply, by its spans]");
const dText = "$1000  20 10 10  JSR $1010\n$1003  ee 00 04  INC $0400";
const dSpans = [
  { line: 0, start: 0, end: 5, addr: 0x1000, space: "c64", role: "pc" },
  { line: 0, start: 22, end: 27, addr: 0x1010, space: "c64", role: "target" },
  { line: 1, start: 0, end: 5, addr: 0x1003, space: "c64", role: "pc" },
];
const dRes = await R.resolve(dSpans.map((s) => ({ space: s.space, addr: s.addr })), ctx);
const d = decorateText(dText, dSpans, dRes);
check(d.text === "$1000  alpha_main[u]  20 10 10  JSR $1010  ; set_border[u]\n$1003                 ee 00 04  INC $0400", "a disassembly: a label column after the address, the target in the annotation column, numbers untouched", JSON.stringify(d.text));
const dPlain = decorateText(dText, dSpans, dRes, { tags: false });
check(dPlain.text === "$1000  alpha_main  20 10 10  JSR $1010  ; set_border\n$1003              ee 00 04  INC $0400", "without tags (the workbench colours instead)", JSON.stringify(dPlain.text));
check(dPlain.marks.length === 2 && dPlain.text.split("\n")[0].slice(dPlain.marks[0].start, dPlain.marks[0].end) === "alpha_main" && dPlain.marks.every((k) => k.origin === "user"), "the marks point at the names, with their origin", JSON.stringify(dPlain.marks));
const btText = "backtrace (live stack scan):\n  $01f8: -> $1010  (JSR return?)";
const btSpans = [
  { line: 1, start: 2, end: 7, addr: 0x01f8, space: "c64", role: "memory" },
  { line: 1, start: 12, end: 17, addr: 0x1010, space: "c64", role: "pc" },
];
const bt = decorateText(btText, btSpans, await R.resolve(btSpans.map((s) => ({ space: s.space, addr: s.addr })), ctx));
check(bt.text.endsWith("-> $1010  (JSR return?)  ; set_border[u]"), "a backtrace: the same function, the same rule", JSON.stringify(bt.text));
const mText = ">C:1000  20 10 10 ee";
const mSpans = [{ line: 0, start: 3, end: 7, addr: 0x1000, space: "c64", role: "memory", len: 32 }];
const m = decorateText(mText, mSpans, await R.resolve(mSpans.map((s) => ({ space: s.space, addr: s.addr, len: s.len })), ctx));
check(m.text === ">C:1000  20 10 10 ee  ; +$00 alpha_main[u], +$10 set_border[u]", "a dump row: names in the annotation column, the grid unmoved", JSON.stringify(m.text));

console.log("\n[static — the monitor path carries no verb list and no mnemonic table]");
// The monitor path = everything a command and its reply pass through. The name SOURCES
// (layers.ts reads the graph's node kinds, sym-file.ts a symbol file's memspace letter)
// are not on it, and their vocabulary ("label", "C") would read as false verbs here.
const MONITOR_PATH = ["monitor-names.ts", "resolver.ts", "structured.ts", "live-bytes.ts", "resolve-pc.ts", "trace-rows.ts", "types.ts"];
const files = [
  ...readdirSync(join(ROOT, "src/symbols")).filter((f) => MONITOR_PATH.includes(f)).map((f) => join(ROOT, "src/symbols", f)),
  join(ROOT, "src/workspace-ui/monitor-names-route.ts"),
];
const VERBS = ["d", "disass", "m", "mem", "r", "registers", "bt", "chis", "whowrote", "rstep", "reverse", "sd", "df", "bk", "break", "z", "step", "n", "next", "g", "x", "a", "until", "ret", "flow", "focus", "device", "wr", "f", "t", "c", "h", "io", "screen", "map", "taint", "swimlane", "trace", "tracedb", "label", "sym", "inspect", "xref", "note", "load", "save"];
const MNEMONICS = ["lda", "sta", "ldx", "ldy", "stx", "sty", "jmp", "jsr", "rts", "rti", "bne", "beq", "bcc", "bcs", "bpl", "bmi", "bvc", "bvs", "inc", "dec", "nop", "brk", "and", "ora", "eor", "adc", "sbc", "cmp", "cpx", "cpy", "bit", "asl", "lsr", "rol", "ror", "pha", "pla", "inx", "iny", "dex", "dey"];
const offenders = [];
for (const f of files) {
  const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
  for (const lit of code.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/gu)) {
    const v = lit[2].trim().toLowerCase();
    const first = v.split(/\s+/u)[0];
    if (VERBS.includes(v) || MNEMONICS.includes(v) || (v.includes(" ") && (VERBS.includes(first) || MNEMONICS.includes(first)))) offenders.push(`${f.replace(ROOT + "/", "")}: ${lit[0]}`);
  }
}
check(offenders.length === 0, `${files.length} files of the monitor/names path name no verb and no mnemonic`, offenders.slice(0, 5).join(" · "));

console.log("\n[traces — residency per row, from the trace's own writes and executions]");
// A synthetic store: alpha executes at cycle 100, a loader writes beta over $1000-$1015 at
// cycle 500 (recording old and new), beta executes at cycle 600.
const writes = [];
PAYLOADS.beta.bytes.forEach((b, i) => writes.push([0x1000 + i, 500 + i, b, PAYLOADS.alpha.bytes[i]]));
const execs = [[0x1000, 0x20, 0x10, 0x10], [0x1010, 0xa9, 0x01, 0x8d], [0x1000, 0xa2, 0x00, 0xe8], [0x1010, 0xa9, 0x02, 0x8d]];
const query = async (sql) => {
  if (/FROM bus_events/u.test(sql)) {
    const set = new Set((sql.match(/addr IN \(([^)]*)\)/u)?.[1] ?? "").split(",").map(Number));
    return writes.filter((w) => set.has(w[0]));
  }
  if (/FROM instructions/u.test(sql)) {
    const [, lo, hi] = sql.match(/pc BETWEEN (\d+) AND (\d+)/u);
    return execs.filter((e) => e[0] >= Number(lo) && e[0] <= Number(hi));
  }
  return [];
};
const rows = [
  { family: "cpu_step", cycle: 100, pc: 0x1010 },
  { family: "mem_write", cycle: 200, pc: 0x1012, addr: 0xd020 },
  { family: "cpu_step", cycle: 700, pc: 0x1010 },
  { family: "cpu_step", cycle: 710, pc: 0x1000 },
];
const named = await nameTraceRows(rows, { resolver: R, query });
check(named[0].pcName?.text === "set_border[u]", "a row before the overwrite names alpha's routine", named[0].pcName?.text);
check(named[2].pcName?.text === "set_background[u]", "a row after it names beta's — same address, same trace", named[2].pcName?.text);
check(named[3].pcName?.text === "beta_main[u]", "…and beta's entry", named[3].pcName?.text);
check(named[1].addrName === undefined && named[1].pc === 0x1012, "numbers are untouched; an unnamed address gets no field");
const tl = await TraceTimeline.build(async () => [], "c64", [0x1000]);
check(tl.valueAt(0x1000, 10) === undefined, "a trace that captured nothing about a byte knows nothing about it");

rmSync(dir, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-804-resolver: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
