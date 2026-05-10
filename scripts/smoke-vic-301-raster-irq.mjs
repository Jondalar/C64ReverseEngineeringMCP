#!/usr/bin/env node
// Spec 301 synthetic raster IRQ test.
//
// Poke regs[0x1a] = 0x01 (enable raster IRQ source bit) + regs[0x12] = 0x80
// (compare line $80) via direct register write. Run a few frames. Sample
// per-cycle: track when literal sets irq_status bit 0 + when VicIIVice
// sets it. Report:
//  - did literal trigger? at what raster?
//  - did VicIIVice trigger? at what raster?
//  - cycle delta between the two
// Then write $D019 = 0x01 (ack) via bus → assert both irq_status bit 0 clears.

import { writeFileSync, mkdirSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
});

s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Enable raster IRQ via bus write so BOTH chips see it.
// $D012 = 0x80, $D011 high-bit = 0 (already), $D01A = 0x01.
s.c64Bus.write(0xd011, s.c64Bus.read(0xd011) & 0x7f);
s.c64Bus.write(0xd012, 0x80);
s.c64Bus.write(0xd01a, 0x01);

// Clear any pending IRQ (write $D019 = $0f).
s.c64Bus.write(0xd019, 0x0f);

console.log(`Pre-trigger: vice.irq_status=$${(s.vic.irq_status & 0xff).toString(16)} lit.irq_status=$${(LIT_TYPES.vicii.irq_status & 0xff).toString(16)} regs[1a]=$${s.vic.regs[0x1a].toString(16)} regs[12]=$${s.vic.regs[0x12].toString(16)}`);

// Run ~2 frames in small slices, sample each slice
const SLICE_INSTR = 200;
const SLICE_CYC = 800;
const slices = 200;
let firstViceTrigger = -1;
let firstLitTrigger = -1;
let firstViceRaster = -1;
let firstLitRaster = -1;

for (let i = 0; i < slices; i++) {
  s.runFor(SLICE_INSTR, { cycleBudget: SLICE_CYC });
  const viceBit = s.vic.irq_status & 0x01;
  const litBit = LIT_TYPES.vicii.irq_status & 0x01;
  if (viceBit && firstViceTrigger < 0) {
    firstViceTrigger = s.c64Cpu.cycles;
    firstViceRaster = s.vic.raster_y;
  }
  if (litBit && firstLitTrigger < 0) {
    firstLitTrigger = s.c64Cpu.cycles;
    firstLitRaster = LIT_TYPES.vicii.raster_line;
  }
  if (firstViceTrigger >= 0 && firstLitTrigger >= 0) break;
}

console.log(`Vice: triggered=${firstViceTrigger >= 0} cycle=${firstViceTrigger} raster=${firstViceRaster}`);
console.log(`Lit:  triggered=${firstLitTrigger >= 0} cycle=${firstLitTrigger} raster=${firstLitRaster}`);

// Now ack via bus write.
s.c64Bus.write(0xd019, 0x01);
const viceBitAfterAck = s.vic.irq_status & 0x01;
const litBitAfterAck = LIT_TYPES.vicii.irq_status & 0x01;
console.log(`Post-ack: vice.bit0=${viceBitAfterAck} lit.bit0=${litBitAfterAck}`);

stopIntegratedSession(sessionId);

const out = {
  vice: { triggered: firstViceTrigger >= 0, cycle: firstViceTrigger, raster: firstViceRaster, postAck: viceBitAfterAck },
  lit:  { triggered: firstLitTrigger >= 0, cycle: firstLitTrigger, raster: firstLitRaster, postAck: litBitAfterAck },
};
mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(`${REPO}/samples/screenshots/literal-port/spec-301-raster-irq.json`, JSON.stringify(out, null, 2));

// Acceptance: literal becomes IRQ authority (Spec 301). VicIIVice IRQ
// timing precision is out of scope — only check literal accuracy +
// both-triggered + both-acked.
const checks = [
  { name: "vice triggered",  ok: out.vice.triggered },
  { name: "lit triggered",   ok: out.lit.triggered },
  { name: "vice ack cleared", ok: out.vice.postAck === 0 },
  { name: "lit ack cleared",  ok: out.lit.postAck === 0 },
  { name: "lit trigger raster within 16 of $80=128 (sample window)", ok: Math.abs(out.lit.raster - 0x80) <= 16 },
];
console.log(`(VicIIVice triggered at raster=${out.vice.raster}; informational, not gated — VicIIVice IRQ being deprecated per migration plan)`);
let allOk = true;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}: ${c.name}`);
  if (!c.ok) allOk = false;
}
process.exit(allOk ? 0 : 1);
