import { readFileSync } from "node:fs";
import { Cpu6502, type CpuWrite, type SandboxCpuState, type StopReason } from "./cpu6502.js";

export interface MemBlock {
  // Hex byte sequence; loaded at `address`. Use this for inline patches.
  bytes: number[] | Uint8Array;
  address: number;
}

export interface PrgBlock {
  // Path to a PRG file. First two bytes are the load address.
  prgPath: string;
  // Optional override of the PRG load address (rarely needed).
  loadAddressOverride?: number;
}

export interface RawBlock {
  // Path to a raw blob loaded at `address`.
  rawPath: string;
  address: number;
}

export type SandboxLoad = MemBlock | PrgBlock | RawBlock;

export interface SandboxRunOptions {
  loads: SandboxLoad[];
  initialPc: number;
  initialZp?: Record<number, number>;
  initialSp?: number;        // default 0xfd, sentinel pre-staged on stack
  initialA?: number;
  initialX?: number;
  initialY?: number;
  initialFlags?: number;
  inputStream?: number[] | Uint8Array;
  streamHookPcs?: number[];
  stopPc?: number;
  maxSteps?: number;         // default 10_000_000
  // Restrict the returned writes to this range (inclusive).
  returnWritesRange?: { start: number; end: number };
  // If provided, returnedMemory will include a snapshot of these ranges.
  returnMemoryRanges?: { start: number; end: number }[];
}

export interface SandboxRunResult {
  stopReason: StopReason | "stop_pc";
  steps: number;
  finalState: SandboxCpuState;
  // Writes filtered by returnWritesRange (or all writes if no range).
  writes: CpuWrite[];
  // Last write per address within range — convenient for "decoded output".
  writtenMap: Record<number, number>;
  // Smallest contiguous span covering all writtenMap addresses, or null.
  writtenSpan: { start: number; end: number; bytes: number[] } | null;
  // Optional snapshot of explicitly requested memory ranges.
  memorySnapshots: Array<{ start: number; end: number; bytes: number[] }>;
  streamPos: number;
  unimplementedOpcode?: { pc: number; opcode: number };
}

export function runSandbox(options: SandboxRunOptions): SandboxRunResult {
  const mem = new Uint8Array(0x10000);

  for (const load of options.loads) {
    if ("bytes" in load) {
      writeBytes(mem, load.address, load.bytes);
    } else if ("prgPath" in load) {
      const buf = readFileSync(load.prgPath);
      const addr = load.loadAddressOverride ?? (buf[0]! | (buf[1]! << 8));
      writeBytes(mem, addr, buf.subarray(2));
    } else {
      const buf = readFileSync(load.rawPath);
      writeBytes(mem, load.address, buf);
    }
  }

  for (const [zpStr, value] of Object.entries(options.initialZp ?? {})) {
    const addr = Number(zpStr) & 0xff;
    mem[addr] = value & 0xff;
  }

  const cpu = new Cpu6502(mem);
  cpu.pc = options.initialPc & 0xffff;
  cpu.sp = (options.initialSp ?? 0xfd) & 0xff;
  cpu.a = (options.initialA ?? 0) & 0xff;
  cpu.x = (options.initialX ?? 0) & 0xff;
  cpu.y = (options.initialY ?? 0) & 0xff;
  if (options.initialFlags !== undefined) cpu.setFlags(options.initialFlags & 0xff);

  // Stage sentinel: pop sequence pops lo then hi, increments by 1, lands at $FFFE → exit.
  // Stack convention matches lykia_disk_depack.py: $01FE=$FD, $01FF=$FF.
  mem[0x01fe] = 0xfd;
  mem[0x01ff] = 0xff;

  if (options.inputStream) cpu.streamBytes = toUint8(options.inputStream);
  if (options.streamHookPcs) cpu.hookEntries = new Set(options.streamHookPcs.map((pc) => pc & 0xffff));

  const stopPc = options.stopPc;
  const maxSteps = options.maxSteps ?? 10_000_000;
  let steps = 0;
  let stopReason: StopReason | "stop_pc" = "max_steps";
  let unimplemented: { pc: number; opcode: number } | undefined;

  while (steps < maxSteps) {
    if (stopPc !== undefined && cpu.pc === stopPc) {
      stopReason = "stop_pc";
      break;
    }
    const result = cpu.step();
    steps += 1;
    if (result === "continue") continue;
    if (result === "unimplemented_opcode") {
      unimplemented = { pc: cpu.pc, opcode: mem[cpu.pc]! };
      stopReason = "unimplemented_opcode";
      break;
    }
    stopReason = result;
    break;
  }

  const range = options.returnWritesRange;
  const writes = range
    ? cpu.writes.filter((w) => w.address >= range.start && w.address <= range.end)
    : cpu.writes.slice();

  const writtenMap: Record<number, number> = {};
  for (const w of writes) writtenMap[w.address] = w.value;

  let writtenSpan: SandboxRunResult["writtenSpan"] = null;
  const addrs = Object.keys(writtenMap).map(Number).sort((a, b) => a - b);
  if (addrs.length > 0) {
    const start = addrs[0]!;
    const end = addrs[addrs.length - 1]!;
    const bytes: number[] = new Array(end - start + 1).fill(0);
    for (const [addrStr, value] of Object.entries(writtenMap)) {
      bytes[Number(addrStr) - start] = value;
    }
    writtenSpan = { start, end, bytes };
  }

  const memorySnapshots = (options.returnMemoryRanges ?? []).map((r) => ({
    start: r.start,
    end: r.end,
    bytes: Array.from(mem.subarray(r.start, r.end + 1)),
  }));

  return {
    stopReason,
    steps,
    finalState: cpu.getState(),
    writes,
    writtenMap,
    writtenSpan,
    memorySnapshots,
    streamPos: cpu.streamPos,
    unimplementedOpcode: unimplemented,
  };
}

function writeBytes(mem: Uint8Array, address: number, source: ArrayLike<number>): void {
  for (let i = 0; i < source.length; i++) {
    mem[(address + i) & 0xffff] = source[i]! & 0xff;
  }
}

function toUint8(input: number[] | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : Uint8Array.from(input);
}
