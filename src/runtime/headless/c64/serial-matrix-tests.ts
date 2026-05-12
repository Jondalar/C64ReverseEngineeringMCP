// Spec 111 (M3.3) — KERNAL serial byte matrix tests.
//
// Tests the CBM IEC bit-bang protocol contract end-to-end at the
// PROTOCOL state level (no real KERNAL ROM execution, no real drive
// CPU): a synthetic host emits the LISTEN/TALK/SECOND/CIOUT/ACPTR/
// EOI/UNLISTEN/UNTALK frames per CBM convention, and a
// SyntheticIecDevice observes + responds. The harness asserts the
// post-state of both sides.
//
// Future work (M3.3 v2): drive these scenarios through the real
// KERNAL ROM by rebooting an IntegratedSession with the synth swapped
// in for the real drive — currently blocked by IntegratedSession's
// hard-wired DriveCpu plumbing. The protocol-level contract here
// remains valid as a bus-truth oracle for the v2 KERNAL-mode tests.

import { IecBus, CIA2_PA_ATN_OUT, CIA2_PA_CLK_OUT, CIA2_PA_DATA_OUT } from "../iec/iec-bus.js";
import { SyntheticIecDevice, type BusObservation } from "../test-helpers/synthetic-iec-device.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }

function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- Host bit-bang harness -----------------------------------------

interface HostState {
  atnLow: boolean;
  clkLow: boolean;
  dataLow: boolean;
}

function hostMask(s: HostState): { value: number; ddr: number } {
  let v = 0;
  if (s.atnLow)  v |= CIA2_PA_ATN_OUT;
  if (s.clkLow)  v |= CIA2_PA_CLK_OUT;
  if (s.dataLow) v |= CIA2_PA_DATA_OUT;
  // DDR = output for all three.
  return { value: v, ddr: CIA2_PA_ATN_OUT | CIA2_PA_CLK_OUT | CIA2_PA_DATA_OUT };
}

class ProtocolHarness {
  bus = new IecBus();
  device: SyntheticIecDevice;
  hostS: HostState = { atnLow: false, clkLow: false, dataLow: false };
  // Synth's drive memo (so we can apply it on every settle).
  private synthClkPull = false;
  private synthDataPull = false;
  // Tap to install drive output via internal IecBus knobs without a
  // real Via6522: set drive*Released directly.
  constructor(device: SyntheticIecDevice) {
    this.device = device;
  }

  private settleSynth(): void {
    // Re-apply current synth drive desire to bus drive-side state.
    // We use IecBus.setDriveOutput's bit semantics: bit=1 + ddr=1 → pull.
    // Build a fake VIA1 PB output: PB1=DATA, PB3=CLK.
    let pb = 0;
    let ddr = 0;
    if (this.synthClkPull) { pb |= 1 << 3; ddr |= 1 << 3; }
    if (this.synthDataPull){ pb |= 1 << 1; ddr |= 1 << 1; }
    // Always include ATN_ACK as released (no auto-pull) so synth's
    // DATA pull is what controls listener ack.
    ddr |= 1 << 4;
    pb  |= 1 << 4; // ATN_ACK released (PB4=1 → !ack-active)
    this.bus.setDriveOutput(pb, ddr);
  }

  applyHost(): void {
    const m = hostMask(this.hostS);
    this.bus.setC64Output(m.value, m.ddr);
  }

  observation(): BusObservation {
    return {
      atnLow:  !this.bus.atnLine,
      clkLow:  !this.bus.clkLine,
      dataLow: !this.bus.dataLine,
      hostClkReleased: !this.hostS.clkLow,
      hostDataReleased: !this.hostS.dataLow,
    };
  }

  // Step: apply host state, let synth observe, apply synth pulls,
  // re-apply host (so wired-AND settles), let synth re-observe.
  step(): void {
    this.applyHost();
    const drv = this.device.observe(this.observation());
    this.synthClkPull  = drv.pullClk;
    this.synthDataPull = drv.pullData;
    this.settleSynth();
    // Second observation pass so synth sees its own contributions and
    // the wired-AND result.
    this.device.observe(this.observation());
  }

  // High-level helpers.
  pullAtn(): void { this.hostS.atnLow = true;  this.step(); }
  releaseAtn(): void { this.hostS.atnLow = false; this.step(); }
  pullClk(): void { this.hostS.clkLow = true;  this.step(); }
  releaseClk(): void { this.hostS.clkLow = false; this.step(); }

  // Send one frame byte (8 bits, LSB first per CBM). Each bit:
  //   1. Host releases CLK.
  //   2. Host sets DATA per bit: bit=1 → pull DATA; bit=0 → release.
  //   3. Host pulls CLK low (signals "bit valid"); listener samples on
  //      this falling edge.
  //   4. Repeat.
  // Final: host releases CLK + DATA so listener can pull DATA for ack.
  sendFrameByte(byte: number): void {
    for (let i = 0; i < 8; i++) {
      const bit = (byte >> i) & 1;
      // Host releases CLK first (allows listener to track bit boundary).
      this.hostS.clkLow = false;
      this.hostS.dataLow = bit === 1; // CBM: bit=1 means DATA pulled
      this.step();
      // Host pulls CLK to clock the bit.
      this.hostS.clkLow = true;
      this.step();
    }
    // Release after final bit so listener can ack.
    this.hostS.dataLow = false;
    this.step();
  }
}

// --- M3.3 fixtures --------------------------------------------------

// F1: LISTEN device 8 — synth (id=8) acks frame, ends as listener.
export function fixtureListenDevice8(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8 });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  out.push(check("post-ATN: synth pulls DATA (presence ack)", dev.getDrive().pullData === true));
  h.sendFrameByte(0x28); // LISTEN $20 + dev 8
  out.push(check("synth role = listener after LISTEN $28",  dev.state.role === "listener"));
  out.push(check("synth selectedDevice = 8",                 dev.state.selectedDevice === 8));
  out.push(check("framesAcked === 1",                        dev.state.framesAcked === 1));

  return out;
}

// F2: LISTEN to device 9 when synth is device 8 — synth ignores.
export function fixtureListenWrongDevice(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8 });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  // Note: real protocol — ALL devices pull DATA on ATN edge regardless
  // of address. Only after ATN command frame do non-addressed devices
  // release DATA.
  out.push(check("post-ATN: all devices pull DATA", dev.getDrive().pullData === true));
  h.sendFrameByte(0x29); // LISTEN device 9
  out.push(check("synth role idle (not addressed)",       dev.state.role === "idle"));
  out.push(check("synth releases DATA after non-match",   dev.getDrive().pullData === false));
  out.push(check("selectedDevice undefined",              dev.state.selectedDevice === undefined));

  return out;
}

// F3: TALK device 8 — synth becomes talker.
export function fixtureTalkDevice8(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8, ackBytes: [0x41, 0x42, 0x43] });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  h.sendFrameByte(0x48); // TALK $40 + dev 8
  out.push(check("synth role = talker", dev.state.role === "talker"));
  out.push(check("framesAcked === 1",   dev.state.framesAcked === 1));

  return out;
}

// F4: LISTEN + SECOND $61 + CIOUT data byte.
export function fixtureListenSecondDataByte(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8 });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  h.sendFrameByte(0x28); // LISTEN 8
  h.sendFrameByte(0x61); // SECOND $01 (open channel 1)
  h.releaseAtn();
  // CIOUT data byte.
  h.sendFrameByte(0x55);
  h.sendFrameByte(0xaa);
  // UNLISTEN.
  h.pullAtn();
  h.sendFrameByte(0x3f);
  h.releaseAtn();

  out.push(check("synth received [$55,$aa]",
    dev.state.bytesReceived.length === 2 && dev.state.bytesReceived[0] === 0x55 && dev.state.bytesReceived[1] === 0xaa,
    `got ${dev.state.bytesReceived.map((b) => "$" + b.toString(16)).join(",")}`));
  out.push(check("after UNLISTEN: role idle",         dev.state.role === "idle"));
  out.push(check("framesAcked === 3 (LISTEN+SECOND+UNLSN)", dev.state.framesAcked === 3));

  return out;
}

// F5: device-not-present — disabled synth, no DATA pull observed.
export function fixtureDeviceNotPresent(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8, enabled: false });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  out.push(check("disabled synth never pulls DATA",       dev.getDrive().pullData === false));
  h.sendFrameByte(0x28);
  out.push(check("synth role still idle",                  dev.state.role === "idle"));
  out.push(check("framesAcked === 0",                      dev.state.framesAcked === 0));
  // From host's POV: bus DATA stayed released throughout (after host
  // released DATA at end of frame), modulo host's own pull during bit
  // setup. Final state at end: dataLine == true (released).
  out.push(check("bus DATA released at frame end",         h.bus.dataLine === true));

  return out;
}

// F6: UNTALK from talker — release talker role.
export function fixtureUntalkReleasesTalker(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8, ackBytes: [0x42] });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  h.sendFrameByte(0x48); // TALK 8
  h.sendFrameByte(0x60); // TKSA 0
  h.releaseAtn();
  // ... talker would send byte here ...
  // UNTALK
  h.pullAtn();
  h.sendFrameByte(0x5f);
  h.releaseAtn();

  out.push(check("after UNTALK: role idle",   dev.state.role === "idle"));
  out.push(check("framesAcked === 3",         dev.state.framesAcked === 3));

  return out;
}

// F7: TALK followed by UNLSN should NOT release talker (UNLSN only
// affects listeners). Pin current synth model.
export function fixtureUnlsnDoesNotReleaseTalker(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8 });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];

  h.pullAtn();
  h.sendFrameByte(0x48); // TALK 8
  out.push(check("after TALK: role talker", dev.state.role === "talker"));
  // Issue UNLSN (should not affect talker per CBM spec).
  h.sendFrameByte(0x3f);
  // Current synth treats UNLSN as universal "release" — pin behavior.
  out.push(check("synth deviation: UNLSN releases talker too (v1 simplification)",
    dev.state.role === "idle"));

  return out;
}

// F8: LISTEN $28 LSB-first transmission verification — LISTEN $28 =
// %0010_1000 → bits LSB-first: 0,0,0,1,0,1,0,0.
export function fixtureLsbFirstByteOrder(): CheckResult[] {
  const dev = new SyntheticIecDevice({ deviceId: 8 });
  const h = new ProtocolHarness(dev);
  const out: CheckResult[] = [];
  h.pullAtn();
  h.sendFrameByte(0x28);
  // If LSB ordering correct, synth recognizes $28 = LISTEN dev 8.
  out.push(check("LSB-first frame parsed correctly", dev.state.role === "listener"));
  return out;
}

// --- aggregate ------------------------------------------------------

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllSerialMatrixTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "F1 LISTEN dev8 (ack)",        runner: fixtureListenDevice8 },
    { name: "F2 LISTEN wrong device",       runner: fixtureListenWrongDevice },
    { name: "F3 TALK dev8 (ack)",           runner: fixtureTalkDevice8 },
    { name: "F4 LISTEN+SECOND+CIOUT+UNLSN", runner: fixtureListenSecondDataByte },
    { name: "F5 device-not-present",        runner: fixtureDeviceNotPresent },
    { name: "F6 UNTALK releases talker",    runner: fixtureUntalkReleasesTalker },
    { name: "F7 UNLSN-vs-talker (v1 dev)",  runner: fixtureUnlsnDoesNotReleaseTalker },
    { name: "F8 LSB-first byte order",      runner: fixtureLsbFirstByteOrder },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
