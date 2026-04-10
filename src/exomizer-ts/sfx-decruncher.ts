import { Cpu6502, type CpuMemory } from "./cpu6502.js";

export interface ExomizerSfxDepackOptions {
  entryAddress?: number | "load";
  maxInstructions?: number;
}

export interface ExomizerSfxDepackResult {
  data: Uint8Array;
  byteCount: number;
  outputStart: number;
  outputEnd: number;
  entryPoint: number;
  cycles: number;
  loadAddress: number;
}

function parseLoadAddress(prg: Uint8Array): number {
  if (prg.length < 2) {
    throw new Error("PRG is too short.");
  }
  return prg[0]! | (prg[1]! << 8);
}

function inferBasicSysEntry(payload: Uint8Array, loadAddress: number): number | undefined {
  if (loadAddress !== 0x0801 || payload.length < 8) {
    return undefined;
  }
  const sysToken = 0x9e;
  const tokenIndex = payload.indexOf(sysToken);
  if (tokenIndex < 0) {
    return undefined;
  }
  let i = tokenIndex + 1;
  while (i < payload.length && payload[i] === 0x20) i++;
  let digits = "";
  while (i < payload.length) {
    const value = payload[i]!;
    if (value < 0x30 || value > 0x39) break;
    digits += String.fromCharCode(value);
    i++;
  }
  if (!digits) {
    return undefined;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed & 0xffff : undefined;
}

function findLargestWrittenRange(written: Uint8Array): { start: number; end: number } {
  let bestStart = 0;
  let bestEnd = 0;
  let bestLen = -1;
  let currentStart = -1;
  for (let address = 0; address < 0x10000; address++) {
    if (written[address] !== 0) {
      if (currentStart < 0) currentStart = address;
    } else if (currentStart >= 0) {
      const currentLen = address - currentStart;
      if (currentLen > bestLen) {
        bestLen = currentLen;
        bestStart = currentStart;
        bestEnd = address;
      }
      currentStart = -1;
    }
  }
  if (currentStart >= 0) {
    const currentLen = 0x10000 - currentStart;
    if (currentLen > bestLen) {
      bestStart = currentStart;
      bestEnd = 0x10000;
    }
  }
  return { start: bestStart, end: bestEnd };
}

class ExomizerSfxMemory implements CpuMemory {
  public readonly mem = new Uint8Array(0x10000);
  public readonly written = new Uint8Array(0x10000);

  read(address: number): number {
    return this.mem[address & 0xffff]!;
  }

  write(address: number, value: number): void {
    address &= 0xffff;
    value &= 0xff;
    if ((this.mem[0x0001]! & 0x04) === 0x04 && (this.mem[0x0001]! & 0x03) !== 0 && address >= 0xd000 && address < 0xe000) {
      return;
    }
    this.mem[address] = value;
    this.written[address] = 1;
  }
}

export class ExomizerSfxDepacker {
  unpack(prg: Uint8Array, options: ExomizerSfxDepackOptions = {}): ExomizerSfxDepackResult {
    const loadAddress = parseLoadAddress(prg);
    const payload = prg.slice(2);
    const memory = new ExomizerSfxMemory();
    memory.mem.set(payload, loadAddress);
    memory.mem[0x0001] = 0x37;

    const inferredEntry = inferBasicSysEntry(payload, loadAddress);
    const entryPoint =
      options.entryAddress === "load"
        ? loadAddress
        : typeof options.entryAddress === "number"
          ? options.entryAddress & 0xffff
          : inferredEntry ?? loadAddress;

    const cpu = new Cpu6502(memory);
    cpu.pc = entryPoint;
    cpu.sp = 0xf6;
    cpu.flags = 0;

    const maxInstructions = options.maxInstructions ?? 5_000_000;
    let instructions = 0;

    while ((cpu.pc >= 0x0400 || cpu.sp !== 0xf6) && instructions++ < maxInstructions) {
      cpu.step();
    }
    memory.written.fill(0);
    while (cpu.pc < 0x0400 && instructions++ < maxInstructions) {
      cpu.step();
    }

    if (instructions >= maxInstructions) {
      throw new Error(`Exomizer SFX emulation exceeded ${maxInstructions} instructions.`);
    }

    const { start, end } = findLargestWrittenRange(memory.written);
    if (end <= start) {
      throw new Error("Exomizer SFX emulation did not produce a writable output range.");
    }

    const out = new Uint8Array(2 + (end - start));
    out[0] = start & 0xff;
    out[1] = (start >> 8) & 0xff;
    out.set(memory.mem.slice(start, end), 2);

    return {
      data: out,
      byteCount: end - start,
      outputStart: start,
      outputEnd: end,
      entryPoint: cpu.pc,
      cycles: cpu.cycles,
      loadAddress,
    };
  }
}
