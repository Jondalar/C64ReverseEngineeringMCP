// KERNAL file-IO trap suite (Sprint 67 — to be removed in Spec 064 / Sprint 69).
//
// Traps SETLFS / SETNAM / LOAD / SAVE at the JMP-table entries so
// bootstrap PRG load is instant via direct G64 read instead of running
// real KERNAL serial bit-bang. Custom-loader bit-bang traffic via
// $DD00 (= post-LOAD M-W/M-E sequences + game runtime fastloader)
// still goes through the real iec-bus bit-mirror — that's what
// matters for RE.
//
// Will be deleted by Spec 064 once CIA1 timer model lands and KERNAL
// can run authentically.

import type { Cpu6510 } from "../cpu6510.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { DiskProvider } from "../providers.js";

export const KERNAL_SETLFS = 0xffba;
export const KERNAL_SETNAM = 0xffbd;
export const KERNAL_LOAD = 0xffd5;
export const KERNAL_SAVE = 0xffd8;

export interface KernalFileIoState {
  logicalFile: number;
  device: number;
  secondaryAddress: number;
  fileName: string;
  loadEvents: Array<{ name: string; loadAddress: number; endAddress: number; bytesLoaded: number }>;
  lastTrap?: string;
}

export function makeKernalFileIoState(): KernalFileIoState {
  return {
    logicalFile: 0,
    device: 0,
    secondaryAddress: 1,
    fileName: "",
    loadEvents: [],
  };
}

export interface KernalTrapDeps {
  cpu: Cpu6510;
  bus: HeadlessMemoryBus;
  diskProvider: DiskProvider;
  state: KernalFileIoState;
}

// Returns true if the current PC is at a trap entry and the trap was
// handled. Caller should skip cpu.step() on true.
export function handleKernalFileIoTrap(deps: KernalTrapDeps): boolean {
  switch (deps.cpu.pc) {
    case KERNAL_SETLFS: trapSetlfs(deps); return true;
    case KERNAL_SETNAM: trapSetnam(deps); return true;
    case KERNAL_LOAD: trapLoad(deps); return true;
    case KERNAL_SAVE: trapSave(deps); return true;
    default: return false;
  }
}

function trapSetlfs({ cpu, bus, state }: KernalTrapDeps): void {
  state.logicalFile = cpu.a;
  state.device = cpu.x;
  state.secondaryAddress = cpu.y;
  bus.ram[0xb8] = state.logicalFile;
  bus.ram[0xba] = state.device;
  bus.ram[0xb9] = state.secondaryAddress;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `SETLFS lfn=${state.logicalFile} device=${state.device} sa=${state.secondaryAddress}`;
}

function trapSetnam({ cpu, bus, state }: KernalTrapDeps): void {
  const length = cpu.a & 0xff;
  const ptr = cpu.x | (cpu.y << 8);
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) bytes.push(bus.read((ptr + i) & 0xffff));
  state.fileName = String.fromCharCode(...bytes);
  bus.ram[0xb7] = length;
  bus.ram[0xbb] = ptr & 0xff;
  bus.ram[0xbc] = (ptr >> 8) & 0xff;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `SETNAM "${state.fileName}" @ $${ptr.toString(16)}`;
}

function trapLoad({ cpu, bus, diskProvider, state }: KernalTrapDeps): void {
  const fnLen = bus.ram[0xb7]!;
  const fnPtr = bus.ram[0xbb]! | (bus.ram[0xbc]! << 8);
  let nameFromZp = "";
  for (let i = 0; i < fnLen; i++) {
    nameFromZp += String.fromCharCode(bus.read((fnPtr + i) & 0xffff));
  }
  if (nameFromZp) state.fileName = nameFromZp;
  state.device = bus.ram[0xba]!;
  state.secondaryAddress = bus.ram[0xb9]!;
  const fileName = state.fileName.trim();
  if (!fileName) {
    cpu.setCarry(true); cpu.a = 8;
    cpu.returnFromSubroutine();
    state.lastTrap = `LOAD ERROR: no filename`;
    return;
  }
  const match = diskProvider.findFile(fileName);
  if (!match) {
    cpu.setCarry(true); cpu.a = 4;
    cpu.returnFromSubroutine();
    state.lastTrap = `LOAD ERROR: "${fileName}" not found`;
    return;
  }
  const bytes = match.bytes;
  const fileLoadAddress = bytes.length >= 2 ? (bytes[0]! | (bytes[1]! << 8)) : 0;
  const target = state.secondaryAddress === 0 ? (cpu.x | (cpu.y << 8)) : fileLoadAddress;
  const payload = bytes.length >= 2 ? bytes.slice(2) : bytes;
  for (let i = 0; i < payload.length; i++) {
    bus.ram[(target + i) & 0xffff] = payload[i]!;
  }
  const end = (target + payload.length) & 0xffff;
  cpu.a = 0;
  cpu.x = end & 0xff;
  cpu.y = (end >> 8) & 0xff;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `LOAD "${match.entry.name}" -> $${target.toString(16)}-$${(end - 1).toString(16)} (${payload.length} bytes)`;
  state.loadEvents.push({ name: match.entry.name, loadAddress: target, endAddress: end, bytesLoaded: payload.length });
}

function trapSave({ cpu, state }: KernalTrapDeps): void {
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `SAVE (no-op stub)`;
}
