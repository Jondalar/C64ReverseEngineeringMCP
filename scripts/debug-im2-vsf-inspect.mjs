// Load VICE VSF + inspect IM2 boot state.
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { loadViceVsf } from "../dist/runtime/headless/vsf/vice-vsf-load.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

session.resetCold("pal-default");
const result = loadViceVsf(session, resolve("samples/impossibleMission_boot.vsf"));
console.log("=== Loaded VICE state ===");
console.log(`CPU: PC=$${result.cpu.pc.toString(16)} A=$${result.cpu.a.toString(16)} X=$${result.cpu.x.toString(16)} Y=$${result.cpu.y.toString(16)} SP=$${result.cpu.sp.toString(16)} flags=$${result.cpu.status.toString(16)}`);
console.log(`clk=${result.cpu.clk}`);

const cia2 = session.cia2;
const vic = session.vic;
console.log(`\n=== CIA2 ===`);
console.log(`PRA=$${cia2.pra.toString(16)} DDRA=$${cia2.ddra.toString(16)}`);
const bank = (~cia2.pra) & 3;
console.log(`VIC bank=${bank} base=$${(bank*0x4000).toString(16).padStart(4,"0")}`);

console.log(`\n=== VIC registers ===`);
const D011 = vic.regs[0x11], D016 = vic.regs[0x16], D018 = vic.regs[0x18];
const D019 = vic.regs[0x19], D01A = vic.regs[0x1A], D012 = vic.regs[0x12];
console.log(`D011=$${D011.toString(16)} D012=$${D012.toString(16)} (raster compare)`);
console.log(`D016=$${D016.toString(16)} D018=$${D018.toString(16)}`);
console.log(`D019=$${D019.toString(16)} (IRQ status) D01A=$${D01A.toString(16)} (IRQ enable)`);
const ecm = (D011>>6)&1, bmm = (D011>>5)&1, den = (D011>>4)&1;
const mcm = (D016>>4)&1;
console.log(`mode = ${(ecm<<2)|(bmm<<1)|mcm} (ECM=${ecm} BMM=${bmm} MCM=${mcm} DEN=${den})`);
const scrBase = bank*0x4000 + ((D018&0xF0)>>4)*0x400;
const charBase = bank*0x4000 + ((D018&0x0E)>>1)*0x800;
const bmpBase = bank*0x4000 + ((D018&0x08)>>3)*0x2000;
console.log(`screen RAM base=$${scrBase.toString(16)} char/bitmap base=$${charBase.toString(16)} (text) / $${bmpBase.toString(16)} (BMM)`);

console.log(`\n=== RAM at screen base ===`);
const ram = session.c64Bus.ram;
for (let r = 0; r < 3; r++) {
  let s = "";
  for (let i = 0; i < 40; i++) s += ram[scrBase + r*40 + i].toString(16).padStart(2,"0") + " ";
  console.log(`  row ${r}: ${s}`);
}
console.log(`\n=== RAM at bitmap base ===`);
for (let r = 0; r < 2; r++) {
  let s = "";
  for (let i = 0; i < 32; i++) s += ram[bmpBase + r*40 + i].toString(16).padStart(2,"0") + " ";
  console.log(`  row ${r}: ${s}`);
}

// Color RAM
const cr = new Uint8Array(session.c64Bus.io.buffer, session.c64Bus.io.byteOffset + 0x0800, 0x400);
console.log(`\n=== Color RAM ===`);
for (let r = 0; r < 3; r++) {
  let s = "";
  for (let i = 0; i < 40; i++) s += (cr[r*40 + i]&0xf).toString(16);
  console.log(`  row ${r}: ${s}`);
}

// Disassemble around PC + look for raster IRQ vector at $FFFE
const pc = result.cpu.pc;
console.log(`\n=== Code around PC=$${pc.toString(16)} ===`);
for (let i = 0; i < 16; i++) console.log(`  $${(pc+i).toString(16).padStart(4,"0")}: $${ram[(pc+i)&0xffff].toString(16).padStart(2,"0")}`);

// IRQ vector
const irqLo = ram[0xFFFE], irqHi = ram[0xFFFF];
const irqVec = (irqHi<<8)|irqLo;
console.log(`\n=== IRQ vector ($FFFE/F) ===`);
console.log(`$FFFE=$${irqLo.toString(16)} $FFFF=$${irqHi.toString(16)} → vector $${irqVec.toString(16)}`);
console.log(`Code at IRQ vector:`);
for (let i = 0; i < 24; i++) console.log(`  $${(irqVec+i).toString(16).padStart(4,"0")}: $${ram[(irqVec+i)&0xffff].toString(16).padStart(2,"0")}`);

process.exit(0);
