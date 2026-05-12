// Sprint 108 (Specs 127-129) v1 — cart fidelity tests.
//
// Existing cartridge.ts ships 8K/16K/Ocean/MagicDesk/EasyFlash/
// Megabyter/Ultimax/GMOD2/3/C64MegaCart mappers. v1 covers PLA
// truth table for cart-active states (extending Spec 106) plus
// mapper bank-switch via $DE00 + status descriptor.

import { HeadlessMemoryBus } from "../memory-bus.js";
import type { HeadlessCartridgeMapper } from "../cartridge.js";
import type { HeadlessBankInfo, HeadlessCartridgeState } from "../types.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// Minimal stub cart that pretends to be 8K, drives EXROM=0 GAME=1.
class StubCart8k implements HeadlessCartridgeMapper {
  public readBytesAt8000 = 0xaa;
  public bank = 0;
  getMapperType() { return "normal_8k" as const; }
  getLines() { return { exrom: 0, game: 1 }; }
  getState(): HeadlessCartridgeState {
    return {
      path: "stub",
      name: "stub",
      mapperType: "normal_8k",
      currentBank: this.bank,
      exrom: 0,
      game: 1,
      romlBanks: [0],
      romhBanks: [],
      writable: false,
    };
  }
  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0x8000 && address <= 0x9fff) return this.readBytesAt8000;
    return undefined;
  }
  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address === 0xde00) { this.bank = value & 0x3f; return true; }
    return false;
  }
}

// 16k cart (EXROM=0 GAME=0) → bank8 = cart_lo, bankA = cart_hi.
class StubCart16k implements HeadlessCartridgeMapper {
  public byte = 0xbb;
  getMapperType() { return "normal_16k" as const; }
  getLines() { return { exrom: 0, game: 0 }; }
  getState(): HeadlessCartridgeState {
    return {
      path: "stub", name: "stub16k", mapperType: "normal_16k",
      currentBank: 0, exrom: 0, game: 0,
      romlBanks: [0], romhBanks: [0], writable: false,
    };
  }
  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0x8000 && address <= 0xbfff) return this.byte;
    return undefined;
  }
  write(): boolean { return false; }
}

// Ultimax cart (EXROM=1 GAME=0) → bank8 = cart_lo, bankE = cart_hi_ultimax.
class StubCartUltimax implements HeadlessCartridgeMapper {
  public byteRoml = 0xcc;
  public byteRomh = 0xdd;
  getMapperType() { return "ultimax" as const; }
  getLines() { return { exrom: 1, game: 0 }; }
  getState(): HeadlessCartridgeState {
    return {
      path: "stub", name: "stubUltimax", mapperType: "ultimax",
      currentBank: 0, exrom: 1, game: 0,
      romlBanks: [0], romhBanks: [0], writable: false,
    };
  }
  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0x8000 && address <= 0x9fff) return this.byteRoml;
    if (address >= 0xe000 && address <= 0xffff) return this.byteRomh;
    return undefined;
  }
  write(): boolean { return false; }
}

// --- M6.1 — cart-active PLA states ---

export function runCartPlaTest(): CheckResult[] {
  const out: CheckResult[] = [];

  // 8K cart, $01=$37 → BASIC visible, ROML at $8000 visible.
  {
    const bus = new HeadlessMemoryBus();
    bus.attachCartridge(new StubCart8k());
    bus.write(0x0001, 0x37);
    out.push(check("8K cart: $8000 reads cart ROML ($aa)",
      bus.read(0x8000) === 0xaa));
    // BASIC stays visible at $A000-$BFFF (no cart_hi).
    out.push(check("8K cart: $A000 reads RAM (no BASIC ROM loaded in test)",
      bus.read(0xa000) === 0));
  }

  // 16K cart: $8000-$9FFF + $A000-$BFFF both routed to cart.
  {
    const bus = new HeadlessMemoryBus();
    bus.attachCartridge(new StubCart16k());
    bus.write(0x0001, 0x37);
    out.push(check("16K cart: $8000 reads cart ROML ($bb)",
      bus.read(0x8000) === 0xbb));
    out.push(check("16K cart: $A000 reads cart ROMH ($bb)",
      bus.read(0xa000) === 0xbb));
  }

  // Ultimax: $8000-$9FFF cart_lo, $E000-$FFFF cart_hi_ultimax,
  // $A000-$BFFF unmapped (RAM). I/O always visible.
  {
    const bus = new HeadlessMemoryBus();
    bus.attachCartridge(new StubCartUltimax());
    bus.write(0x0001, 0x37);
    out.push(check("Ultimax: $8000 reads cart ROML ($cc)",
      bus.read(0x8000) === 0xcc));
    out.push(check("Ultimax: $E000 reads cart ROMH ($dd)",
      bus.read(0xe000) === 0xdd));
    out.push(check("Ultimax: $A000 reads RAM (unmapped)",
      bus.read(0xa000) === 0));
  }

  return out;
}

// --- M6.2 — bank-switch via $DE00 ---

export function runMapperBankSwitchTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const bus = new HeadlessMemoryBus();
  const cart = new StubCart8k();
  bus.attachCartridge(cart);
  bus.write(0x0001, 0x37);

  out.push(check("initial bank 0", cart.bank === 0));
  // Write $DE00 (I/O1 cart-bank-select range).
  bus.write(0xde00, 0x05);
  out.push(check("after $DE00 = $05: bank = 5", cart.bank === 5));
  bus.write(0xde00, 0x3f);
  out.push(check("$DE00 = $3f: bank = $3f", cart.bank === 0x3f));
  // Bits beyond mask masked off.
  bus.write(0xde00, 0xff);
  out.push(check("$DE00 = $ff masked to 0x3f", cart.bank === 0x3f));
  return out;
}

// --- M6.3 — cart status descriptor ---

export function runCartStatusTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cart = new StubCart8k();
  cart.bank = 7;
  const state = cart.getState();
  out.push(check("status.mapperType = normal_8k", state.mapperType === "normal_8k"));
  out.push(check("status.currentBank = 7", state.currentBank === 7));
  out.push(check("status.exrom = 0",        state.exrom === 0));
  out.push(check("status.game = 1",         state.game === 1));
  out.push(check("status.writable = false", state.writable === false));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllCartFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M6.1 cart-active PLA states", runner: runCartPlaTest },
    { name: "M6.2 mapper bank-switch",     runner: runMapperBankSwitchTest },
    { name: "M6.3 cart status descriptor", runner: runCartStatusTest },
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
