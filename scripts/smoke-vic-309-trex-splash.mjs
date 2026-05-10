#!/usr/bin/env node
// Spec 309 — load TREX_splash.prg, run, capture splash screen.
// Tests literal port BMM↔TEXT mid-frame split via:
//   IRQ at raster $EE: switch to TEXT mode + chargen $5800 + xscroll
//   IRQ at raster $FB: restore BMM + bitmap $6000
// Expected: koala BMM image (top 22 rows) + scroller text bottom row.

import { mkdirSync, readFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const OUT_DIR = `${REPO}/samples/screenshots/trex-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

const PRG = "/Users/alex/Development/C64/Coding/TREX-Claw/TREX_splash.prg";
const prgBuf = readFileSync(PRG);
const loadAddr = prgBuf[0] | (prgBuf[1] << 8);
console.log(`PRG load addr = $${loadAddr.toString(16)}, body size = ${prgBuf.length - 2}`);

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
});
s.resetCold("pal-default");
// Boot to BASIC ready (no disk load, just KERNAL boot)
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Inject PRG bytes directly into RAM at load addr
for (let i = 2; i < prgBuf.length; i++) {
  s.c64Bus.write(loadAddr + (i - 2), prgBuf[i]);
}
console.log(`Injected PRG: $${loadAddr.toString(16)} - $${(loadAddr + prgBuf.length - 3).toString(16)}`);

// Set BASIC pointers (SYS $0810 via BasicUpstart pattern at $0801)
// Easier: just set CPU PC = $0810 directly (skip BASIC interpreter)
s.c64Cpu.pc = 0x0810;
console.log(`Set PC = $0810 (entry point), starting...`);

// Run for several seconds to let splash + fade + scroller settle.
const r = s.vic.regs;
for (let f = 0; f < 12; f++) {
  s.runFor(200_000, { cycleBudget: 1_500_000 });
  console.log(`  +${(f+1)*1.5}M cyc: PC=$${s.c64Cpu.pc.toString(16)} D011=$${r[0x11].toString(16)} D018=$${r[0x18].toString(16)} D015=$${r[0x15].toString(16)}`);
}

// Inspect bitmap region $6000 + screen RAM $4400
let bitmapNonZero = 0;
let screenNonZero = 0;
let colorRamNonZero = 0;
for (let i = 0; i < 8000; i++) if (s.c64Bus.read(0x6000 + i) !== 0) bitmapNonZero++;
for (let i = 0; i < 1000; i++) if (s.c64Bus.read(0x4400 + i) !== 0) screenNonZero++;
for (let i = 0; i < 1000; i++) if ((s.c64Bus.read(0xd800 + i) & 0x0f) !== 0) colorRamNonZero++;
console.log(`bitmap $6000-$7F3F nonzero: ${bitmapNonZero}/8000`);
console.log(`screen $4400-$47E7 nonzero: ${screenNonZero}/1000`);
console.log(`color  $D800-$DBE7 nonzero: ${colorRamNonZero}/1000`);
const dumpRow = (label, base, n) => {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(s.c64Bus.read(base + i).toString(16).padStart(2,"0"));
  console.log(`  ${label}: ${vals.join(" ")}`);
};
dumpRow("screen $4400-$440F", 0x4400, 16);
dumpRow("color  $D800-$D80F", 0xd800, 16);
dumpRow("bitmap $6000-$600F", 0x6000, 16);
console.log(`  D020=$${r[0x20].toString(16)} D021=$${r[0x21].toString(16)}`);

const path = `${OUT_DIR}/trex-splash.png`;
const renderResult = s.renderToPng(path);
console.log(`\nRendered: ${renderResult.width}x${renderResult.height} ${renderResult.bytes} bytes -> ${path}`);

// Inspect literal port state + dbuf (= what literal sees at render moment)
console.log(`\nliteral vicii state:`);
console.log(`  raster_line=${LIT_TYPES.vicii.raster_line} raster_cycle=${LIT_TYPES.vicii.raster_cycle}`);
console.log(`  vbank_phi1=$${LIT_TYPES.vicii.vbank_phi1.toString(16)} vbank_phi2=$${LIT_TYPES.vicii.vbank_phi2.toString(16)}`);
console.log(`  bad_line=${LIT_TYPES.vicii.bad_line} idle_state=${LIT_TYPES.vicii.idle_state}`);
console.log(`  cycle_flags=$${(LIT_TYPES.vicii.cycle_flags >>> 0).toString(16)}`);
console.log(`  ysmooth=${LIT_TYPES.vicii.ysmooth}`);
const dbuf = LIT_TYPES.vicii.dbuf;
let dbufNz = 0;
for (let i = 0; i < dbuf.length; i++) if (dbuf[i] !== 0) dbufNz++;
console.log(`  dbuf size=${dbuf.length} nonzero=${dbufNz}`);
// First 32 bytes
const dbufHex = [];
for (let i = 0; i < 32; i++) dbufHex.push(dbuf[i].toString(16).padStart(2,"0"));
console.log(`  dbuf[0..32]: ${dbufHex.join(" ")}`);

// Check literalPortFb (= accumulated 520x312 — only filled if per-cycle hook fires)
console.log(`literalPortFb defined: ${!!s.literalPortFb}`);
if (s.literalPortFb) {
  let fbNz = 0;
  for (let i = 0; i < s.literalPortFb.length; i++) if (s.literalPortFb[i] !== 0) fbNz++;
  console.log(`  literalPortFb nonzero=${fbNz}/${s.literalPortFb.length}`);
}

// Probe literal port internals
const v = LIT_TYPES.vicii;
console.log(`\nlit vbuf[] (= matrix fetch result):`);
const vbufHex = [];
for (let i = 0; i < 16; i++) vbufHex.push(v.vbuf[i].toString(16).padStart(2,"0"));
console.log(`  ${vbufHex.join(" ")}`);
console.log(`lit cbuf[] (= color RAM):`);
const cbufHex = [];
for (let i = 0; i < 16; i++) cbufHex.push(v.cbuf[i].toString(16).padStart(2,"0"));
console.log(`  ${cbufHex.join(" ")}`);
console.log(`ram_base_phi2 length=${v.ram_base_phi2.length}`);
console.log(`ram_base_phi2[$4400..$440F]:`);
const ramHex = [];
for (let i = 0; i < 16; i++) ramHex.push(v.ram_base_phi2[0x4400+i].toString(16).padStart(2,"0"));
console.log(`  ${ramHex.join(" ")}`);
console.log(`ram_base_phi2[$6000..$600F]:`);
const ramHex2 = [];
for (let i = 0; i < 16; i++) ramHex2.push(v.ram_base_phi2[0x6000+i].toString(16).padStart(2,"0"));
console.log(`  ${ramHex2.join(" ")}`);
console.log(`vmli=${v.vmli} vc=${v.vc} rc=${v.rc}`);
console.log(`vaddr_mask_phi2=$${v.vaddr_mask_phi2.toString(16)} vaddr_offset_phi2=$${v.vaddr_offset_phi2.toString(16)}`);

// Trace D011/D016/D018 writes during 1 frame to confirm split firing
console.log("\nMid-frame VIC write trace (1 PAL frame)...");
const LIT_MEM = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-mem.js`);
const writes = [];
let intercepting = false;
const wrap = (reg) => ({
  read: () => LIT_MEM.vicii_read(reg),
  write: (_a, val) => {
    if (intercepting) writes.push({ cyc: s.c64Cpu.cycles, raster: LIT_TYPES.vicii.raster_line, rcyc: LIT_TYPES.vicii.raster_cycle, pc: s.c64Cpu.pc, reg, val });
    LIT_MEM.vicii_store(reg, val);
    s.vic.write(reg, val);
  },
});
for (const reg of [0x11, 0x16, 0x18]) s.c64Bus.registerIoHandler(0xd000 + reg, wrap(reg));
intercepting = true;
s.runFor(20_000, { cycleBudget: 30_000 });
intercepting = false;
console.log(`writes: ${writes.length}`);
for (const w of writes.slice(0, 30)) {
  console.log(`  raster=${w.raster.toString().padStart(3)} rcyc=${w.rcyc.toString().padStart(2)} pc=$${w.pc.toString(16).padStart(4,"0")} D0${w.reg.toString(16).padStart(2,"0")}=$${w.val.toString(16).padStart(2,"0")}`);
}

stopIntegratedSession(sessionId);
