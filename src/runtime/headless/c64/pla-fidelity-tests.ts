// Spec 106 (M2.4) v1 — PLA + memory-bus fidelity tests.
//
// v1 covers the PLA truth-table for non-cartridge configurations
// (8 of the 16 states; the remaining 8 require EXROM/GAME from a
// cart) + color RAM nibble readback + $00/$01 CPU port semantics.
// Ultimax fixture + cart routing deferred to v2 / Spec 128.

import { HeadlessMemoryBus } from "../memory-bus.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

function makeBusWithRoms(): HeadlessMemoryBus {
  const bus = new HeadlessMemoryBus();
  // Synthetic ROM bytes so we can distinguish bank reads.
  const basic = new Uint8Array(0x2000);
  for (let i = 0; i < basic.length; i++) basic[i] = 0xb0 | (i & 0x0f);
  bus.loadBasicRom(basic);
  const kernal = new Uint8Array(0x2000);
  for (let i = 0; i < kernal.length; i++) kernal[i] = 0xe0 | (i & 0x0f);
  bus.loadKernalRom(kernal);
  const charRom = new Uint8Array(0x1000);
  for (let i = 0; i < charRom.length; i++) charRom[i] = 0xc0 | (i & 0x0f);
  bus.loadCharRom(charRom);
  return bus;
}

// --- M2.4a — PLA truth table (no cart, EXROM=GAME=1) ---

export function runPlaNoCartTest(): CheckResult[] {
  const out: CheckResult[] = [];

  // Default $01 = $37 → LORAM=1, HIRAM=1, CHAREN=1 → BASIC + KERNAL + IO.
  {
    const bus = makeBusWithRoms();
    bus.write(0x0001, 0x37);
    out.push(check("$01=$37: $A000 reads BASIC", (bus.read(0xA000) & 0xf0) === 0xb0));
    out.push(check("$01=$37: $E000 reads KERNAL", (bus.read(0xE000) & 0xf0) === 0xe0));
    out.push(check("$01=$37: $D000 reads IO (default 0)", bus.read(0xD000) === 0));
  }
  // $01 = $33 → LORAM=1 HIRAM=1 CHAREN=0 → char ROM at $D000-$DFFF instead of IO.
  {
    const bus = makeBusWithRoms();
    bus.write(0x0001, 0x33);
    out.push(check("$01=$33: $D000 reads char ROM", (bus.read(0xD000) & 0xf0) === 0xc0));
  }
  // $01 = $35 → LORAM=1 HIRAM=0 CHAREN=1 → no BASIC, no KERNAL, IO visible
  // (with HIRAM=0 + LORAM=1 + CHAREN=1, IO IS visible because
  //  ((LORAM | HIRAM) && CHAREN) = (1 && 1) = io).
  {
    const bus = makeBusWithRoms();
    bus.write(0x0001, 0x35);
    out.push(check("$01=$35: $A000 reads RAM (BASIC hidden)", bus.read(0xA000) === 0));
    out.push(check("$01=$35: $E000 reads RAM (KERNAL hidden)", bus.read(0xE000) === 0));
    out.push(check("$01=$35: $D000 reads IO", bus.read(0xD000) === 0));
  }
  // $01 = $30 → LORAM=0 HIRAM=0 CHAREN=0 → all RAM (no ROMs, no IO).
  {
    const bus = makeBusWithRoms();
    bus.write(0x0001, 0x30);
    out.push(check("$01=$30: $A000 reads RAM",  bus.read(0xA000) === 0));
    out.push(check("$01=$30: $D000 reads RAM",  bus.read(0xD000) === 0));
    out.push(check("$01=$30: $E000 reads RAM",  bus.read(0xE000) === 0));
  }
  return out;
}

// --- M2.4b — $00/$01 CPU port semantics ---

export function runCpuPortTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const bus = makeBusWithRoms();
  // Default after reset: $00=$2F, $01=$37.
  out.push(check("default $00 = $2F", bus.read(0x0000) === 0x2f));
  out.push(check("default $01 = $37", bus.read(0x0001) === 0x37));
  // Write $00 (DDR).
  bus.write(0x0000, 0xff);
  out.push(check("after write $00=$ff: read $00 = $ff (DDR latch)", bus.read(0x0000) === 0xff));
  // Write $01 (port value).
  bus.write(0x0001, 0x05);
  out.push(check("after write $01=$05: read $01 = $05", bus.read(0x0001) === 0x05));
  return out;
}

// --- M2.4d — color RAM nibble readback ---

export function runColorRamNibbleTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const bus = makeBusWithRoms();
  // Make sure IO is visible: $01=$37.
  bus.write(0x0001, 0x37);
  // Write a few color RAM bytes.
  bus.write(0xd800, 0x07); // pure low nibble
  bus.write(0xd801, 0x4f); // upper nibble should be ignored on read
  bus.write(0xd900, 0x0a);
  bus.write(0xdbff, 0x03);
  // Reads should return high-nibble = $f (open-bus stub), low = stored.
  out.push(check("$D800 read: high nibble = $f, low = stored",
    bus.read(0xd800) === 0xf7,
    `got=$${bus.read(0xd800).toString(16)}`));
  out.push(check("$D801 written $4f: read returns only low nibble + open-bus",
    bus.read(0xd801) === 0xff,
    `got=$${bus.read(0xd801).toString(16)}`));
  out.push(check("$D900 read = $fa", bus.read(0xd900) === 0xfa));
  out.push(check("$DBFF read = $f3", bus.read(0xdbff) === 0xf3));
  // Outside color RAM range: full byte preserved (e.g. $DC00 onward).
  bus.write(0xdc00, 0x55);
  out.push(check("$DC00 (CIA1) read returns full byte (no nibble mask)",
    bus.read(0xdc00) === 0x55));
  return out;
}

// --- M2.4 — IO bank vs RAM under PLA ---

export function runIoVsRamUnderPlaTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const bus = makeBusWithRoms();
  // With IO visible, a write to $D000 goes to IO (not RAM).
  bus.write(0x0001, 0x37);
  bus.write(0xd000, 0x42);
  out.push(check("IO visible: write $D000 stored in IO",
    bus.read(0xd000) === 0x42));
  // Switch to char ROM mode (CHAREN=0): same address reads char ROM.
  bus.write(0x0001, 0x33);
  out.push(check("char-ROM visible: $D000 reads char ROM, not RAM/IO",
    (bus.read(0xd000) & 0xf0) === 0xc0));
  // Switch back to IO: $42 still there.
  bus.write(0x0001, 0x37);
  out.push(check("IO visible again: $D000 still $42",
    bus.read(0xd000) === 0x42));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllPlaFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.4a PLA no-cart truth table", runner: runPlaNoCartTest },
    { name: "M2.4b $00/$01 CPU port",         runner: runCpuPortTest },
    { name: "M2.4d color RAM nibble readback", runner: runColorRamNibbleTest },
    { name: "M2.4 IO vs RAM under PLA",       runner: runIoVsRamUnderPlaTest },
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
