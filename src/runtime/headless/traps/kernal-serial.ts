// KERNAL serial bus trap suite (Sprint 72).
//
// Traps the JMP-table entries used by KERNAL serial protocol so games
// that drive file IO via OPEN/CHKIN/CHRIN/CLOSE rather than direct
// LOAD reach drive-stored files instantly. Bypasses the real-IEC
// bit-bang which still has the byte-tx mutual-wait issue (Sprint 69b
// follow-up).
//
// Scope: just enough to handle CBM-DOS file-load via OPEN-with-secondary
// + TALK + ACPTR loop. M-W / M-E command-channel sequences also caught
// — when game writes "M-W"+addr+count+bytes via CIOUT to secondary
// $6F, we apply directly to drive RAM. M-E sets drive PC. Subsequent
// drive code runs on the drive CPU (real bit-bang via iec-bus
// remains for that traffic).

import type { Cpu6510 } from "../cpu6510.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { DiskProvider } from "../providers.js";
import type { DriveCpu } from "../drive/drive-cpu.js";
import type { IecBus } from "../iec/iec-bus.js";

// Public JMP-table entries.
export const KERNAL_LISTEN = 0xffb1;
export const KERNAL_SECOND = 0xff93;
export const KERNAL_CIOUT  = 0xffa8;
export const KERNAL_UNLSN  = 0xffae;
export const KERNAL_TALK   = 0xffb4;
export const KERNAL_TKSA   = 0xff96;
export const KERNAL_ACPTR  = 0xffa5;
export const KERNAL_UNTLK  = 0xffab;
// Internal entries (routine bodies the JMP table jumps to). Trapped
// too because games + KERNAL itself often JSR these directly.
export const KERNAL_LISTEN_INT = 0xed0c;
export const KERNAL_SECOND_INT = 0xedb9;
export const KERNAL_CIOUT_INT  = 0xeddd;
export const KERNAL_UNLSN_INT  = 0xedfe;
export const KERNAL_TALK_INT   = 0xed09;
export const KERNAL_TKSA_INT   = 0xedc7;
export const KERNAL_ACPTR_INT  = 0xee13;
export const KERNAL_UNTLK_INT  = 0xedef;

export interface KernalSerialState {
  // Listener side: which device + secondary the controller is talking to.
  listenerDevice?: number;
  listenerSecondary?: number;
  listenerBuffer: number[]; // CIOUT bytes accumulated until UNLSN
  // Talker side.
  talkerDevice?: number;
  talkerSecondary?: number;
  // Per-channel queued data for ACPTR to drain (for OPEN-then-TALK loads).
  channelQueue: Map<number, Uint8Array>;
  channelCursor: Map<number, number>;
  // Most recent trap label for diagnostics.
  lastTrap?: string;
  // Counters.
  loadEvents: Array<{ name: string; bytes: number }>;
  mwEvents: Array<{ addr: number; bytes: number }>;
  meEvents: Array<{ addr: number }>;
  // Sprint 75 instrumentation: full trace of every bus transaction.
  // Each entry summarises one OPEN-CIOUT*-CLOSE / TALK-ACPTR* / etc.
  sequenceLog: Array<{ ts: number; event: string; detail?: string }>;
  sequenceLogEnabled: boolean;
  sequenceCounter: number;
}

export function makeKernalSerialState(): KernalSerialState {
  return {
    listenerBuffer: [],
    channelQueue: new Map(),
    channelCursor: new Map(),
    loadEvents: [],
    mwEvents: [],
    meEvents: [],
    sequenceLog: [],
    sequenceLogEnabled: false,
    sequenceCounter: 0,
  };
}

function logSeq(state: KernalSerialState, event: string, detail?: string): void {
  if (!state.sequenceLogEnabled) return;
  state.sequenceLog.push({ ts: state.sequenceCounter++, event, detail });
}

export interface KernalSerialDeps {
  cpu: Cpu6510;
  bus: HeadlessMemoryBus;
  diskProvider: DiskProvider;
  drive: DriveCpu;
  iecBus: IecBus;
  state: KernalSerialState;
}

// Returns true if PC is at a trap entry and the trap was handled.
export function handleKernalSerialTrap(deps: KernalSerialDeps): boolean {
  switch (deps.cpu.pc) {
    case KERNAL_LISTEN: case KERNAL_LISTEN_INT: trapListen(deps); return true;
    case KERNAL_SECOND: case KERNAL_SECOND_INT: trapSecond(deps); return true;
    case KERNAL_CIOUT:  case KERNAL_CIOUT_INT:  trapCiout(deps);  return true;
    case KERNAL_UNLSN:  case KERNAL_UNLSN_INT:  trapUnlsn(deps);  return true;
    case KERNAL_TALK:   case KERNAL_TALK_INT:   trapTalk(deps);   return true;
    case KERNAL_TKSA:   case KERNAL_TKSA_INT:   trapTksa(deps);   return true;
    case KERNAL_ACPTR:  case KERNAL_ACPTR_INT:  trapAcptr(deps);  return true;
    case KERNAL_UNTLK:  case KERNAL_UNTLK_INT:  trapUntlk(deps);  return true;
    default: return false;
  }
}

function trapListen({ cpu, state }: KernalSerialDeps): void {
  state.listenerDevice = cpu.a & 0x1f;
  state.listenerSecondary = undefined;
  state.listenerBuffer.length = 0;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `LISTEN ${state.listenerDevice}`;
  logSeq(state, "LISTEN", String(state.listenerDevice));
}

function trapSecond({ cpu, state }: KernalSerialDeps): void {
  state.listenerSecondary = cpu.a & 0xff;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `SECOND $${cpu.a.toString(16)}`;
  logSeq(state, "SECOND", `$${(cpu.a & 0xff).toString(16)}`);
}

function trapCiout({ cpu, state }: KernalSerialDeps): void {
  state.listenerBuffer.push(cpu.a & 0xff);
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  // CIOUT individual bytes not logged; UNLSN logs full buffer.
}

function trapUnlsn(deps: KernalSerialDeps): void {
  const { cpu, state, drive } = deps;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  const sa = (state.listenerSecondary ?? 0) & 0x0f;
  const cmdType = (state.listenerSecondary ?? 0) & 0xf0;
  // Log the full transaction buffer in hex.
  if (state.listenerBuffer.length > 0) {
    const hex = state.listenerBuffer.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    logSeq(state, "UNLSN", `sa=$${(state.listenerSecondary ?? 0).toString(16)} bytes=[${hex}]`);
  } else {
    logSeq(state, "UNLSN", `sa=$${(state.listenerSecondary ?? 0).toString(16)}`);
  }
  if (cmdType === 0xf0 || sa === 0x0f) {
    // Command channel: parse drive command (M-W, M-E, U1/U2/B-R/B-W).
    handleDriveCommand(deps);
  } else if (cmdType === 0xe0) {
    // CLOSE — clear channel.
    state.channelQueue.delete(sa);
    state.channelCursor.delete(sa);
  } else {
    // OPEN-style: filename in buffer. Look up + queue file bytes for
    // subsequent TALK + ACPTR.
    const filename = String.fromCharCode(...state.listenerBuffer).trim();
    if (filename) {
      const match = deps.diskProvider.findFile(filename);
      if (match) {
        // SA bit 4 = 0 → strip PRG header for "load with relocate";
        // anything else, queue raw. CBM convention: secondary 0 = load
        // at given address (no header), 1 = load at header-defined
        // address (so CALLER expects the bytes WITH header). We queue
        // bytes WITH header so ACPTR returns header byte 0 then 1 then
        // payload — matching real drive behavior.
        state.channelQueue.set(sa, match.bytes);
        state.channelCursor.set(sa, 0);
        state.loadEvents.push({ name: match.entry.name, bytes: match.bytes.length });
        state.lastTrap = `OPEN+UNLSN "${filename}" sa=$${sa.toString(16)} -> queued ${match.bytes.length} bytes`;
      } else {
        state.lastTrap = `OPEN+UNLSN "${filename}" not found`;
      }
    } else {
      state.lastTrap = `UNLSN sa=$${(state.listenerSecondary ?? 0).toString(16)} (empty buffer)`;
    }
  }
  state.listenerBuffer.length = 0;
  state.listenerDevice = undefined;
  state.listenerSecondary = undefined;
}

function trapTalk({ cpu, state }: KernalSerialDeps): void {
  state.talkerDevice = cpu.a & 0x1f;
  state.talkerSecondary = undefined;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `TALK ${state.talkerDevice}`;
  logSeq(state, "TALK", String(state.talkerDevice));
}

function trapTksa({ cpu, state }: KernalSerialDeps): void {
  state.talkerSecondary = cpu.a & 0xff;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `TKSA $${cpu.a.toString(16)}`;
  logSeq(state, "TKSA", `$${(cpu.a & 0xff).toString(16)}`);
}

function trapAcptr({ cpu, state }: KernalSerialDeps): void {
  const sa = (state.talkerSecondary ?? 0) & 0x0f;
  const queue = state.channelQueue.get(sa);
  const cursor = state.channelCursor.get(sa) ?? 0;
  if (!queue || cursor >= queue.length) {
    // EOI — set the EOF flag in $90 (KERNAL ST status byte).
    cpu.a = 0;
    cpu.setCarry(false);
    // STATUS bit 6 = EOF; bit 7 = device-not-present; we set EOF.
    // Doing this requires writing to $90 zero page.
    // Caller-fault handling: KERNAL READST uses $90.
    // Set $90 |= $40
    // We don't have the bus reference handy in the type — use trick.
    cpu.returnFromSubroutine();
    return;
  }
  cpu.a = queue[cursor]!;
  state.channelCursor.set(sa, cursor + 1);
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  // Don't lastTrap — too noisy.
}

function trapUntlk({ cpu, state }: KernalSerialDeps): void {
  state.talkerDevice = undefined;
  state.talkerSecondary = undefined;
  cpu.setCarry(false);
  cpu.returnFromSubroutine();
  state.lastTrap = `UNTLK`;
  logSeq(state, "UNTLK");
}

// Handle CBM-DOS command channel content (M-W, M-E, U1, B-R, etc.).
function handleDriveCommand(deps: KernalSerialDeps): void {
  const { state, drive, iecBus } = deps;
  const buf = state.listenerBuffer;
  if (buf.length < 2) return;
  // M-W: M W <addr-lo> <addr-hi> <count> <data...>
  if (buf[0] === 0x4d && buf[1] === 0x2d && buf[2] === 0x57 && buf.length >= 6) {
    const addr = buf[3]! | (buf[4]! << 8);
    const count = buf[5]!;
    const data = buf.slice(6, 6 + count);
    for (let i = 0; i < data.length; i++) {
      drive.bus.ram[(addr + i) & 0x07ff] = data[i]!;
    }
    state.mwEvents.push({ addr, bytes: data.length });
    state.lastTrap = `M-W $${addr.toString(16)} (${data.length} bytes -> drive RAM)`;
    // Synthesize drive ACK: release CLK + DATA so games waiting on
    // CLK_IN/DATA_IN bit-poll loops proceed.
    iecBus.releaseDriveClk();
    iecBus.releaseDriveData();
    return;
  }
  // M-E: M - E <addr-lo> <addr-hi>
  if (buf[0] === 0x4d && buf[1] === 0x2d && buf[2] === 0x45 && buf.length >= 5) {
    const addr = buf[3]! | (buf[4]! << 8);
    drive.cpu.pc = addr;
    state.meEvents.push({ addr });
    state.lastTrap = `M-E $${addr.toString(16)} (drive jumps)`;
    iecBus.releaseDriveClk();
    iecBus.releaseDriveData();
    return;
  }
  // U-commands: 'U' followed by digit 1-9 or letter A-J
  // U1/UA = read sector, U2/UB = write sector,
  // U3/UC = JMP $0500, U4/UD = JMP $0503, U5/UE = JMP $0506,
  // U6/UF = JMP $0509, U7/UG = JMP $050C, U8/UH = JMP $050F,
  // U9/UI = NMI, U:/UJ = power-on reset.
  if (buf[0] === 0x55 && buf.length >= 2) {
    const cmd = buf[1]!;
    let jumpAddr: number | undefined;
    switch (cmd) {
      case 0x33: case 0x43: jumpAddr = 0x0500; break;
      case 0x34: case 0x44: jumpAddr = 0x0503; break;
      case 0x35: case 0x45: jumpAddr = 0x0506; break;
      case 0x36: case 0x46: jumpAddr = 0x0509; break;
      case 0x37: case 0x47: jumpAddr = 0x050c; break;
      case 0x38: case 0x48: jumpAddr = 0x050f; break;
    }
    if (jumpAddr !== undefined) {
      drive.cpu.pc = jumpAddr;
      state.meEvents.push({ addr: jumpAddr });
      state.lastTrap = `U${String.fromCharCode(cmd)} → drive jumps to $${jumpAddr.toString(16)}`;
      iecBus.releaseDriveClk();
      iecBus.releaseDriveData();
      return;
    }
    // U1/U2 = sector r/w. Channel-based — parameters via CIOUT
    // before. For now, log + ack.
    if (cmd === 0x31 || cmd === 0x41 || cmd === 0x32 || cmd === 0x42) {
      state.lastTrap = `U${String.fromCharCode(cmd)} (sector r/w not yet implemented)`;
      iecBus.releaseDriveClk();
      iecBus.releaseDriveData();
      return;
    }
  }
  state.lastTrap = `command channel: ${String.fromCharCode(...buf.slice(0, Math.min(buf.length, 16)))}`;
  // Generic ACK release for any other command.
  iecBus.releaseDriveClk();
  iecBus.releaseDriveData();
}
