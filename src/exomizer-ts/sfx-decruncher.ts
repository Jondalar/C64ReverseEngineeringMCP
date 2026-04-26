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

// Score-based scan for plausible Exomizer SFX prologue entry points.
// Standard exomizer SFX wrappers start with a setup sequence that mostly
// looks like one of these:
//   SEI / LDA #imm / STA $01      ; 78 A9 ?? 85 01  (bank config, very common)
//   SEI / LDX #imm                 ; 78 A2 ??         (init copy/decrunch counter)
//   LDX #imm / LDA abs,X / ...    ; A2 ?? BD ?? ??   (decrunch table init read)
//   LDA #$37 / STA $01             ; A9 37 85 01      (restore default banking)
//
// We don't try to verify the full template — just pick offsets where one
// of the patterns appears and score them. The unpacker then emulates
// each candidate and keeps the one that produces the largest output.
function scanSfxPrologueCandidates(payload: Uint8Array, loadAddress: number): number[] {
  const candidates: Array<{ address: number; score: number }> = [];
  const length = payload.length;
  for (let i = 0; i < length - 5; i++) {
    let score = 0;
    const b0 = payload[i]!;
    const b1 = payload[i + 1]!;
    const b2 = payload[i + 2]!;
    const b3 = payload[i + 3]!;
    const b4 = payload[i + 4]!;

    // SEI / LDA #imm / STA $01 — classic banking-config prologue.
    if (b0 === 0x78 && b1 === 0xa9 && b3 === 0x85 && b4 === 0x01) score += 5;
    // LDA #$37 / STA $01 — banking-config alone (often immediately after SEI).
    if (b0 === 0xa9 && b1 === 0x37 && b2 === 0x85 && b3 === 0x01) score += 4;
    // SEI / LDX #imm — decrunch counter init right after IRQ disable.
    if (b0 === 0x78 && b1 === 0xa2) score += 3;
    // SEI / SEI (sometimes doubled) followed by anything plausible.
    if (b0 === 0x78 && (b1 === 0xa2 || b1 === 0xa0 || b1 === 0xa9)) score += 1;
    // LDX #imm / LDA abs,X — decrunch-table init read (very common).
    if (b0 === 0xa2 && b2 === 0xbd) score += 3;
    // LDX #imm / LDA abs,Y — alternate table-walk pattern.
    if (b0 === 0xa2 && b2 === 0xb9) score += 2;
    // LDY #imm / LDA abs,Y same as above mirrored.
    if (b0 === 0xa0 && b2 === 0xb9) score += 2;

    if (score >= 3) {
      candidates.push({ address: loadAddress + i, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.address - right.address);
  // Cap at a small number of candidates — emulating each is expensive.
  return candidates.slice(0, 6).map((entry) => entry.address);
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

function emulateSfxFromEntry(args: {
  payload: Uint8Array;
  loadAddress: number;
  entryPoint: number;
  maxInstructions: number;
}): ExomizerSfxDepackResult {
  const memory = new ExomizerSfxMemory();
  memory.mem.set(args.payload, args.loadAddress);
  memory.mem[0x0001] = 0x37;

  const cpu = new Cpu6502(memory);
  cpu.pc = args.entryPoint;
  cpu.sp = 0xf6;
  cpu.flags = 0;

  let instructions = 0;
  while ((cpu.pc >= 0x0400 || cpu.sp !== 0xf6) && instructions++ < args.maxInstructions) {
    cpu.step();
  }
  memory.written.fill(0);
  while (cpu.pc < 0x0400 && instructions++ < args.maxInstructions) {
    cpu.step();
  }

  if (instructions >= args.maxInstructions) {
    throw new Error(`Exomizer SFX emulation exceeded ${args.maxInstructions} instructions.`);
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
    loadAddress: args.loadAddress,
  };
}

const SFX_OUTPUT_SANITY_THRESHOLD = 256;

export class ExomizerSfxDepacker {
  unpack(prg: Uint8Array, options: ExomizerSfxDepackOptions = {}): ExomizerSfxDepackResult {
    const loadAddress = parseLoadAddress(prg);
    const payload = prg.slice(2);
    const maxInstructions = options.maxInstructions ?? 5_000_000;

    // Build the candidate-entry list. User overrides win, then BASIC SYS
    // inference, then the raw load address, then auto-scanned prologue
    // candidates as a fallback for SFX wrappers loaded by an outer
    // loader (no BASIC SYS line, entry mid-payload).
    const candidates: number[] = [];
    const pushUnique = (address: number) => {
      const masked = address & 0xffff;
      if (!candidates.includes(masked)) candidates.push(masked);
    };
    if (options.entryAddress === "load") {
      pushUnique(loadAddress);
    } else if (typeof options.entryAddress === "number") {
      pushUnique(options.entryAddress);
    } else {
      const inferredEntry = inferBasicSysEntry(payload, loadAddress);
      if (inferredEntry !== undefined) pushUnique(inferredEntry);
      pushUnique(loadAddress);
    }

    let bestResult: ExomizerSfxDepackResult | undefined;
    let lastError: unknown;

    for (const entry of candidates) {
      try {
        const result = emulateSfxFromEntry({ payload, loadAddress, entryPoint: entry, maxInstructions });
        if (!bestResult || result.byteCount > bestResult.byteCount) {
          bestResult = result;
        }
        if (bestResult.byteCount >= SFX_OUTPUT_SANITY_THRESHOLD) {
          return bestResult;
        }
      } catch (error) {
        lastError = error;
      }
    }

    // None of the user/BASIC/load candidates produced a sane output —
    // scan the payload for plausible exomizer SFX prologue patterns and
    // try each one.
    if (options.entryAddress === undefined) {
      for (const entry of scanSfxPrologueCandidates(payload, loadAddress)) {
        if (candidates.includes(entry)) continue;
        try {
          const result = emulateSfxFromEntry({ payload, loadAddress, entryPoint: entry, maxInstructions });
          if (!bestResult || result.byteCount > bestResult.byteCount) {
            bestResult = result;
          }
          if (bestResult.byteCount >= SFX_OUTPUT_SANITY_THRESHOLD) {
            return bestResult;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (!bestResult) {
      throw lastError instanceof Error ? lastError : new Error("Exomizer SFX emulation produced no output.");
    }
    return bestResult;
  }
}
