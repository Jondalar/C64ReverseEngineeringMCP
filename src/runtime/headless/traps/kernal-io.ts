// KERNAL I/O trap suite (Sprint 76).
//
// Higher-level CHRIN/CHROUT/CHKIN/CKOUT/OPEN/CLOSE/CLRCH/READST/GETIN
// trapped at JMP-table addresses. These wrap LISTEN/TALK/CIOUT/ACPTR
// with channel state. Implementing them as traps lets games that go
// via these high-level KERNAL functions work even before the
// underlying serial bit-bang fully completes.
//
// Behavior:
// - OPEN: store logical-file → (device, secondary, name) mapping;
//   delegate file lookup to the kernal-serial state's channel queue
//   so subsequent CHRIN/CHKIN reads pull bytes from the disk.
// - CHKIN/CKOUT: select default input/output device for CHRIN/CHROUT.
// - CHRIN: if input device is a file (LFN > 2), pull next byte from
//   channel queue. Otherwise stub-return 0.
// - CHROUT: print to stdout-equivalent buffer (for game text via
//   KERNAL print). Set carry clear.
// - CLOSE: drop channel.
// - CLRCH: restore default I/O channels.
// - READST: return KERNAL ST byte ($90 in ZP).
// - GETIN: like CHRIN but non-blocking via keyboard buffer for
//   default device.

import type { Cpu6510 } from "../cpu6510.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { DiskProvider } from "../providers.js";
import type { KernalSerialState } from "./kernal-serial.js";

export const KERNAL_OPEN   = 0xffc0;
export const KERNAL_CLOSE  = 0xffc3;
export const KERNAL_CHKIN  = 0xffc6;
export const KERNAL_CKOUT  = 0xffc9;
export const KERNAL_CLRCH  = 0xffcc;
export const KERNAL_CHRIN  = 0xffcf;
export const KERNAL_CHROUT = 0xffd2;
export const KERNAL_READST = 0xffb7;
export const KERNAL_GETIN  = 0xffe4;

export interface KernalIoState {
  defaultInputDevice: number;     // 0 = keyboard
  defaultOutputDevice: number;    // 3 = screen
  // Per logical file → (device, secondary, name) opened via OPEN.
  openFiles: Map<number, { device: number; secondary: number; name: string }>;
  // Char output buffer (CHROUT writes append).
  outputBuffer: number[];
  // KERNAL ST status byte ($90) shadow.
  status: number;
  lastTrap?: string;
}

export function makeKernalIoState(): KernalIoState {
  return {
    defaultInputDevice: 0,
    defaultOutputDevice: 3,
    openFiles: new Map(),
    outputBuffer: [],
    status: 0,
  };
}

export interface KernalIoDeps {
  cpu: Cpu6510;
  bus: HeadlessMemoryBus;
  diskProvider: DiskProvider;
  serial: KernalSerialState;
  state: KernalIoState;
}

export function handleKernalIoTrap(deps: KernalIoDeps): boolean {
  switch (deps.cpu.pc) {
    case KERNAL_OPEN:   trapOpen(deps);   return true;
    case KERNAL_CLOSE:  trapClose(deps);  return true;
    case KERNAL_CHKIN:  trapChkin(deps);  return true;
    case KERNAL_CKOUT:  trapCkout(deps);  return true;
    case KERNAL_CLRCH:  trapClrch(deps);  return true;
    case KERNAL_CHRIN:  trapChrin(deps);  return true;
    case KERNAL_CHROUT: trapChrout(deps); return true;
    case KERNAL_READST: trapReadst(deps); return true;
    case KERNAL_GETIN:  trapGetin(deps);  return true;
    default: return false;
  }
}

function trapOpen({ cpu, bus, diskProvider, state, serial }: KernalIoDeps): void {
  // KERNAL OPEN reads zero-page state set by SETLFS + SETNAM.
  const lfn = bus.ram[0xb8]!;
  const device = bus.ram[0xba]!;
  const sa = bus.ram[0xb9]!;
  const fnLen = bus.ram[0xb7]!;
  const fnPtr = bus.ram[0xbb]! | (bus.ram[0xbc]! << 8);
  let name = "";
  for (let i = 0; i < fnLen; i++) name += String.fromCharCode(bus.read((fnPtr + i) & 0xffff));
  state.openFiles.set(lfn, { device, secondary: sa, name });
  // For disk files, queue bytes via the serial channel queue so
  // CHRIN/GETIN can drain them.
  if (device === 8 && name) {
    const match = diskProvider.findFile(name);
    if (match) {
      serial.channelQueue.set(sa & 0x0f, match.bytes);
      serial.channelCursor.set(sa & 0x0f, 0);
      cpu.setCarry(false);
    } else {
      cpu.setCarry(true); cpu.a = 4;
    }
  } else {
    cpu.setCarry(false);
  }
  cpu.returnFromSubroutine();
  state.lastTrap = `OPEN lfn=${lfn} dev=${device} sa=$${sa.toString(16)} "${name}"`;
}

function trapClose({ cpu, bus, state, serial }: KernalIoDeps): void {
  const lfn = cpu.a & 0xff;
  const meta = state.openFiles.get(lfn);
  if (meta) {
    serial.channelQueue.delete(meta.secondary & 0x0f);
    serial.channelCursor.delete(meta.secondary & 0x0f);
    state.openFiles.delete(lfn);
  }
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `CLOSE lfn=${lfn}`;
  void bus;
}

function trapChkin({ cpu, state }: KernalIoDeps): void {
  const lfn = cpu.x & 0xff;
  const meta = state.openFiles.get(lfn);
  if (meta) state.defaultInputDevice = lfn;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `CHKIN lfn=${lfn}`;
}

function trapCkout({ cpu, state }: KernalIoDeps): void {
  const lfn = cpu.x & 0xff;
  const meta = state.openFiles.get(lfn);
  if (meta) state.defaultOutputDevice = lfn;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `CKOUT lfn=${lfn}`;
}

function trapClrch({ cpu, state }: KernalIoDeps): void {
  state.defaultInputDevice = 0;
  state.defaultOutputDevice = 3;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `CLRCH`;
}

function trapChrin({ cpu, state, serial }: KernalIoDeps): void {
  const lfn = state.defaultInputDevice;
  const meta = state.openFiles.get(lfn);
  if (meta) {
    const sa = meta.secondary & 0x0f;
    const queue = serial.channelQueue.get(sa);
    const cursor = serial.channelCursor.get(sa) ?? 0;
    if (queue && cursor < queue.length) {
      cpu.a = queue[cursor]!;
      serial.channelCursor.set(sa, cursor + 1);
      state.status = 0;
    } else {
      cpu.a = 0;
      state.status = 0x40; // EOF
    }
  } else {
    cpu.a = 0;
  }
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
}

function trapChrout({ cpu, state }: KernalIoDeps): void {
  state.outputBuffer.push(cpu.a & 0xff);
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
}

function trapReadst({ cpu, state }: KernalIoDeps): void {
  cpu.a = state.status;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
}

function trapGetin({ cpu, bus, state }: KernalIoDeps): void {
  // From keyboard: read $C6 (kb buffer count) + drain $0277.
  if (state.defaultInputDevice === 0) {
    const count = bus.ram[0xc6]!;
    if (count > 0) {
      cpu.a = bus.ram[0x0277]!;
      // Shift buffer down.
      for (let i = 0; i < 9; i++) bus.ram[0x0277 + i] = bus.ram[0x0278 + i]!;
      bus.ram[0xc6] = count - 1;
    } else {
      cpu.a = 0;
    }
  } else {
    // Otherwise like CHRIN.
    trapChrin({ cpu, bus, diskProvider: undefined as never, state, serial: undefined as never });
    return;
  }
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
}
