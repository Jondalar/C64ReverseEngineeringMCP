#!/usr/bin/env node
// Spec V1/V2/V3 — Scramble VSF inject + render + pixel diff vs VICE PNGs.
// For each stage A/B/C: inject VICE VSF state into headless session,
// render via literal port, decode VICE reference PNG, compute pixel
// match %.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const REF = `${REPO}/samples/vice-reference/scramble`;
const OUT = `${REPO}/samples/screenshots/vic-bugs/scramble-diff`;
mkdirSync(OUT, { recursive: true });

const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

// VSF parser (verified working w/ motm earlier)
function parseVsf(path) {
  const buf = readFileSync(path);
  const findModule = (name) => {
    for (let i = 0x3a; i + 16 <= buf.length; i++) {
      let m = true;
      for (let k = 0; k < name.length; k++) if (buf[i+k] !== name.charCodeAt(k)) { m = false; break; }
      if (m && buf[i + name.length] === 0) return { offset: i, dataStart: i + 22, size: buf.readUInt32LE(i + 18) };
    }
    return null;
  };
  return { buf, findModule };
}
function injectVsf(s, vsfPath) {
  const { buf, findModule } = parseVsf(vsfPath);
  const cpuMod = findModule("MAINCPU");
  const memMod = findModule("C64MEM");
  const vicMod = findModule("VIC-II");
  const cia1Mod = findModule("CIA1");
  const cia2Mod = findModule("CIA2");
  if (!cpuMod || !memMod || !vicMod) throw new Error(`VSF missing modules: ${vsfPath}`);

  // RAM 64K
  const ramOff = memMod.dataStart + 4;
  for (let i = 0; i < 0x10000; i++) s.c64Bus.write(i, buf[ramOff + i]);
  // VIC regs (64 bytes)
  const vicRegs = buf.subarray(vicMod.dataStart + 1, vicMod.dataStart + 1 + 64);
  for (let i = 0; i < 64; i++) {
    s.vic.regs[i] = vicRegs[i];
    LIT_TYPES.vicii.regs[i] = vicRegs[i];
  }
  // CIA1/CIA2 PA + DDRA + PB + DDRB
  if (cia1Mod) {
    s.cia1.pra = buf[cia1Mod.dataStart + 0]; s.cia1.prb = buf[cia1Mod.dataStart + 1];
    s.cia1.ddra = buf[cia1Mod.dataStart + 2]; s.cia1.ddrb = buf[cia1Mod.dataStart + 3];
  }
  if (cia2Mod) {
    s.cia2.pra = buf[cia2Mod.dataStart + 0]; s.cia2.prb = buf[cia2Mod.dataStart + 1];
    s.cia2.ddra = buf[cia2Mod.dataStart + 2]; s.cia2.ddrb = buf[cia2Mod.dataStart + 3];
  }
  // CPU
  const cpu = cpuMod.dataStart;
  s.c64Cpu.a = buf[cpu+8]; s.c64Cpu.x = buf[cpu+9]; s.c64Cpu.y = buf[cpu+10];
  s.c64Cpu.sp = buf[cpu+11]; s.c64Cpu.pc = buf.readUInt16LE(cpu+12); s.c64Cpu.p = buf[cpu+14];
  return { vicRegs };
}

// PNG decoder (RGBA + RGB)
function decodePng(buf) {
  let p = 8;
  let width = 0, height = 0, bpp = 4;
  const idats = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const ct = data[9]; bpp = (ct === 6) ? 4 : (ct === 2 ? 3 : 4);
    } else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let prev = Buffer.alloc(stride), ip = 0, op = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[ip++];
    const row = Buffer.from(raw.subarray(ip, ip+stride)); ip += stride;
    if (f === 1) for (let x = bpp; x < stride; x++) row[x] = (row[x] + row[x-bpp]) & 0xff;
    else if (f === 2) for (let x = 0; x < stride; x++) row[x] = (row[x] + prev[x]) & 0xff;
    else if (f === 3) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x-bpp] : 0;
      row[x] = (row[x] + ((a + prev[x]) >> 1)) & 0xff;
    } else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x-bpp] : 0, b = prev[x], c = x >= bpp ? prev[x-bpp] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp-a), pb = Math.abs(pp-b), pc = Math.abs(pp-c);
      let pr; if (pa <= pb && pa <= pc) pr = a; else if (pb <= pc) pr = b; else pr = c;
      row[x] = (row[x] + pr) & 0xff;
    }
    row.copy(out, op); op += stride; prev = row;
  }
  return { width, height, bpp, pixels: out };
}

const stages = [
  { name: "A-loader", vsf: "stage-A-Loader.vsf", png: "stage-A-Loader-screenshot.png" },
  { name: "B-title",  vsf: "stage-B-title.vsf",  png: "stage-B-title-screenshot.png" },
  { name: "C-ingame", vsf: "stage-C-ingame.vsf", png: "stage-C-ingame-screenshot.png" },
];

for (const stage of stages) {
  console.log(`\n=== Stage ${stage.name} ===`);
  const { sessionId, session: s } = startIntegratedSession({
    diskPath: resolve(`${REPO}/samples/scramble_infinity.d64`),
    mode: "true-drive",
    useMicrocodedCpu: true,
  });
  s.resetCold("pal-default");
  console.log(`Injecting VSF: ${stage.vsf}`);
  const { vicRegs } = injectVsf(s, `${REF}/${stage.vsf}`);
  console.log(`  VIC regs after inject: D011=$${vicRegs[0x11].toString(16)} D012=$${vicRegs[0x12].toString(16)} D015=$${vicRegs[0x15].toString(16)} D016=$${vicRegs[0x16].toString(16)} D018=$${vicRegs[0x18].toString(16)} D01A=$${vicRegs[0x1a].toString(16)}`);
  console.log(`  CIA2 PA=$${(s.cia2.pra & 0xff).toString(16)} bank=${(~(s.cia2.pra & s.cia2.ddra)) & 3}`);
  console.log(`  CPU PC=$${s.c64Cpu.pc.toString(16)}`);

  // CPU PC inject is buggy → CPU would corrupt RAM. Skip CPU entirely.
  // Tick VIC directly for 2 PAL frames (= literal port hook drives
  // tickLitVic per cycle, fills literalPortFb from STATIC injected state).
  // Bootstrap CPU: read IRQ vector from injected RAM @ $0314/$0315.
  // Set PC there + run a few frames so game's IRQ handler establishes
  // VIC state. Game RAM stays mostly intact since handler is short.
  const irqVecLo = s.c64Bus.read(0x0314);
  const irqVecHi = s.c64Bus.read(0x0315);
  const irqVec = (irqVecHi << 8) | irqVecLo;
  console.log(`  IRQ vector $0314/15 = $${irqVec.toString(16)}`);
  // Force CPU to run game's IRQ handler in a loop: set PC = irqVec.
  s.c64Cpu.pc = irqVec;
  // Set CPU port $01 to known good (= match VSF: $35 = BASIC out, KERNAL out)
  s.c64Bus.write(0x01, 0x37); // standard
  console.log(`Running 5 frames CPU + VIC...`);
  for (let f = 0; f < 5; f++) {
    s.runFor(50_000, { cycleBudget: 50_000 });
  }
  let fbNonZero = 0;
  if (s.literalPortFb) {
    for (let i = 0; i < s.literalPortFb.length; i++) if (s.literalPortFb[i] !== 0) fbNonZero++;
  }
  console.log(`  literalPortFb nonzero=${fbNonZero}/${s.literalPortFb?.length ?? 0}  PC=$${s.c64Cpu.pc.toString(16)}  D011=$${s.vic.regs[0x11].toString(16)} D018=$${s.vic.regs[0x18].toString(16)}`);

  const ourPath = `${OUT}/${stage.name}-ours.png`;
  s.renderToPng(ourPath);
  console.log(`  ours -> ${ourPath}`);

  // Diff vs VICE PNG
  const vice = decodePng(readFileSync(`${REF}/${stage.png}`));
  const ours = decodePng(readFileSync(ourPath));
  console.log(`  vice ${vice.width}x${vice.height} bpp=${vice.bpp}`);
  console.log(`  ours ${ours.width}x${ours.height} bpp=${ours.bpp}`);

  if (vice.width !== ours.width || vice.height !== ours.height) {
    console.log(`  DIM MISMATCH — skip pixel diff`);
  } else {
    let exact = 0, differ = 0;
    const rowDiffs = new Int32Array(vice.height);
    for (let y = 0; y < vice.height; y++) {
      for (let x = 0; x < vice.width; x++) {
        const off = (y * vice.width + x) * 4;
        const sameRGB = vice.pixels[off] === ours.pixels[off]
                     && vice.pixels[off+1] === ours.pixels[off+1]
                     && vice.pixels[off+2] === ours.pixels[off+2];
        if (sameRGB) exact++; else { differ++; rowDiffs[y]++; }
      }
    }
    const total = vice.width * vice.height;
    console.log(`  exact=${exact}/${total} (${(exact*100/total).toFixed(2)}%)  differ=${differ}`);
    // Top 10 worst rows
    const sorted = [];
    for (let y = 0; y < vice.height; y++) sorted.push({ y, n: rowDiffs[y] });
    sorted.sort((a,b) => b.n - a.n);
    console.log(`  worst rows: ${sorted.slice(0, 8).map(r => `r${r.y}=${r.n}`).join(" ")}`);
    writeFileSync(`${OUT}/${stage.name}-diff.json`, JSON.stringify({
      stage: stage.name, total, exact, differ, matchPct: parseFloat((exact*100/total).toFixed(2)),
      worstRows: sorted.slice(0, 30),
    }, null, 2));
  }

  stopIntegratedSession(sessionId);
}
console.log(`\nDONE. Outputs in ${OUT}/`);
