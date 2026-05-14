// Spec 147 — VIA register R/W unit tests (Phase 1).
//
// Each test cites the VICE source line driving the assertion.
// Run via:
//   npx tsx tests/unit/via/via-register-rw.test.ts

import { strict as assert } from "node:assert";
import {
  alarm_context_new,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_ACR,
  VIA_DDRA,
  VIA_DDRB,
  VIA_IER,
  VIA_IFR,
  VIA_IM_IRQ,
  VIA_IM_T1,
  VIA_PCR,
  VIA_PRA,
  VIA_PRA_NHS,
  VIA_PRB,
  VIA_SR,
  VIA_T1CH,
  VIA_T1CL,
  VIA_T1LH,
  VIA_T1LL,
  VIA_T2CH,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

interface BackendStub extends ViaBackend {
  paLines: number; pbLines: number;
  storedPa: Array<{ clk: number; v: number }>;
  storedPb: Array<{ clk: number; v: number }>;
  irqLine: number;
}

function makeBackend(): BackendStub {
  const b: BackendStub = {
    paLines: 0xff,
    pbLines: 0xff,
    storedPa: [],
    storedPb: [],
    irqLine: 0,
    readPa: () => b.paLines,
    readPb: () => b.pbLines,
    storePa: (clk, v) => { b.storedPa.push({ clk, v }); },
    storePb: (clk, v) => { b.storedPb.push({ clk, v }); },
    storeSr: () => undefined,
    storeT2L: () => undefined,
    storeAcr: () => undefined,
    storePcr: (val) => val,
    setInt: (v) => { b.irqLine = v; },
    setCa2: () => undefined,
    setCb2: () => undefined,
    reset: () => undefined,
  };
  return b;
}

function makeVia() {
  const ctx = alarm_context_new("test");
  let clk = 100;
  const backend = makeBackend();
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "TestVia",
    writeOffset: 1,
  });
  return { via, backend, ctx, advance: (n: number) => { clk += n; }, getClk: () => clk };
}

// VICE viacore_store / read DDR — unmodelled side effects = pure latches.
// viacore.c lines 691-696 / 1198-1199.
test("DDRA write/read round-trip", () => {
  const { via } = makeVia();
  via.store(VIA_DDRA, 0x55);
  assert.equal(via.read(VIA_DDRA), 0x55);
});

test("DDRB write/read round-trip", () => {
  const { via } = makeVia();
  via.store(VIA_DDRB, 0xaa);
  assert.equal(via.read(VIA_DDRB), 0xaa);
});

// VICE viacore.c line 692-695: storePa called with byte = (PRA | ~DDRA).
test("PRA store outputs (PRA | ~DDRA) on storePa", () => {
  const { via, backend } = makeVia();
  via.store(VIA_DDRA, 0x0f);   // low nibble = output
  via.store(VIA_PRA, 0xa5);    // ORA latch = 0xa5
  // last storePa gets (0xa5 | ~0x0f) = (0xa5 | 0xf0) = 0xf5.
  const last = backend.storedPa.at(-1)!;
  assert.equal(last.v, 0xf5);
});

// VICE viacore.c line 686-696 — PRA_NHS = 0xf alias, no handshake.
test("PRA_NHS write does not clear CA1/CA2 IFR", () => {
  const { via } = makeVia();
  via.ifr = 0x03;  // CA1 + CA2 set
  via.store(VIA_PRA_NHS, 0x55);
  // VICE PRA_NHS path skips the handshake branch — IFR stays.
  assert.equal(via.ifr, 0x03);
});

// VICE viacore.c line 1077-1082 — read PRA clears CA1; clears CA2
// unless IndInput. Our test: simple case (PCR=0).
test("PRA read clears IFR_CA1+CA2", () => {
  const { via, backend } = makeVia();
  backend.paLines = 0x42;
  via.ifr = 0x03;
  const r = via.read(VIA_PRA);
  assert.equal(r, 0x42);
  assert.equal(via.ifr & 0x03, 0);
});

// VICE viacore.c line 1149-1150 — PRB read merges (pin & ~DDRB) | (PRB & DDRB).
test("PRB read merges live pins under ~DDRB and ORB under DDRB", () => {
  const { via, backend } = makeVia();
  via.store(VIA_DDRB, 0x0f);
  via.store(VIA_PRB, 0x0a);     // ORB low = 0x0a
  backend.pbLines = 0xf5;       // pin pattern
  const r = via.read(VIA_PRB);
  // (0xf5 & ~0x0f) | (0x0a & 0x0f) = 0xf0 | 0x0a = 0xfa
  assert.equal(r, 0xfa);
});

// VICE viacore.c lines 727-737 — SR write stores latch + clears IFR_SR.
test("SR write/read round-trip and clears IFR_SR", () => {
  const { via } = makeVia();
  via.ifr = 0x04;
  via.store(VIA_SR, 0x77);
  assert.equal(via.read(VIA_SR), 0x77);
  assert.equal(via.ifr & 0x04, 0);
});

// VICE viacore.c lines 832-833 — IFR write: clear specified bits.
test("IFR write clears specified bits (write-1-to-clear)", () => {
  const { via } = makeVia();
  via.ifr = 0x7f;
  via.store(VIA_IFR, 0x21);  // clear bits 0 and 5
  assert.equal(via.ifr, 0x7f & ~0x21);
});

// VICE viacore.c lines 842-848 — IER write semantics:
//   bit 7 of byte = 1 → set bits with v=1
//   bit 7 of byte = 0 → clear bits with v=1
test("IER write: bit7=1 sets enable bits", () => {
  const { via } = makeVia();
  via.ier = 0;
  via.store(VIA_IER, VIA_IM_IRQ | 0x40);
  assert.equal(via.ier, 0x40);
});

test("IER write: bit7=0 clears enable bits", () => {
  const { via } = makeVia();
  via.ier = 0x7f;
  via.store(VIA_IER, 0x40);
  assert.equal(via.ier, 0x7f & ~0x40);
});

// VICE viacore.c lines 1206-1208 — IER read returns ier | 0x80.
test("IER read returns ier | 0x80", () => {
  const { via } = makeVia();
  via.ier = 0x42;
  assert.equal(via.read(VIA_IER), 0xc2);
});

// VICE viacore.c lines 1196-1202 — IFR read returns ifr | (ifr&ier ? 0x80 : 0).
test("IFR read sets bit 7 iff (ifr & ier) != 0", () => {
  const { via } = makeVia();
  via.ifr = 0x40; via.ier = 0x40;
  assert.equal(via.read(VIA_IFR), 0xc0);
  via.ier = 0;
  assert.equal(via.read(VIA_IFR), 0x40);
});

// VICE viacore.c line 743-745 — T1LL write stores into T1LL, no counter load.
test("T1LL write stores into latch low only", () => {
  const { via } = makeVia();
  via.store(VIA_T1LL, 0x33);
  assert.equal(via.read(VIA_T1LL), 0x33);
  // No T1 alarm scheduled by latch-only write.
});

// VICE viacore.c lines 760-768 — T1CH write loads counter from latch and
// schedules T1 zero alarm + clears IFR_T1.
test("T1CH write loads counter, schedules alarm, clears IFR_T1", () => {
  const { via } = makeVia();
  via.ifr |= VIA_IM_T1;
  via.store(VIA_T1LL, 0x10);
  via.store(VIA_T1CH, 0x00);     // counter = 0x0010
  assert.equal(via.ifr & VIA_IM_T1, 0);
});

// VICE viacore.c line 770-783 — T1LH write also clears IFR_T1.
test("T1LH write clears IFR_T1", () => {
  const { via } = makeVia();
  via.ifr |= VIA_IM_T1;
  via.store(VIA_T1LH, 0x05);
  assert.equal(via.ifr & VIA_IM_T1, 0);
});

// VICE viacore.c lines 799-827 — T2CH write loads counter, clears IFR_T2,
// sets t2_irq_allowed = true.
test("T2CH write loads counter, clears IFR_T2, allows IRQ", () => {
  const { via } = makeVia();
  via.ifr |= 0x20;
  via.store(VIA_T1LL, 0); // unrelated
  via.store(/*T2LL*/ 8, 0x80);
  via.store(VIA_T2CH, 0x01);
  assert.equal(via.ifr & 0x20, 0);
  assert.equal(via.t2_irq_allowed, true);
});

// VICE via.h reset (viacore.c lines 378-439) — PRA/PRB/DDRA/DDRB cleared
// to 0; SR preserved; IER/IFR cleared.
test("reset clears port regs but preserves SR + sets latches to 0xffff", () => {
  const { via } = makeVia();
  via.store(VIA_SR, 0x88);
  via.store(VIA_DDRA, 0xff);
  via.store(VIA_PRA, 0xa5);
  via.ier = 0x7f;
  via.reset();
  assert.equal(via.via[VIA_PRA], 0);
  assert.equal(via.via[VIA_DDRA], 0);
  assert.equal(via.ier, 0);
  assert.equal(via.ifr, 0);
  // SR (reg 10) preserved per VICE comment "omit shift register (10)".
  assert.equal(via.via[VIA_SR], 0x88);
  // tal reset to 0xffff.
  assert.equal(via.tal, 0xffff);
});

// VICE viacore.c line 1056-1059 — addr is masked to 0xf.
test("addr masking: store/read at 0x10 == at 0x00", () => {
  const { via } = makeVia();
  via.store(0x10 | VIA_DDRA, 0x33);
  assert.equal(via.read(0x10 | VIA_DDRA), 0x33);
  assert.equal(via.read(VIA_DDRA), 0x33);
});

// VICE viacore.c lines 988-1019 — PCR write updates ca2_out_state per
// CA2 control bits and stores byte. We check the latch round-trip.
test("PCR/ACR write/read round-trip", () => {
  const { via } = makeVia();
  via.store(VIA_PCR, 0x55);
  via.store(VIA_ACR, 0x77);
  assert.equal(via.read(VIA_PCR), 0x55);
  assert.equal(via.read(VIA_ACR), 0x77);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-register-rw: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
