#!/usr/bin/env node
// Spec 898 — the VIC-20 and the TED machines are platforms (D1-D9).
//
//   1 the memory map per tag, at its boundaries — and the CommonJS twin the pipeline
//     uses answers the same for every address of every tag
//   2 Spec 818 ids derive and resolve for the new tags (vic20:io:9005, plus4:io:ff19)
//   3 the same bytes on three machines: the C64 listing carries C64 names, the VIC-20 and
//     the TED listings carry none of the C64-only ones, and every rebuild is byte-identical
//   4 the graph: stores to the VIC-20 / TED I/O window are USES_HARDWARE edges to
//     vic20:io:… / plus4:io:… nodes — and the C64's still go to c64:io:…
//   5 the render's machine is resolved argument > artifact record > project default > c64
//   6 inspect_address_range and c64ref_lookup take the same resolution, and say so on a miss
//   7 where a tool guesses a load address for a block with no header, the machine decides:
//     VIC-20 $1001/$0401/$1201, TED $1001, C64 $0801 — and a header always wins
//   8 D7: an annotate boundary over the machine's I/O window is met by its access sites
//   9 a `10 SYS` stub at the VIC-20 / TED BASIC start is a BASIC segment with a SYS entry; the
//     RAM vector pairs per machine; basic_list / basic_tokenize speak BASIC 3.5 on plus4 and V2 elsewhere
//  10 D8: onboarding / status state the machine and ask for it; a .d64 extracted in a vic20 project
//     renders with VIC-20 names; D9: a raw cartridge image is placed by its signature
//  11 the acceptance run on real VIC-20 / C16 games: an unowned I/O boundary takes the machine the
//     graph's own edges name; the colour RAM at $9600 has a (secondary) region; a store the report
//     was not asked about is not listed, and a range with no row says so in the header; a symbol
//     that equals its name is printed once; a disasm preview records no machine on the file
//
// Hermetic: temp projects, synthetic bytes, no ROMs, no media, no daemon, no network. Needs
// the assemblers the rebuild proof uses (KickAssembler jar, 64tass) and skips those checks
// loudly without them, the way e2e:disasm-family does. Rows the platform store has for the
// VIC-20 / TED names are NOT required: the checks hold with none and with all.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:898

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };
const head = (n, title) => console.log(`\n── ${n} ${title}`);

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_KICKASS = existsSync(KICKASS);
const HAVE_64TASS = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;

console.log("Spec 898 — the VIC-20 and the TED machines are platforms\n");

const schema = await import(join(ROOT, "dist/platform-kb/schema.js"));
const { PlatformKb } = await import(join(ROOT, "dist/platform-kb/read.js"));
const ids = await import(join(ROOT, "dist/knowledge-graph/ids.js"));
const { seedProject } = await import(join(ROOT, "dist/knowledge-graph/producers/seed-project.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
const { assembleSource } = await import(join(ROOT, "dist/assemble-source.js"));
const twin = require(join(ROOT, "dist/pipeline/lib/platform-kb.cjs"));
const kb = new PlatformKb(join(ROOT, "resources/platform-kb.sqlite"));

// ── 1 the memory map ─────────────────────────────────────────────────────────
head(1, "one memory map per tag, at its boundaries");
{
  const K = (tag, a) => schema.platformKindForAddress(tag, a);
  const rows = [
    // vic20: io $9000-$9FFF in three named parts, rom $8000-$8FFF and $C000-$FFFF, ram everywhere else
    ["vic20", 0x0000, "zp"], ["vic20", 0x00ff, "zp"], ["vic20", 0x0100, "ram"], ["vic20", 0x0400, "ram"],
    ["vic20", 0x1001, "ram"], ["vic20", 0x1e00, "ram"], ["vic20", 0x2000, "ram"], ["vic20", 0x7fff, "ram"],
    ["vic20", 0x8000, "rom"], ["vic20", 0x8fff, "rom"],
    ["vic20", 0x9000, "io"], ["vic20", 0x9005, "io"], ["vic20", 0x9110, "io"], ["vic20", 0x9120, "io"], ["vic20", 0x93ff, "io"],
    ["vic20", 0x9400, "io"], ["vic20", 0x9600, "io"], ["vic20", 0x97ff, "io"], ["vic20", 0x9800, "io"], ["vic20", 0x9fff, "io"],
    ["vic20", 0xa000, "ram"], ["vic20", 0xbfff, "ram"], // block 5: RAM or a cartridge — never platform ROM
    ["vic20", 0xc000, "rom"], ["vic20", 0xe000, "rom"], ["vic20", 0xffd2, "rom"], ["vic20", 0xffff, "rom"],
    // plus4: io $FD00-$FF3F, rom $8000-$FCFF and $FF40-$FFFF
    ["plus4", 0x0000, "zp"], ["plus4", 0x0001, "zp"], ["plus4", 0x1001, "ram"], ["plus4", 0x7fff, "ram"],
    ["plus4", 0x8000, "rom"], ["plus4", 0xd000, "rom"], ["plus4", 0xfcff, "rom"],
    ["plus4", 0xfd00, "io"], ["plus4", 0xfd30, "io"], ["plus4", 0xff00, "io"], ["plus4", 0xff19, "io"], ["plus4", 0xff3e, "io"], ["plus4", 0xff3f, "io"],
    ["plus4", 0xff40, "rom"], ["plus4", 0xffd2, "rom"], ["plus4", 0xffff, "rom"],
    // the two that were there before are unchanged
    ["c64", 0xd000, "io"], ["c64", 0xdfff, "io"], ["c64", 0xa000, "rom"], ["c64", 0xe000, "rom"], ["c64", 0x9005, "ram"], ["c64", 0x0001, "zp"],
    ["c1541", 0x1800, "io"], ["c1541", 0x1c0f, "io"], ["c1541", 0x1c10, "ram"], ["c1541", 0xc000, "rom"],
  ];
  const bad = rows.filter(([tag, a, want]) => K(tag, a) !== want).map(([tag, a, want]) => `${tag} $${a.toString(16)} = ${K(tag, a)}, want ${want}`);
  check(bad.length === 0, `${rows.length} boundary addresses across four tags answer as the spec table says`, bad.slice(0, 3).join("; "));

  let drift = 0, first = "";
  for (const tag of schema.PLATFORM_TAGS) {
    for (let a = 0; a <= 0xffff; a += 1) {
      if (twin.platformKindForAddress(tag, a) !== K(tag, a)) { drift += 1; if (!first) first = `${tag} $${a.toString(16)}`; }
    }
  }
  check(drift === 0, "the pipeline's twin of the map answers the same for all 65536 addresses of every tag", first);
  check(JSON.stringify(schema.PLATFORM_TAGS) === JSON.stringify(["c64", "c1541", "vic20", "plus4"]), "the tag list is c64, c1541, vic20, plus4");
}

// ── 2 ids ────────────────────────────────────────────────────────────────────
head(2, "Spec 818 ids derive and resolve for the new tags");
{
  check(ids.derivePlatformId("vic20", 0x9005) === "vic20:io:9005", "derivePlatformId(vic20, $9005) = vic20:io:9005");
  check(ids.derivePlatformId("plus4", 0xff19) === "plus4:io:ff19", "derivePlatformId(plus4, $FF19) = plus4:io:ff19");
  check(ids.derivePlatformId("vic20", 0xa123) === "vic20:ram:a123", "block 5 is ram: vic20:ram:a123");
  const p = ids.parseId("vic20:io:9005");
  check(p.form === "platform" && p.platform === "vic20" && p.kind === "io" && p.address === 0x9005, "parseId reads vic20:io:9005 back");
  check(ids.isPlatformId("plus4:io:ff19"), "plus4:io:ff19 is a platform id");
  let refused = "";
  try { ids.deriveProjectId({ slug: "vic20", ctx: { space: "ram" }, kind: "routine", address: 0x1001 }); } catch (e) { refused = String(e.message); }
  check(/slug-is-platform/.test(refused), "a project slug can no longer be vic20 or plus4 — it would read as a platform id");
  check(kb.idFor("vic20", 0x9005) === "vic20:io:9005", "the store derives the same id");
}

// ── the server, one process, two projects ────────────────────────────────────
const projA = mkdtempSync(join(tmpdir(), "c64re-898-a-"));
const projB = mkdtempSync(join(tmpdir(), "c64re-898-b-"));
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projA, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pend = new Map();
let nid = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    let m;
    try { m = JSON.parse(ln); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nid++;
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 240000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

// One routine, written for no machine in particular: a border-colour store, the 6510 port,
// BASIC's text pointer, a KERNAL call, the C64's CIA and SID, and the VIC-20's VIC-I, VIA and
// colour RAM — plus the TED's colour and keyboard latch and the memory the copy loop reads.
const SAMPLE = [
  0x78,                                       // sei
  0xa9, 0x00, 0x8d, 0x20, 0xd0,               // lda #0 ; sta $D020
  0xa6, 0x01,                                 // ldx $01
  0xa5, 0x7a,                                 // lda $7A
  0xad, 0x0d, 0xdc,                           // lda $DC0D
  0x8d, 0x18, 0xd4,                           // sta $D418
  0xa9, 0xf0, 0x8d, 0x05, 0x90,               // lda #$F0 ; sta $9005
  0xa9, 0x40, 0x8d, 0x0e, 0x91,               // lda #$40 ; sta $910E
  0x8d, 0x22, 0x91,                           // sta $9122
  0xad, 0x11, 0x91,                           // lda $9111
  0xa9, 0x01, 0x8d, 0x00, 0x96,               // lda #1 ; sta $9600
  0x8d, 0x19, 0xff,                           // sta $FF19
  0xad, 0x30, 0xfd,                           // lda $FD30
  0x20, 0xd2, 0xff,                           // jsr $FFD2
  0x58, 0x60,                                 // cli ; rts
];
const prgBytes = (load, body) => Buffer.concat([Buffer.from([load & 0xff, load >> 8]), Buffer.from(body)]);
const SAMPLE_PRG = prgBytes(0x1001, [...SAMPLE, ...new Array(8).fill(0xea)]);

// What only a C64 calls these: the port, the CIA's interrupt register, the SID volume, the
// VIC-II border. (TXTPTR and CHROUT sit at the same addresses on the other Commodores, so
// they are not evidence either way.) The names are read off the store, not typed here.
const symbolAt = (tag, a) => kb.node(tag, a)?.symbol;
const C64_ONLY = [0x01, 0xd020, 0xdc0d, 0xd418].map((a) => ({ a, sym: symbolAt("c64", a) })).filter((x) => x.sym);
const names = (text) => C64_ONLY.filter((x) => new RegExp(`\\b${x.sym}\\b`).test(text)).map((x) => x.sym);
check(C64_ONLY.length === 4, "the C64 store names $01, $D020, $DC0D and $D418 (the probes for 'a C64 name')", C64_ONLY.map((x) => x.sym).join(","));

const listingOf = (dir, stem) => ({
  asm: readFileSync(join(dir, "artifacts/prg", `${stem}_disasm.asm`), "utf8"),
  tas: readFileSync(join(dir, "artifacts/prg", `${stem}_disasm.tas`), "utf8"),
});
const put = (dir, name, bytes) => {
  mkdirSync(join(dir, "artifacts", "prg"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "prg", name), bytes);
};
const rowOf = (dir, name) => new ProjectKnowledgeService(dir).listArtifacts().find((a) => a.path === join(dir, "artifacts", "prg", name));
async function rebuild(dir, stem, prg, label) {
  if (!HAVE_KICKASS) skip(`${label}: KickAssembler rebuild`, `no jar at ${KICKASS}`);
  else {
    const r = await assembleSource({ projectDir: dir, sourcePath: join(dir, "artifacts/prg", `${stem}_disasm.asm`), assembler: "kickassembler", outputPath: join(dir, "out", `${stem}.ka.prg`), compareToPath: prg });
    check(r.exitCode === 0 && r.compareMatches === true, `${label}: the .asm rebuilds byte-identical (KickAssembler)`, r.compareMatches ? `${r.comparedBytes} bytes` : (r.stderr || "").split("\n")[0]);
  }
  if (!HAVE_64TASS) skip(`${label}: 64tass rebuild`, "64tass not on PATH");
  else {
    const r = await assembleSource({ projectDir: dir, sourcePath: join(dir, "artifacts/prg", `${stem}_disasm.tas`), assembler: "64tass", outputPath: join(dir, "out", `${stem}.tas.prg`), compareToPath: prg });
    check(r.exitCode === 0 && r.compareMatches === true, `${label}: the .tas rebuilds byte-identical (64tass)`, r.compareMatches ? `${r.comparedBytes} bytes` : (r.stderr || "").split("\n")[0]);
  }
}
const edgesTo = (dir, owner, type) => {
  const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT DISTINCT to_id FROM edges WHERE type = ? AND owner = ? ORDER BY to_id").all(type, owner).map((r) => r.to_id);
  } finally { db.close(); }
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-898", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const initA = await call("project_init", { name: "platforms-a" });
  check(/Platform: c64 \(default\)/.test(initA), "project_init without platform: the project's machine is the C64", initA.split("\n").find((l) => l.startsWith("Platform")));
  await call("agent_onboard", {});
  const initB = await call("project_init", { project_dir: projB, name: "platforms-b", platform: "vic20" });
  await call("agent_onboard", { project_dir: projB });
  check(/Platform: vic20/.test(initB), "project_init platform=vic20 sets the project default", initB.split("\n").find((l) => l.startsWith("Platform")));
  check(JSON.parse(readFileSync(join(projB, "knowledge", "project.json"), "utf8")).platform === "vic20", "…and it is in knowledge/project.json");

  // ── 3 the same bytes on three machines ─────────────────────────────────────
  head(3, "the same bytes on three machines");
  put(projA, "s_c64.prg", SAMPLE_PRG);
  put(projA, "s_vic.prg", SAMPLE_PRG);
  put(projA, "s_ted.prg", SAMPLE_PRG);

  await call("analyze", { path: "artifacts/prg/s_c64.prg" });
  const outC64 = await call("disasm", { path: "artifacts/prg/s_c64.prg" });
  check(/rebuild verified byte-identical/.test(outC64) || !HAVE_KICKASS, "disasm (no platform): the door's own rebuild proof is byte-identical", outC64.split("\n").find((l) => /rebuild/.test(l)));
  const c64 = listingOf(projA, "s_c64");
  check(names(c64.tas).length === C64_ONLY.length, "c64: the listing carries the C64 names", names(c64.tas).join(","));
  await rebuild(projA, "s_c64", join(projA, "artifacts/prg/s_c64.prg"), "c64");

  await call("analyze", { path: "artifacts/prg/s_vic.prg", platform: "vic20" });
  const outVic = await call("disasm", { path: "artifacts/prg/s_vic.prg", platform: "vic20" });
  const vic = listingOf(projA, "s_vic");
  check(names(vic.asm).length === 0 && names(vic.tas).length === 0, "vic20: no C64-only name in either listing", names(vic.tas).join(","));
  check(/rebuild verified byte-identical/.test(outVic) || !HAVE_KICKASS, "vic20: the door's own rebuild proof is byte-identical", outVic.split("\n").find((l) => /rebuild/.test(l)));
  check(!/likely: .*(VIC|SID|sprite|bitmap)/i.test(vic.tas) && !/hardware touched/.test(vic.tas), "vic20: no VIC-II / SID inference lines");
  await rebuild(projA, "s_vic", join(projA, "artifacts/prg/s_vic.prg"), "vic20");
  const viaNames = [0x9005, 0x910e, 0x9111, 0x9122].map((a) => ({ a, n: kb.node("vic20", a) }));
  for (const { a, n } of viaNames) {
    if (n) check(new RegExp(`\\b${n.symbol ?? n.name.split(" ")[0]}\\b`).test(vic.tas), `vic20: $${a.toString(16)} carries the store's name ${n.symbol ?? n.name}`);
  }
  if (!viaNames.some((x) => x.n)) console.log("  info  the store has no vic20 I/O rows yet — the names are not asserted, their absence of C64 ones is");

  await call("analyze", { path: "artifacts/prg/s_ted.prg", platform: "plus4" });
  const outTed = await call("disasm", { path: "artifacts/prg/s_ted.prg", platform: "plus4" });
  const ted = listingOf(projA, "s_ted");
  // $01 is the 7501's own port on the TED machines, so its name is allowed to be a port name there
  const tedC64Only = C64_ONLY.filter((x) => x.a !== 0x01);
  const tedHits = tedC64Only.filter((x) => new RegExp(`\\b${x.sym}\\b`).test(ted.tas) || new RegExp(`\\b${x.sym}\\b`).test(ted.asm));
  check(tedHits.length === 0, "plus4: no C64-only name in either listing", tedHits.map((x) => x.sym).join(","));
  check(/rebuild verified byte-identical/.test(outTed) || !HAVE_KICKASS, "plus4: the door's own rebuild proof is byte-identical", outTed.split("\n").find((l) => /rebuild/.test(l)));
  await rebuild(projA, "s_ted", join(projA, "artifacts/prg/s_ted.prg"), "plus4");

  // ── 4 the graph ────────────────────────────────────────────────────────────
  head(4, "USES_HARDWARE follows the machine's I/O window");
  const seeded = seedProject({ projectDir: projA });
  check(seeded.failed.length === 0, "the project seeds", JSON.stringify(seeded.failed));
  const machineOf = Object.fromEntries(seeded.seeded.map((s) => [s.owner, `${s.machine.machine}/${s.machine.source}`]));
  check(machineOf["s_vic"] === "vic20/declared" && machineOf["s_ted"] === "plus4/declared" && /^c64\//.test(machineOf["s_c64"] ?? ""), "each owner seeds under its own machine", JSON.stringify(machineOf));
  const hwC64 = edgesTo(projA, "s_c64", "USES_HARDWARE");
  const hwVic = edgesTo(projA, "s_vic", "USES_HARDWARE");
  const hwTed = edgesTo(projA, "s_ted", "USES_HARDWARE");
  check(["c64:io:d020", "c64:io:dc0d", "c64:io:d418"].every((i) => hwC64.includes(i)) && hwC64.every((i) => i.startsWith("c64:io:")), "c64: USES_HARDWARE → c64:io:d020, dc0d, d418 and nothing else", hwC64.join(" "));
  check(["vic20:io:9005", "vic20:io:910e", "vic20:io:9111", "vic20:io:9122", "vic20:io:9600"].every((i) => hwVic.includes(i)) && hwVic.every((i) => i.startsWith("vic20:io:")),
    "vic20: USES_HARDWARE → vic20:io:9005, 910e, 9111, 9122, 9600 — and no C64 node", hwVic.join(" "));
  check(["plus4:io:ff19", "plus4:io:fd30"].every((i) => hwTed.includes(i)) && hwTed.every((i) => i.startsWith("plus4:io:")),
    "plus4: USES_HARDWARE → plus4:io:ff19, fd30 — and no C64 node", hwTed.join(" "));
  const g = Graph.open(projA);
  check(!g.resolve("vic20:io:9005").dangling && !g.resolve("plus4:io:ff19").dangling, "the new platform ids resolve (Spec 818)");
  check(edgesTo(projA, "s_vic", "USES_ZP").every((i) => i.startsWith("vic20:zp:")), "vic20: zero-page edges point at vic20:zp:…", edgesTo(projA, "s_vic", "USES_ZP").join(" "));
  g.close?.();

  // ── 5 resolution order ─────────────────────────────────────────────────────
  head(5, "argument > artifact record > project default > c64");
  // (a) nothing names a machine, in a project whose default is none → c64
  put(projA, "r_default.prg", SAMPLE_PRG);
  await call("analyze", { path: "artifacts/prg/r_default.prg" });
  await call("disasm", { path: "artifacts/prg/r_default.prg" });
  check(names(listingOf(projA, "r_default").tas).length === C64_ONLY.length, "no argument, no record, no project default → c64");
  check(rowOf(projA, "r_default.prg")?.platform === undefined, "…and nothing is recorded on the file");

  // (b) the artifact record names vic20; no argument
  put(projA, "r_record.prg", SAMPLE_PRG);
  // (save_artifact is not on the default tool surface; the store call is the same one it makes)
  new ProjectKnowledgeService(projA).saveArtifact({ kind: "prg", scope: "input", title: "r_record", path: join(projA, "artifacts/prg/r_record.prg"), platform: "vic20" });
  check(rowOf(projA, "r_record.prg")?.platform === "vic20", "the artifact record carries the marker");
  await call("analyze", { path: "artifacts/prg/r_record.prg" });
  await call("disasm", { path: "artifacts/prg/r_record.prg" });
  check(names(listingOf(projA, "r_record").tas).length === 0, "the record says vic20, no argument → the VIC-20 render (no C64 name)");

  // (c) an explicit c64 beats the record, and sticks
  await call("disasm", { path: "artifacts/prg/r_record.prg", platform: "c64" });
  check(names(listingOf(projA, "r_record").tas).length === C64_ONLY.length, "platform=c64 beats the record");
  check(rowOf(projA, "r_record.prg")?.platform === "c64", "…and is recorded on the file", String(rowOf(projA, "r_record.prg")?.platform));
  await call("disasm", { path: "artifacts/prg/r_record.prg" });
  check(names(listingOf(projA, "r_record").tas).length === C64_ONLY.length, "…so the next render without an argument keeps it");

  // (d) the project default (vic20) when the file's record has none
  put(projB, "r_proj.prg", SAMPLE_PRG);
  await call("analyze", { project_dir: projB, path: "artifacts/prg/r_proj.prg" });
  const dB = await call("disasm", { project_dir: projB, path: "artifacts/prg/r_proj.prg" });
  if (!existsSync(join(projB, "artifacts/prg/r_proj_disasm.asm"))) console.log(dB.slice(0, 600));
  check(names(listingOf(projB, "r_proj").tas).length === 0, "no argument, no record, project default vic20 → the VIC-20 render");
  check(rowOf(projB, "r_proj.prg")?.platform === undefined, "…the default is a fallback, it is not written onto the file");
  await call("disasm", { project_dir: projB, path: "artifacts/prg/r_proj.prg", platform: "c64" });
  check(names(listingOf(projB, "r_proj").tas).length === C64_ONLY.length, "platform=c64 beats the project default");
  await call("disasm", { project_dir: projB, path: "artifacts/prg/r_proj.prg" });
  check(names(listingOf(projB, "r_proj").tas).length === C64_ONLY.length, "…and once recorded, the file's record beats the project default");

  // (e) analyze resolves the same way: the project default reaches the analysis
  put(projB, "r_ana.prg", SAMPLE_PRG);
  await call("analyze", { project_dir: projB, path: "artifacts/prg/r_ana.prg" });
  const ana = JSON.parse(readFileSync(join(projB, "artifacts/prg/r_ana_analysis.json"), "utf8"));
  check(ana.platform === "vic20", "analyze: the project default is the machine the analysis is made for", String(ana.platform));
  const anaC64 = JSON.parse(readFileSync(join(projA, "artifacts/prg/s_c64_analysis.json"), "utf8"));
  check(!("platform" in anaC64), "…and a c64 analysis carries no platform field (byte-identical to before)");

  // ── 6 the lookups ──────────────────────────────────────────────────────────
  head(6, "inspect_address_range and c64ref_lookup take the same resolution");
  const insVic = await call("inspect_address_range", { prg_path: "artifacts/prg/s_vic.prg", start_address: "9000", end_address: "9FFF", analysis_json: "artifacts/prg/s_vic_analysis.json" });
  check(/Platform: vic20/.test(insVic) && /I\/O register stores \(\d+ stores\)/.test(insVic), "inspect_address_range on a vic20 artifact: reported as the VIC-20's I/O stores", insVic.split("\n").find((l) => /register/.test(l)));
  check(/\$[0-9A-F]{4} .*(\$9005|VIC|no vic20 row)/.test(insVic.split("## I/O register stores")[1] ?? ""), "…and the store at $9005 is listed with a VIC-20 name or the words 'no vic20 row'");
  check(names(insVic).length === 0, "…carrying no C64 name");
  const insC64 = await call("inspect_address_range", { prg_path: "artifacts/prg/s_c64.prg", start_address: "D000", end_address: "D02E", analysis_json: "artifacts/prg/s_c64_analysis.json" });
  check(/VIC register program \(\d+ stores\)/.test(insC64) && !/Platform:/.test(insC64), "inspect_address_range on a c64 artifact is as before");
  const refVic = await call("c64ref_lookup", { address: "9005", platform: "vic20" });
  const haveRow = Boolean(kb.node("vic20", 0x9005));
  check(haveRow ? /Platform KB \(vic20\)/.test(refVic) : /No vic20 row for \$9005/.test(refVic), haveRow ? "c64ref_lookup platform=vic20 $9005: the VIC-20 row" : "c64ref_lookup platform=vic20 $9005: says the store has no vic20 row", refVic.split("\n")[0]);
  check(!/C64Ref entry|Status: knowledge_missing/.test(refVic), "…and never falls back to the C64 snapshot");
  const refViaArtifact = await call("c64ref_lookup", { address: "9005", prg_path: "artifacts/prg/s_vic.prg" });
  check(refViaArtifact === refVic, "c64ref_lookup resolves the machine from the artifact record of prg_path");
  const refViaProject = await call("c64ref_lookup", { address: "9005", project_dir: projB });
  check(refViaProject === refVic, "c64ref_lookup resolves the machine from the project default");
  const refC64 = await call("c64ref_lookup", { address: "D020" });
  check(/D020/i.test(refC64) && !/vic20/.test(refC64), "c64ref_lookup without any machine is the C64 lookup it was");

  // ── 7 load addresses ───────────────────────────────────────────────────────
  head(7, "the load address a tool guesses for a block with no header");
  const loadOf = (path) => { const b = readFileSync(path); return b[0] | (b[1] << 8); };
  const tok = async (platform, extra = {}, dir = projA) => {
    const out = join(dir, "artifacts", `tok_${platform ?? "none"}_${extra.load_address ?? "d"}.prg`);
    await call("basic_tokenize", { project_dir: dir, text: "10 REM HI", output_path: out, ...(platform ? { platform } : {}), ...extra });
    return loadOf(out);
  };
  check(await tok(undefined) === 0x0801, "basic_tokenize, no machine: $0801");
  check(await tok("c64") === 0x0801, "platform=c64: $0801");
  check(await tok("vic20") === 0x1001, "platform=vic20: $1001 (unexpanded)");
  check(await tok("plus4") === 0x1001, "platform=plus4: $1001");
  check(await tok("vic20", { load_address: "1201" }) === 0x1201, "…a given load_address wins ($1201, the +8K VIC-20)");
  check(await tok("vic20", { load_address: "0401" }) === 0x0401, "…and $0401, the +3K VIC-20");
  check(await tok(undefined, {}, projB) === 0x1001, "no argument in a project whose default is vic20: $1001");
  const { defaultLoadAddresses } = await import(join(ROOT, "dist/project-knowledge/platform-default.js"));
  check(JSON.stringify(defaultLoadAddresses("vic20")) === JSON.stringify([0x1001, 0x0401, 0x1201]), "the VIC-20 offers $1001, $0401, $1201, in that order");
  check(JSON.stringify(defaultLoadAddresses("plus4")) === JSON.stringify([0x1001]) && JSON.stringify(defaultLoadAddresses("c64")) === JSON.stringify([0x0801]), "the TED machines offer $1001; the C64 $0801");
  // a refusal that asks for load_address offers them — and a header always wins
  writeFileSync(join(projA, "artifacts", "prg", "tiny.bin"), Buffer.from([0x60, 0x60]));
  const refVicTiny = await call("disasm", { path: "artifacts/prg/tiny.bin", platform: "vic20" });
  check(/\$1001 \(unexpanded\), \$0401 \(\+3K\) or \$1201 \(\+8K and up\)/.test(refVicTiny), "a headerless block refused for vic20 offers $1001 / $0401 / $1201", refVicTiny.split("\n").filter(Boolean)[1]?.slice(0, 120));
  const refC64Tiny = await call("disasm", { path: "artifacts/prg/tiny.bin" });
  check(/refused/.test(refC64Tiny) && !/\$1001/.test(refC64Tiny), "…and for the C64 the refusal reads as it did");
  put(projA, "hdr.prg", prgBytes(0xc000, [0xa9, 0x00, 0x60, 0xea]));
  await call("disasm", { path: "artifacts/prg/hdr.prg", platform: "vic20" });
  check(/\* = \$C000/.test(readFileSync(join(projA, "artifacts/prg/hdr_disasm.tas"), "utf8")), "a PRG header wins over any machine's default ($C000 stays $C000 on the VIC-20)");

  // ── 8 D7: an annotate region over an I/O window is met by its access sites ──
  head(8, "an annotate boundary over the I/O window is satisfied by its sites");
  {
    const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
    const { assertBoundary } = await import(join(ROOT, "dist/model/store.js"));
    const { saveContract } = await import(join(ROOT, "dist/contract/contract.js"));
    const { verdict } = await import(join(ROOT, "dist/critic/run.js"));
    const SLUG = "d7";
    // sites: [{ at, stores: [addr…], human?: name }]; the boundary asks for `want` over [start, end]
    async function scenario({ tag, owner, sites, start, end }) {
      const d = mkdtempSync(join(tmpdir(), "c64re-898d7-"));
      mkdirSync(join(d, "knowledge"), { recursive: true });
      writeFileSync(join(d, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG, ...(tag === "c64" ? {} : { platform: tag }) }));
      const rid = (a) => `${SLUG}:ram/${owner}:routine:${a.toString(16).padStart(4, "0")}`;
      const store = GraphStore.open(d);
      const nodes = sites.map((s) => ({ id: rid(s.at), kind: "routine", name: `sub_${s.at.toString(16)}`, endAddress: s.at + 8, origin: "static", confidence: "certain" }));
      const edges = sites.flatMap((s) => s.stores.map((a) => ({ from: rid(s.at), type: "USES_HARDWARE", to: ids.derivePlatformId(tag, a), evidenceKey: `${s.at}:${a}`, origin: "static", confidence: "certain" })));
      store.replaceGenerated("test", owner, nodes, edges);
      for (const s of sites) if (s.human) store.upsertHuman({ id: rid(s.at), kind: "routine", name: s.human, origin: "user", confidence: "user_asserted" });
      store.close();
      await assertBoundary(d, { name: "io window", level: "container", start, end, description: "io", evidence: ["map"], owner });
      saveContract(d, { goal: "annotate the io window wherever it turns out to be", deliver: { slots: ["S1"], annotate: ["io window"] } });
      return (await verdict(d)).blockers.find((b) => /"io window"/.test(b));
    }
    const vicSites = (h1, h2) => [{ at: 0x1200, stores: [0x9005], human: h1 }, { at: 0x1300, stores: [0x9110], human: h2 }];
    const b1 = await scenario({ tag: "vic20", owner: "vic", sites: vicSites(), start: 0x9000, end: 0x912f });
    check(/touched by 2 routines and not one carries a human name/.test(b1 ?? ""), "vic20 $9000-$912F: sites that are machine-named only block", b1);
    const b2 = await scenario({ tag: "vic20", owner: "vic", sites: vicSites("irq_music", "key_scan"), start: 0x9000, end: 0x912f });
    check(b2 === undefined, "…and met once the sites carry human names", b2);
    const b3 = await scenario({ tag: "vic20", owner: "vic", sites: vicSites("irq_music", undefined), start: 0x9000, end: 0x912f });
    check(b3 === undefined, "…half named meets the default 50 % ratio, as for any region", b3);
    const b3b = await scenario({ tag: "vic20", owner: "vic", sites: [...vicSites("irq_music", undefined), { at: 0x1400, stores: [0x9111] }], start: 0x9000, end: 0x912f });
    check(/is 33 % named — 1 of 3/.test(b3b ?? ""), "…one in three keeps the ratio rule", b3b);
    const b4 = await scenario({ tag: "vic20", owner: "vic", sites: [{ at: 0x1200, stores: [0x900f], human: "x" }], start: 0x9000, end: 0x912f });
    check(b4 === undefined, "…any store anywhere in the window counts as a site", b4);
    const b5 = await scenario({ tag: "vic20", owner: "vic", sites: [], start: 0x9000, end: 0x912f });
    check(/no code references \$9000-\$912F/.test(b5 ?? ""), "a vic20 file with no access: no code references $9000-$912F", b5);
    const b6 = await scenario({ tag: "vic20", owner: "vic", sites: [{ at: 0x1200, stores: [0x9400], human: "x" }], start: 0x9000, end: 0x912f });
    check(/no code references \$9000-\$912F/.test(b6 ?? ""), "a store outside the range ($9400) is not a site", b6);
    const b7 = await scenario({ tag: "vic20", owner: "vic", sites: vicSites("a", "b"), start: 0x8f00, end: 0x912f });
    check(/holds no routine, table or data segment to annotate/.test(b7 ?? ""), "a boundary straddling ram and io keeps the old rule (nodes inside it)", b7);
    const b8 = await scenario({ tag: "c64", owner: "c64o", sites: [{ at: 0xc000, stores: [0xd020], human: undefined }], start: 0xd000, end: 0xd02e });
    check(/touched by 1 routines and not one carries a human name/.test(b8 ?? ""), "c64 $D000-$D02E: machine-named sites block", b8);
    const b9 = await scenario({ tag: "c64", owner: "c64o", sites: [{ at: 0xc000, stores: [0xd020], human: "border_flash" }], start: 0xd000, end: 0xd02e });
    check(b9 === undefined, "…and are met once named", b9);
    const b10 = await scenario({ tag: "c64", owner: "c64o", sites: [], start: 0xd000, end: 0xd02e });
    check(/no code references \$D000-\$D02E/.test(b10 ?? ""), "c64 with no access: no code references $D000-$D02E", b10);
    // the same range is NOT io on the C64 only by tag: $9000 on a c64 owner is ram, old rule
    const b11 = await scenario({ tag: "c64", owner: "c64o", sites: [], start: 0x9000, end: 0x912f });
    check(/holds no routine, table or data segment to annotate/.test(b11 ?? ""), "$9000-$912F on a c64 owner is RAM: the old rule", b11);
  }
  // ── 9 the BASIC stub at the machine's BASIC start ──────────────────────────
  head(9, "a `10 SYS` stub at the VIC-20 / TED BASIC start is a BASIC segment with a SYS entry");
  // load → `10 SYS<target>`, then machine code at target: lda #$F0 ; sta $9005 ; rts ; filler
  const stubPrg = (load, tail) => {
    const progLen = 2 + 2 + (1 + 4 + 1) + 2;                    // link, line no., SYS + 4 digits + $00, end link
    const target = load + progLen;
    const next = load + 2 + 2 + 1 + 4 + 1;
    return { target, prg: prgBytes(load, [next & 0xff, next >> 8, 10, 0, 0x9e, ...Buffer.from(String(target)), 0, 0, 0, ...tail]) };
  };
  const TAIL = [0xa9, 0xf0, 0x8d, 0x05, 0x90, 0x60, 0xea, 0xea];
  const basicFacts = (dir, stem) => {
    const a = JSON.parse(readFileSync(join(dir, "artifacts/prg", `${stem}_analysis.json`), "utf8"));
    return {
      basicSegs: (a.segments ?? []).filter((s) => s.kind === "basic"),
      sysEntries: (a.entryPoints ?? []).filter((e) => e.source === "basic_sys").map((e) => e.address),
    };
  };
  const cases = [
    { stem: "k_vic1001", platform: "vic20", load: 0x1001 },
    { stem: "k_vic1201", platform: "vic20", load: 0x1201 },
    { stem: "k_vic0401", platform: "vic20", load: 0x0401 },
    { stem: "k_ted1001", platform: "plus4", load: 0x1001 },
  ];
  for (const c of cases) {
    const { target, prg } = stubPrg(c.load, TAIL);
    put(projA, `${c.stem}.prg`, prg);
    await call("analyze", { path: `artifacts/prg/${c.stem}.prg`, platform: c.platform });
    const f = basicFacts(projA, c.stem);
    const hex = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
    check(f.basicSegs.length === 1 && f.basicSegs[0].start === c.load, `${c.platform} ${hex(c.load)}: one BASIC segment from the load address`, JSON.stringify(f.basicSegs.map((s) => [s.start, s.end])));
    check(f.sysEntries.length === 1 && f.sysEntries[0] === target, `${c.platform} ${hex(c.load)}: the SYS entry is ${hex(target)}`, f.sysEntries.join(","));
    const out = await call("disasm", { path: `artifacts/prg/${c.stem}.prg`, platform: c.platform });
    check(/rebuild verified byte-identical/.test(out) || !HAVE_KICKASS, `${c.platform} ${hex(c.load)}: the door's own rebuild proof is byte-identical`, out.split("\n").find((l) => /rebuild/.test(l)));
    await rebuild(projA, c.stem, join(projA, "artifacts/prg", `${c.stem}.prg`), `${c.platform} ${hex(c.load)}`);
  }
  // the same $1001 bytes as a C64 are what they were: no BASIC start there, no segment, no SYS entry
  const sameAsC64 = stubPrg(0x1001, TAIL);
  put(projA, "k_c64_1001.prg", sameAsC64.prg);
  await call("analyze", { path: "artifacts/prg/k_c64_1001.prg" });
  const f64 = basicFacts(projA, "k_c64_1001");
  check(f64.basicSegs.length === 0 && f64.sysEntries.length === 0, "c64 at $1001: no BASIC segment, no SYS entry (today's behaviour)", JSON.stringify(f64));
  // …and a VIC-20 program at a C64 BASIC start is not a BASIC stub either; the C64 start is the C64's
  const atC64Start = stubPrg(0x0801, TAIL);
  put(projA, "k_vic_0801.prg", atC64Start.prg);
  await call("analyze", { path: "artifacts/prg/k_vic_0801.prg", platform: "vic20" });
  const fV0801 = basicFacts(projA, "k_vic_0801");
  check(fV0801.basicSegs.length === 0 && fV0801.sysEntries.length === 0, "vic20 at $0801: not a BASIC start of that machine → no BASIC segment");
  put(projA, "k_c64_0801.prg", atC64Start.prg);
  await call("analyze", { path: "artifacts/prg/k_c64_0801.prg" });
  const f0801 = basicFacts(projA, "k_c64_0801");
  check(f0801.basicSegs.length === 1 && f0801.sysEntries[0] === atC64Start.target, "c64 at $0801: BASIC segment and SYS entry, as before", JSON.stringify(f0801));
  // the pipeline's start set is the store-side default list, one for one
  const { defaultLoadAddresses: dla } = await import(join(ROOT, "dist/project-knowledge/platform-default.js"));
  for (const tag of ["c64", "c1541", "vic20", "plus4"]) {
    check(JSON.stringify(twin.basicStartAddresses(tag)) === JSON.stringify(dla(tag)), `basicStartAddresses(${tag}) equals defaultLoadAddresses(${tag})`, JSON.stringify(twin.basicStartAddresses(tag)));
  }
  // RAM vectors: $0318 is NMINV on the VIC-20 and IOPEN on the TED machines
  const vecCode = (lo) => [0xa9, 0x80, 0x8d, lo, 0x03, 0xa9, 0x0f, 0x8d, lo + 1, 0x03, 0x60];   // handler at $0F80
  const vecEntry = async (stem, platform, lo) => {
    put(projA, `${stem}.prg`, prgBytes(0x0f00, [...vecCode(lo), ...new Array(0x100 - 11 - 1).fill(0xea), 0x60]));
    await call("analyze", { path: `artifacts/prg/${stem}.prg`, ...(platform ? { platform } : {}) });
    const a = JSON.parse(readFileSync(join(projA, "artifacts/prg", `${stem}_analysis.json`), "utf8"));
    return (a.entryPoints ?? []).filter((e) => e.source === "vector").map((e) => e.symbol);
  };
  check((await vecEntry("k_v_c64", undefined, 0x18)).includes("nmi_vector_ram"), "c64: a store to $0318/$0319 is the NMI vector");
  check((await vecEntry("k_v_vic", "vic20", 0x18)).includes("nmi_vector_ram"), "vic20: a store to $0318/$0319 is the NMI vector (NMINV)");
  check(!(await vecEntry("k_v_ted", "plus4", 0x18)).includes("nmi_vector_ram"), "plus4: $0318/$0319 is IOPEN, not an NMI vector");
  check((await vecEntry("k_v_ted14", "plus4", 0x14)).includes("irq_vector_ram"), "plus4: $0314/$0315 is still CINV, the IRQ vector");
  check((await vecEntry("k_v_vic14", "vic20", 0x14)).includes("irq_vector_ram"), "vic20: $0314/$0315 is CINV, the IRQ vector");
  // basic_list reads a program at the machine's start. On the C64 a byte above $CB is no token (shown as {$CC});
  // on plus4 it is a BASIC 3.5 keyword, named from the TED BASIC keyword table.
  const ted35 = prgBytes(0x1001, [0x0c, 0x10, 10, 0, 0x99, 0x22, 0x41, 0x22, 0x3a, 0xcc, 0, 0, 0]);   // 10 PRINT"A":<$CC>
  put(projA, "k_ted35.prg", ted35);
  const lst = await call("basic_list", { prg_path: "artifacts/prg/k_ted35.prg" });
  check(/10 PRINT"A":\{\$CC\}/.test(lst), "basic_list on the C64 (default): $CC is no token, shown as {$CC}", lst.split("\n").find((l) => /^10 /.test(l)));
  const lstVic = await call("basic_list", { prg_path: "artifacts/prg/k_ted35.prg", platform: "vic20" });
  check(/10 PRINT"A":\{\$CC\}/.test(lstVic), "basic_list on the VIC-20: BASIC is V2, $CC stays {$CC}");
  const lstTed = await call("basic_list", { prg_path: "artifacts/prg/k_ted35.prg", platform: "plus4" });
  check(/10 PRINT"A":RGR/.test(lstTed), "basic_list on plus4: $CC is RGR", lstTed.split("\n").find((l) => /^10 /.test(l)));

  // BASIC 3.5: tokenize -> bytes read off the TED keyword table -> list -> tokenize gives the same bytes
  const src35 = ["10 COLOR 0,1:GRAPHIC 1,1:SCNCLR", "20 DO:LOOP UNTIL A=1", "30 PRINT USING\"##\";A:DELETE 5-9", "40 IF A THEN PRINT:ELSE PRINT RENUMBER", "50 A$=HEX$(5)+RIGHT$(B$,1):WHILE X", "60 PRINT INSTR(A$,\"X\"):PRINT#1,2"].join("\n");
  const out35 = join(projA, "artifacts", "tok35.prg");
  await call("basic_tokenize", { project_dir: projA, text: src35, output_path: out35, platform: "plus4" });
  const b35 = readFileSync(out35);
  const has = (...seq) => b35.indexOf(Buffer.from(seq)) >= 0;
  check(b35[0] === 0x01 && b35[1] === 0x10, "plus4 tokenize loads at $1001");
  check(has(0xe7, 0x20, 0x30) && has(0xde, 0x20) && has(0xe8) && has(0xeb, 0x3a, 0xec, 0x20, 0xfc),
    "plus4 tokenize: COLOR=$E7, GRAPHIC=$DE, SCNCLR=$E8, DO=$EB, LOOP=$EC, UNTIL=$FC");
  check(has(0xfb) && has(0xf7) && has(0xf8) && has(0xd5) && has(0xd2) && has(0xfd) && has(0xd4),
    "plus4 tokenize: USING=$FB, DELETE=$F7, RENUMBER=$F8, ELSE=$D5, HEX$=$D2, WHILE=$FD, INSTR=$D4");
  check(has(0x98, 0x31), "plus4 tokenize: PRINT# is still one token ($98)");
  const lst35 = await call("basic_list", { prg_path: out35, platform: "plus4", json: true });
  const listing35 = JSON.parse(lst35).listing;
  check(listing35 === src35, "plus4 basic_list of the tokenized program is the source text, keyword for keyword", listing35.split("\n").slice(0, 2).join(" / "));
  const out35b = join(projA, "artifacts", "tok35b.prg");
  await call("basic_tokenize", { project_dir: projA, text: listing35, output_path: out35b, platform: "plus4" });
  check(readFileSync(out35b).equals(b35), "plus4 round trip: tokenize -> list -> tokenize is byte-identical");
  // the same text on the C64 is not 3.5: V2 knows no COLOR, so it stays letters
  const out35c = join(projA, "artifacts", "tok35c.prg");
  await call("basic_tokenize", { project_dir: projA, text: "10 COLOR 0,1:A=1", output_path: out35c });
  check(!readFileSync(out35c).includes(0xe7), "C64 tokenize: COLOR is not a keyword, no $E7 written");
  // the last token and the one past it: $FD is WHILE, $FE (the escape hook) is no keyword
  put(projA, "k_ted35z.prg", prgBytes(0x1001, [0x09, 0x10, 10, 0, 0xfd, 0xfe, 0xff, 0, 0, 0]));
  const lstZ = await call("basic_list", { prg_path: "artifacts/prg/k_ted35z.prg", platform: "plus4" });
  check(/10 WHILE\{\$FE\}π/.test(lstZ), "plus4 list: $FD = WHILE (last token), $FE is no keyword, $FF = pi", lstZ.split("\n").find((l) => /^10 /.test(l)));
function makeD64(files) {
  const img = Buffer.alloc(174848);
  const spt = (t) => t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17;
  const off = (t, s) => { let o = 0; for (let i = 1; i < t; i++) o += spt(i) * 256; return o + s * 256; };
  const bam = off(18, 0);
  img[bam] = 18; img[bam + 1] = 1; img[bam + 2] = 0x41;
  img.fill(0xa0, bam + 0x90, bam + 0xa2); img.write("TESTDISK", bam + 0x90, "latin1");
  img[bam + 0xa2] = 0x30; img[bam + 0xa3] = 0x30; img[bam + 0xa5] = 0x32; img[bam + 0xa6] = 0x41;
  let t = 1, s = 0;
  const dir = off(18, 1);
  img[dir] = 0; img[dir + 1] = 0xff;
  files.forEach((f, i) => {
    const body = f.bytes;
    const chunks = []; for (let p = 0; p < body.length; p += 254) chunks.push(body.subarray(p, p + 254));
    const first = [t, s];
    chunks.forEach((c, k) => {
      const o = off(t, s); c.copy(img, o + 2);
      const last = k === chunks.length - 1;
      let nt = t, ns = s + 1; if (ns >= spt(t)) { nt = t + 1; ns = 0; if (nt === 18) nt = 19; }
      if (last) { img[o] = 0; img[o + 1] = c.length + 1; } else { img[o] = nt; img[o + 1] = ns; t = nt; s = ns; }
      if (last) { s = ns; t = nt; }
    });
    const e = dir + i * 32;
    img[e + 2] = 0x82; img[e + 3] = first[0]; img[e + 4] = first[1];
    img.fill(0xa0, e + 5, e + 21); img.write(f.name, e + 5, "latin1");
    img[e + 30] = chunks.length & 0xff; img[e + 31] = chunks.length >> 8;
  });
  return img;
}

  // ── 10 D8 the machine is asked for · D9 a raw cartridge is placed by its signature ──
  head(10, "D8: the machine is stated and asked for; D9: a raw cartridge image is placed by its signature");
  const mkProject = async (tag, platform) => {
    const d = mkdtempSync(join(tmpdir(), `c64re-898-${tag}-`));
    await call("project_init", { project_dir: d, name: `platforms-${tag}`, ...(platform ? { platform } : {}) });
    await call("agent_onboard", { project_dir: d });
    return d;
  };
  const statusOf = (d) => call("project_status", { project_dir: d });
  const onboardOf = (d) => call("agent_onboard", { project_dir: d });
  const machineBlock = (t) => {
    const ls = t.split("\n"); const i = ls.findIndex((l) => /^Machine:/.test(l));
    if (i < 0) return "";
    let j = i + 1; while (j < ls.length && /^  (\d+ registered|- |Ask the human)/.test(ls[j])) j++;
    return ls.slice(i, j).join("\n");
  };
  const ASK = /project_init/;

  const pc = await mkProject("d8c");
  for (const [what, fn] of [["agent_onboard", onboardOf], ["project_status", statusOf]]) {
    const t = await fn(pc);
    check(/^Machine: Commodore 64 \(c64\) — no machine recorded/m.test(t), `${what}: a project with no machine says it is assuming the C64`);
    check(!/look like another machine/.test(t), `${what}: …and with no foreign-looking file says nothing more`);
  }
  put(pc, "g_1001.prg", prgBytes(0x1001, [0x0c, 0x10, 10, 0, 0x99, 0, 0, 0, 0xea, 0xea]));
  put(pc, "g_0801.prg", prgBytes(0x0801, [0x0c, 0x08, 10, 0, 0x99, 0, 0, 0, 0xea, 0xea]));
  await call("analyze", { project_dir: pc, path: "artifacts/prg/g_1001.prg" });
  await call("analyze", { project_dir: pc, path: "artifacts/prg/g_0801.prg" });
  for (const [what, fn] of [["agent_onboard", onboardOf], ["project_status", statusOf]]) {
    const t = await fn(pc);
    check(/1 registered file\(s\) look like another machine's/.test(t) && /g_1001\.prg: load address \$1001/.test(t), `${what}: a $1001 file is named, with the address`, machineBlock(t));
    check(!/g_0801/.test(machineBlock(t)), `${what}: a $0801 file is not foreign`);
    check(ASK.test(machineBlock(t)) && /platform: "vic20" or "plus4"/.test(machineBlock(t)) && /Ask the human/.test(machineBlock(t)), `${what}: …and names the one call, project_init with platform`);
  }
  // a cartridge signature
  const cartVic = Buffer.alloc(0x2000, 0xea); cartVic.set([0x41, 0x30, 0xc3, 0xc2, 0xcd], 4);
  const cartTed = Buffer.alloc(0x4000, 0xea); cartTed.set([0x43, 0x42, 0x4d], 7);
  const pcart = await mkProject("d8cart");
  put(pcart, "cart_vic.bin", cartVic);
  await call("analyze", { project_dir: pcart, path: "artifacts/prg/cart_vic.bin", load_address: "A000" });
  const tc = await onboardOf(pcart);
  check(/cart_vic\.bin: cartridge signature A0CBM \(\$41 \$30 \$C3 \$C2 \$CD\) at offset 4/.test(tc) && ASK.test(machineBlock(tc)), "agent_onboard: a cartridge signature file is named with its signature and the call that settles it", machineBlock(tc));
  const tcs = await statusOf(pcart);
  check(/cart_vic\.bin: cartridge signature A0CBM/.test(tcs), "project_status: the same");
  // a project WITH a machine states it and stays quiet about foreign files
  put(projB, "g_1001.prg", prgBytes(0x1001, [0x0c, 0x10, 10, 0, 0x99, 0, 0, 0, 0xea, 0xea]));
  await call("analyze", { project_dir: projB, path: "artifacts/prg/g_1001.prg" });
  for (const [what, fn] of [["agent_onboard", onboardOf], ["project_status", statusOf]]) {
    const t = await fn(projB);
    check(/^Machine: VIC-20 \(vic20\) — the project default/m.test(t), `${what}: a vic20 project states its machine and where it came from`, machineBlock(t));
    check(!/look like another machine/.test(t), `${what}: …and does not second-guess it`);
  }
  // a machine named later settles it: the hint is gone
  await call("project_init", { project_dir: pc, name: "platforms-d8c", platform: "vic20" });
  check(/^Machine: VIC-20 \(vic20\)/m.test(await onboardOf(pc)) && !/look like/.test(await onboardOf(pc)), "project_init platform settles it: the next onboarding states the machine and the hint is gone");

  // .d64 → extract_disk in a vic20 project → VIC-20 names with no platform argument
  const pd64 = await mkProject("d8d64", "vic20");
  const vicProg = prgBytes(0x1001, [0xa9, 0xf0, 0x8d, 0x05, 0x90, 0x8d, 0x0e, 0x91, 0x60, 0xea, 0xea, 0xea]);
  mkdirSync(join(pd64, "media"), { recursive: true });
  writeFileSync(join(pd64, "media", "t.d64"), makeD64([{ name: "VICPROG", bytes: vicProg }]));
  const ex = await call("extract_disk", { project_dir: pd64, image_path: "media/t.d64" });
  const manifest = JSON.parse(readFileSync(join(pd64, "analysis/disk/t/manifest.json"), "utf8"));
  const mf = (manifest.files ?? [])[0];
  check(mf !== undefined, ".d64: extract_disk reads a synthetic image written for the test", ex.split("\n")[0]);
  const extracted = mf?.relativePath;
  const extractedAbs = extracted ? join(pd64, "analysis/disk/t", extracted) : undefined;
  check(extractedAbs && existsSync(extractedAbs) && readFileSync(extractedAbs).equals(vicProg), ".d64: the file came out byte-identical", JSON.stringify(mf).slice(0, 300));
  if (extractedAbs && existsSync(extractedAbs)) {
    // the extracted file has no artifact platform: the project default is the only thing that can name it
    await call("analyze", { project_dir: pd64, path: extractedAbs });
    await call("disasm", { project_dir: pd64, path: extractedAbs });
    const tas = readFileSync(extractedAbs.replace(/\.prg$/, "_disasm.tas"), "utf8");
    const sym = kb.node("vic20", 0x9005)?.symbol;
    check(!sym || new RegExp(`\\b${sym}\\b`).test(tas), "extracted .d64 file in a vic20 project: $9005 carries the VIC-20 name with no platform argument", sym);
    check(names(tas).length === 0, "…and no C64-only name appears", names(tas).join(","));
    const pcd = await mkProject("d8d64c");
    mkdirSync(join(pcd, "media"), { recursive: true });
    writeFileSync(join(pcd, "media", "t.d64"), makeD64([{ name: "VICPROG", bytes: vicProg }]));
    await call("extract_disk", { project_dir: pcd, image_path: "media/t.d64" });
    const m2 = JSON.parse(readFileSync(join(pcd, "analysis/disk/t/manifest.json"), "utf8")).files[0];
    await call("analyze", { project_dir: pcd, path: join(pcd, "analysis/disk/t", m2.relativePath) });
    await call("disasm", { project_dir: pcd, path: join(pcd, "analysis/disk/t", m2.relativePath) });
    const tas2 = readFileSync(join(pcd, "analysis/disk/t", m2.relativePath.replace(/\.prg$/, "_disasm.tas")), "utf8");
    check(!sym || !new RegExp(`\\b${sym}\\b`).test(tas2), "control: the same disk in a project with no machine renders as the C64 (no VIC-20 name)", sym);
  }

  // D9
  const pd9 = await mkProject("d9", "vic20");
  const hexA = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  put(pd9, "cartv.bin", cartVic);
  const r9 = await call("disasm", { project_dir: pd9, path: "artifacts/prg/cartv.bin" });
  check(/A0CBM \(\$41 \$30 \$C3 \$C2 \$CD\) at offset 4/.test(r9) && /\$A000-\$BFFF/.test(r9), "vic20: A0CBM at offset 4 → raw at $A000, the signature named as evidence", r9.split("\n").find((l) => /Reading/.test(l)));
  const a9 = await call("analyze", { project_dir: pd9, path: "artifacts/prg/cartv.bin" });
  check(/A0CBM/.test(a9) && /\$A000-\$BFFF/.test(a9), "…the analyze door reads it the same way", a9.split("\n").find((l) => /Reading/.test(l)));
  const r9e = await call("disasm", { project_dir: pd9, path: "artifacts/prg/cartv.bin", load_address: "9000" });
  check(/\$9000-\$AFFF/.test(r9e) && !/A0CBM/.test(r9e), "an explicit load_address wins over the signature", r9e.split("\n").find((l) => /Reading/.test(l)));
  const pt = await mkProject("d9ted", "plus4");
  put(pt, "cartt.bin", cartTed);
  const rt = await call("disasm", { project_dir: pt, path: "artifacts/prg/cartt.bin" });
  check(/CBM \(\$43 \$42 \$4D\) at offset 7/.test(rt) && /\$8000-\$BFFF/.test(rt), "plus4: CBM at offset 7 → raw at $8000, the signature named", rt.split("\n").find((l) => /Reading/.test(l)));
  const at = await call("analyze", { project_dir: pt, path: "artifacts/prg/cartt.bin" });
  check(/CBM \(\$43 \$42 \$4D\) at offset 7/.test(at) && /\$8000-\$BFFF/.test(at), "…and analyze too");
  // the wrong machine's signature does not place the image
  const rw = await call("disasm", { project_dir: pt, path: "artifacts/prg/cartt.bin", platform: "vic20" });
  check(!/cartridge signature/.test(rw), "a TED signature on a vic20 render places nothing", rw.split("\n").find((l) => /Reading/.test(l)));
  // c64 unchanged: read as headed, the signature only mentioned
  const p64 = await mkProject("d9c64");
  put(p64, "cartv.bin", cartVic);
  const rc = await call("disasm", { project_dir: p64, path: "artifacts/prg/cartv.bin" });
  const rcLine = rc.split("\n").find((l) => /Reading/.test(l)) ?? "";
  check(/read as headed/.test(rcLine) && /may be a raw VIC-20 cartridge/.test(rcLine) && /project_init/.test(rcLine), "c64: unchanged (read as headed), the signature is mentioned and project_init named", rcLine);
  put(p64, "plain.bin", Buffer.from([0x01, 0x08, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea]));
  const rp = await call("disasm", { project_dir: p64, path: "artifacts/prg/plain.bin" });
  check(!/cartridge signature/.test(rp), "c64: a file without a signature has no note");
  // no signature → the refusal with the machine's offers, $A000 for vic20
  put(pd9, "tiny.bin", Buffer.from([0xea, 0xea]));
  const rn = await call("disasm", { project_dir: pd9, path: "artifacts/prg/tiny.bin" });
  check(/refused/.test(rn) && /\$1001/.test(rn) && /\$0401/.test(rn) && /\$1201/.test(rn) && /\$A000/.test(rn), "vic20 without a signature: the refusal offers $1001/$0401/$1201 and $A000", rn.split("\n").slice(0, 4).join(" | "));
  put(p64, "tiny.bin", Buffer.from([0xea, 0xea]));
  const rn64 = await call("disasm", { project_dir: p64, path: "artifacts/prg/tiny.bin" });
  check(/refused/.test(rn64) && !/\$A000|\$1001/.test(rn64), "c64: the refusal is as it was, no offers");
  // ── 11 the acceptance run ───────────────────────────────────────────────────
  head(11, "unowned I/O boundary, colour RAM, preview, one-name rows, range-true stores");
  {
    const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
    const { assertBoundary } = await import(join(ROOT, "dist/model/store.js"));
    const { saveContract } = await import(join(ROOT, "dist/contract/contract.js"));
    const { verdict } = await import(join(ROOT, "dist/critic/run.js"));
    const { declareMachine } = await import(join(ROOT, "dist/knowledge-graph/producers/machine.js"));
    // D-A: a boundary with NO owner, in a project with NO default machine
    async function unowned({ edges, declared, human }) {
      const d = mkdtempSync(join(tmpdir(), "c64re-898da-"));
      mkdirSync(join(d, "knowledge"), { recursive: true });
      writeFileSync(join(d, "knowledge", "project.json"), JSON.stringify({ name: "da", slug: "da" }));
      const owner = "vic";
      const rid = (a) => `da:ram/${owner}:routine:${a.toString(16).padStart(4, "0")}`;
      const store = GraphStore.open(d);
      const sites = edges.map((e, i) => ({ at: 0x1200 + i * 0x100, tag: e[0], addr: e[1] }));
      store.replaceGenerated("test", owner, sites.map((s) => ({ id: rid(s.at), kind: "routine", name: `sub_${s.at.toString(16)}`, endAddress: s.at + 8, origin: "static", confidence: "certain" })),
        sites.map((s) => ({ from: rid(s.at), type: "USES_HARDWARE", to: ids.derivePlatformId(s.tag, s.addr), evidenceKey: `${s.at}:${s.addr}`, origin: "static", confidence: "certain" })));
      if (human) for (const s of sites) store.upsertHuman({ id: rid(s.at), kind: "routine", name: `named_${s.at.toString(16)}`, origin: "user", confidence: "user_asserted" });
      store.close();
      if (declared) declareMachine(d, owner, declared);
      await assertBoundary(d, { name: "io window", level: "container", start: 0x9000, end: 0x912f, description: "io", evidence: ["map"] });
      saveContract(d, { goal: "annotate the io window", deliver: { slots: ["S1"], annotate: ["io window"] } });
      return (await verdict(d)).blockers.find((b) => /"io window"/.test(b));
    }
    const vicEdges = [["vic20", 0x9005], ["vic20", 0x9110]];
    const a1 = await unowned({ edges: vicEdges, human: false });
    check(/touched by 2 routines and not one carries a human name/.test(a1 ?? ""), "D-A: an unowned $9000-$912F boundary, edges all vic20, no default → judged as the I/O window", a1);
    const a2 = await unowned({ edges: vicEdges, human: true });
    check(a2 === undefined, "D-A: …and met once the referencing routines carry human names", a2);
    const a3 = await unowned({ edges: [], declared: "vic20" });
    check(/no code references \$9000-\$912F/.test(a3 ?? ""), "D-A: no edges, the owner declared vic20 → still the I/O window, not RAM", a3);
    const a4 = await unowned({ edges: [["vic20", 0x9005], ["c64", 0xd020]], human: true });
    check(/holds no routine, table or data segment to annotate/.test(a4 ?? ""), "D-A: mixed tags → the project default (c64), $9000 is RAM, as before", a4);

    // D-C / D-B / D-D / D-E on one VIC-20 file
    const pd = mkdtempSync(join(tmpdir(), "c64re-898-acc-"));
    await call("project_init", { project_dir: pd, name: "acc" });
    await call("agent_onboard", { project_dir: pd });
    // lda #1 ; sta $9600,x ; sta $9005 ; lda #$e ; sta $9110 ; jsr $FFD2 ; rts
    const accBody = [0xa9, 0x01, 0x9d, 0x00, 0x96, 0x8d, 0x05, 0x90, 0xa9, 0x0e, 0x8d, 0x10, 0x91, 0x20, 0xd2, 0xff, 0x60];
    put(pd, "acc.prg", prgBytes(0x1201, accBody));
    const rAcc = await call("disasm", { project_dir: pd, path: "artifacts/prg/acc.prg", platform: "vic20" });
    const lst = readFileSync(join(pd, "artifacts/prg", "acc_disasm.tas"), "utf8");
    const line = (re) => lst.split("\n").find((l) => re.test(l)) ?? "";
    const colLine = line(/\$9600/);
    check(/colour RAM/.test(colLine), "D-C: `sta $9600,x` carries a comment naming the colour RAM", colLine);
    const reg = kb.region("vic20", 0x9600);
    check(reg && reg.endAddress === 0x97ff && /^secondary: .*p\.\d+/.test(reg.source), "D-C: the store holds the region $9600-$97FF as a marked, page-cited secondary row", reg?.source);
    check(!kb.region("vic20", 0x9800) && kb.region("vic20", 0x95ff)?.name === "VICCOL", "D-C: …$9400-$95FF stays the ROM-source VICCOL, $9800 is outside");
    const crLine = line(/\$9005/);
    check(/VIC_CR5/.test(crLine) && !/VIC_CR5 VIC_CR5/.test(crLine), "D-B: a row whose name equals its symbol prints it once (VIC_CR5)", crLine);
    const bsLine = line(/\$FFD2/i);
    check(!/(\b\w+\b) \1\b/.test(bsLine.slice(bsLine.indexOf(";"))), "D-B: …and so does the KERNAL call", bsLine);
    const gn = await call("graph_node", { project_dir: pd, ref: "vic20:io:9005" });
    check(!/VIC_CR5 VIC_CR5/.test(gn) && /VIC_CR5/.test(gn), "D-B: graph_node prints it once too", gn.split("\n")[0]);
    await call("analyze", { project_dir: pd, path: "artifacts/prg/acc.prg", platform: "vic20" });
    const insA = (start, end) => call("inspect_address_range", { project_dir: pd, prg_path: "artifacts/prg/acc.prg", start_address: start, end_address: end, analysis_json: "artifacts/prg/acc_analysis.json", platform: "vic20" });
    const i1 = await insA("9000", "9010");
    check(/\$1\w+ VIC_CR5/.test(i1) && !/\$9600/.test(i1.split("##").find((x) => /I\/O register stores/.test(x)) ?? "") && !/\$9110/.test(i1.split("##").find((x) => /I\/O register stores/.test(x)) ?? ""), "D-D: $9000-$9010 lists the $9005 store and none of the others", (i1.split("##").find((x) => /I\/O register stores/.test(x)) ?? "").trim().split("\n").slice(0, 4).join(" | "));
    check(/I\/O register stores \(1 stores\)/.test(i1), "D-D: …and the count is the filtered one", i1.split("\n").find((l) => /register stores/.test(l)));
    const i2 = await insA("9600", "9604");
    check(/I\/O register stores \(1 stores\)/.test(i2) && /colour RAM/.test(i2), "D-C/D-D: $9600-$9604 lists the one store, and names the region", i2.split("\n").find((l) => /\$1\w+ .*9600|colour/.test(l)));
    const i3 = await insA("9800", "9803");
    check(/I\/O register stores \(0 stores\)/.test(i3) && /Platform store: no vic20 row or region covers/.test(i3.split("##")[0]), "D-D: a range the store names nothing in says so in the header (before the sections)", i3.split("\n").find((l) => /Platform store/.test(l)));
    check(!/Platform store: no/.test(i1) && !/Platform store: no/.test(i2), "D-D: …and does not say it where there is a row or region");
    const i4 = await insA("1201", "1210");
    check(!/Platform store: no/.test(i4), "D-D: a range outside the I/O window gets no such note");

    // D-B on the c64: PHOENIX ($FF56) is a row whose name equals its symbol
    const pc64 = mkdtempSync(join(tmpdir(), "c64re-898-b64-"));
    await call("project_init", { project_dir: pc64, name: "b64" });
    await call("agent_onboard", { project_dir: pc64 });
    put(pc64, "b.prg", prgBytes(0x0801, [0x20, 0x56, 0xff, 0x60]));
    await call("analyze", { project_dir: pc64, path: "artifacts/prg/b.prg", platform: "c64" });
    await call("disasm", { project_dir: pc64, path: "artifacts/prg/b.prg", platform: "c64" });
    const l64 = readFileSync(join(pc64, "artifacts/prg", "b_disasm.tas"), "utf8").split("\n").find((l) => /\$FF56/i.test(l)) ?? "";
    check(/PHOENIX/.test(l64) && !/PHOENIX PHOENIX/.test(l64), "D-B: c64 `jsr $FF56` prints PHOENIX once", l64);

    // D-E: a preview records no machine on the file
    put(pd, "pv.prg", prgBytes(0x1201, accBody));
    await call("disasm", { project_dir: pd, path: "artifacts/prg/pv.prg", platform: "vic20", import_graph: false });
    check(rowOf(pd, "pv.prg")?.platform === undefined, "D-E: disasm platform=vic20 import_graph=false leaves the artifact record without a platform", String(rowOf(pd, "pv.prg")?.platform));
    await call("disasm", { project_dir: pd, path: "artifacts/prg/pv.prg", import_graph: false });
    const pvTas = readFileSync(join(pd, "artifacts/prg", "pv_disasm.tas"), "utf8");
    check(!/VIC_CR5/.test(pvTas), "D-E: the control render without a platform is the c64 reading, not a silently-recorded vic20", pvTas.split("\n").find((l) => /\$9005/.test(l)));
    await call("disasm", { project_dir: pd, path: "artifacts/prg/pv.prg", platform: "vic20" });
    check(rowOf(pd, "pv.prg")?.platform === "vic20", "D-E: a normal render with the explicit platform records it", String(rowOf(pd, "pv.prg")?.platform));
    await call("disasm", { project_dir: pd, path: "artifacts/prg/pv.prg" });
    check(/VIC_CR5/.test(readFileSync(join(pd, "artifacts/prg", "pv_disasm.tas"), "utf8")), "D-E: …and the next render that names none keeps vic20");
  }
} finally {
  proc.kill();
}

console.log(`\n${pass} passed, ${failCount} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failCount === 0 ? 0 : 1);
