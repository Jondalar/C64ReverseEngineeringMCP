import { AnalyzerContext, CodeProvenance, HardwareWriteObservation, InstructionFact } from "./types";
import { toOffset } from "./utils";

export interface VicEvidence {
  bankBases: number[];
  bankSelectionConfirmed: boolean;
  screenAddresses: number[];
  charsetAddresses: number[];
  bitmapAddresses: number[];
  /**
   * Spec 816.2 — sprite DATA addresses read out of the sprite pointers.
   * Unlike every other field here these do not come from a register write:
   * the pointers live in memory at `screenBase+$3F8..$3FF`, so they are only
   * recoverable when the image actually contains that screen.
   */
  spriteDataAddresses: number[];
  bitmapModeEnabled: boolean;
  multicolorEnabled: boolean;
  spriteRegisterTouches: number;
  observedWrites: HardwareWriteObservation[];
}

export interface SidEvidence {
  writeInstructions: InstructionFact[];
  controlTouches: number;
  observedWrites: HardwareWriteObservation[];
}

export function isSpriteRegister(address: number): boolean {
  return address >= 0xd000 && address <= 0xd02e;
}

export function isSidRegister(address: number): boolean {
  return address >= 0xd400 && address <= 0xd418;
}

export function isVicGraphicsRegister(address: number): boolean {
  return address === 0xd011 || address === 0xd016 || address === 0xd018 || address === 0xdd00;
}

function isStoreTo(instruction: InstructionFact, address: number): boolean {
  return (
    (instruction.mnemonic === "sta" || instruction.mnemonic === "stx" || instruction.mnemonic === "sty") &&
    instruction.targetAddress === address
  );
}

function findImmediateBefore(instructions: InstructionFact[], index: number): number | undefined {
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 2; cursor -= 1) {
    const instruction = instructions[cursor];
    if (instruction.mnemonic === "lda" && instruction.addressingMode === "imm") {
      return instruction.operandValue;
    }
    if (instruction.isControlFlow) {
      break;
    }
  }
  return undefined;
}

function inferAccumulatorValue(instructions: InstructionFact[], index: number): HardwareWriteObservation["inferredValue"] {
  const start = Math.max(0, index - 8);
  let seedIndex = -1;
  let value: number | undefined;

  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    const instruction = instructions[cursor];
    if (instruction.mnemonic === "lda") {
      seedIndex = cursor;
      if (instruction.addressingMode === "imm" && instruction.operandValue !== undefined) {
        value = instruction.operandValue & 0xff;
      }
      break;
    }
  }

  if (seedIndex === -1 || value === undefined) {
    return undefined;
  }

  for (let cursor = seedIndex + 1; cursor < index; cursor += 1) {
    const instruction = instructions[cursor];
    if (instruction.mnemonic === "and" && instruction.addressingMode === "imm" && instruction.operandValue !== undefined) {
      value &= instruction.operandValue;
      continue;
    }

    if (instruction.mnemonic === "ora" && instruction.addressingMode === "imm" && instruction.operandValue !== undefined) {
      value |= instruction.operandValue;
      continue;
    }

    if (instruction.mnemonic === "eor" && instruction.addressingMode === "imm" && instruction.operandValue !== undefined) {
      value ^= instruction.operandValue;
      continue;
    }

    if (
      instruction.mnemonic === "sta" ||
      instruction.mnemonic === "stx" ||
      instruction.mnemonic === "sty" ||
      instruction.mnemonic === "cmp" ||
      instruction.mnemonic === "cpx" ||
      instruction.mnemonic === "cpy" ||
      instruction.mnemonic === "bit" ||
      instruction.mnemonic === "clc" ||
      instruction.mnemonic === "sec" ||
      instruction.mnemonic === "cli" ||
      instruction.mnemonic === "sei" ||
      instruction.mnemonic === "cld" ||
      instruction.mnemonic === "sed" ||
      instruction.mnemonic === "clv" ||
      instruction.mnemonic === "nop"
    ) {
      continue;
    }

    return undefined;
  }

  return value & 0xff;
}

function vicBankBaseFromDd00(value: number): number {
  return 0xc000 - ((value & 0x03) * 0x4000);
}

function instructionPools(context: AnalyzerContext): Array<{ source: CodeProvenance; instructions: InstructionFact[] }> {
  const pools: Array<{ source: CodeProvenance; instructions: InstructionFact[] }> = [];
  if (context.discoveredCode?.instructions.length) {
    pools.push({
      source: "confirmed_code",
      instructions: context.discoveredCode.instructions,
    });
  }
  if (context.probableCode?.instructions.length) {
    pools.push({
      source: "probable_code",
      instructions: context.probableCode.instructions,
    });
  }
  return pools;
}

export function extractVicEvidence(context: AnalyzerContext): VicEvidence {
  const bankBases = new Set<number>();
  let bankSelectionConfirmed = false;
  const screenAddresses = new Set<number>();
  const charsetAddresses = new Set<number>();
  const bitmapAddresses = new Set<number>();
  let bitmapModeEnabled = false;
  let multicolorEnabled = false;
  let spriteRegisterTouches = 0;
  const observedWrites: HardwareWriteObservation[] = [];

  for (const pool of instructionPools(context)) {
    const confidenceBias = pool.source === "confirmed_code" ? 0 : -0.18;
    for (let index = 0; index < pool.instructions.length; index += 1) {
      const instruction = pool.instructions[index];
      if (instruction.targetAddress !== undefined && isSpriteRegister(instruction.targetAddress)) {
        spriteRegisterTouches += 1;
      }

      if (isStoreTo(instruction, 0xd011)) {
        const value = inferAccumulatorValue(pool.instructions, index) ?? findImmediateBefore(pool.instructions, index);
        observedWrites.push({
          instructionAddress: instruction.address,
          registerAddress: 0xd011,
          inferredValue: value,
          confidence: value === undefined ? 0.45 + confidenceBias : 0.9 + confidenceBias,
          source: pool.source,
          note:
            value === undefined
              ? "Store seen, but accumulator value was not inferred exactly."
              : "Exact accumulator value inferred for VIC control write.",
        });
        if (value !== undefined && (value & 0x20) !== 0) {
          bitmapModeEnabled = true;
        }
      }

      if (isStoreTo(instruction, 0xd016)) {
        const value = inferAccumulatorValue(pool.instructions, index) ?? findImmediateBefore(pool.instructions, index);
        observedWrites.push({
          instructionAddress: instruction.address,
          registerAddress: 0xd016,
          inferredValue: value,
          confidence: value === undefined ? 0.45 + confidenceBias : 0.9 + confidenceBias,
          source: pool.source,
          note:
            value === undefined
              ? "Store seen, but accumulator value was not inferred exactly."
              : "Exact accumulator value inferred for VIC control write.",
        });
        if (value !== undefined && (value & 0x10) !== 0) {
          multicolorEnabled = true;
        }
      }

      if (isStoreTo(instruction, 0xdd00)) {
        const value = inferAccumulatorValue(pool.instructions, index) ?? findImmediateBefore(pool.instructions, index);
        observedWrites.push({
          instructionAddress: instruction.address,
          registerAddress: 0xdd00,
          inferredValue: value,
          confidence: value === undefined ? 0.45 + confidenceBias : 0.9 + confidenceBias,
          source: pool.source,
          note: value === undefined ? "CIA2/VIC bank store seen, but value is not exact." : "Exact VIC bank select value inferred.",
        });
        if (value !== undefined) {
          bankBases.add(vicBankBaseFromDd00(value));
          bankSelectionConfirmed = true;
        }
      }
    }
  }

  if (bankBases.size === 0) {
    bankBases.add(0x0000);
    bankBases.add(0x4000);
    bankBases.add(0x8000);
    bankBases.add(0xc000);
  }

  for (const pool of instructionPools(context)) {
    const confidenceBias = pool.source === "confirmed_code" ? 0 : -0.18;
    for (let index = 0; index < pool.instructions.length; index += 1) {
      const instruction = pool.instructions[index];
      if (!isStoreTo(instruction, 0xd018)) {
        continue;
      }

      const value = inferAccumulatorValue(pool.instructions, index) ?? findImmediateBefore(pool.instructions, index);
      if (value === undefined) {
        observedWrites.push({
          instructionAddress: instruction.address,
          registerAddress: 0xd018,
          confidence: 0.45 + confidenceBias,
          source: pool.source,
          note: "VIC memory-control store seen, but value is not exact.",
        });
        continue;
      }

      observedWrites.push({
        instructionAddress: instruction.address,
        registerAddress: 0xd018,
        inferredValue: value,
        confidence: 0.9 + confidenceBias,
        source: pool.source,
        note: "Exact VIC memory-control value inferred.",
      });

      for (const base of bankBases) {
        screenAddresses.add(base + ((value >> 4) & 0x0f) * 0x0400);
        charsetAddresses.add(base + ((value >> 1) & 0x07) * 0x0800);
        bitmapAddresses.add(base + ((value & 0x08) !== 0 ? 0x2000 : 0x0000));
      }
    }
  }

  // Spec 816.2. VIC fetches sprite data through eight pointers stored in the
  // last eight bytes of the video matrix: `spriteAddress = bankBase +
  // pointer × 64`. That is the only DIRECT evidence for where sprite data is,
  // and the sprite analyzer had none of it — it guessed a 64-byte phase out of
  // wherever code discovery happened to stop. This is the same move
  // charset-analyzer makes with $D018, one level deeper: the register gives
  // the screen, the screen gives the sprites.
  //
  // Deliberately permissive: a pointer is only a lead, so the recovered
  // addresses are offered to the analyzer as probe regions and still have to
  // pass its gate. Pointer 0 is skipped — it is the cleared value and aims at
  // the bank base, which is the screen itself or ROM, never sprite data.
  const spriteDataAddresses = new Set<number>();
  for (const screenBase of screenAddresses) {
    const pointerOffset = toOffset(screenBase + 0x03f8, context.mapping);
    if (pointerOffset === undefined || pointerOffset + 7 >= context.buffer.length) {
      continue;
    }
    const bankBase = screenBase & 0xc000;
    for (let slot = 0; slot < 8; slot += 1) {
      const pointer = context.buffer[pointerOffset + slot];
      if (pointer === undefined || pointer === 0) {
        continue;
      }
      const address = bankBase + pointer * 64;
      if (toOffset(address, context.mapping) === undefined || toOffset(address + 63, context.mapping) === undefined) {
        continue;
      }
      spriteDataAddresses.add(address);
    }
  }


  return {
    bankBases: Array.from(bankBases).sort((left, right) => left - right),
    bankSelectionConfirmed,
    screenAddresses: Array.from(screenAddresses).sort((left, right) => left - right),
    charsetAddresses: Array.from(charsetAddresses).sort((left, right) => left - right),
    bitmapAddresses: Array.from(bitmapAddresses).sort((left, right) => left - right),
    spriteDataAddresses: Array.from(spriteDataAddresses).sort((left, right) => left - right),
    bitmapModeEnabled,
    multicolorEnabled,
    spriteRegisterTouches,
    observedWrites,
  };
}

export function extractSidEvidence(context: AnalyzerContext): SidEvidence {
  const writes = instructionPools(context).flatMap((pool) =>
    pool.instructions.filter(
      (instruction) =>
        (instruction.mnemonic === "sta" || instruction.mnemonic === "stx" || instruction.mnemonic === "sty") &&
        instruction.targetAddress !== undefined &&
        isSidRegister(instruction.targetAddress),
    ),
  );
  const controlTouches = writes.filter((instruction) =>
    instruction.targetAddress !== undefined && [0xd404, 0xd40b, 0xd412, 0xd418].includes(instruction.targetAddress),
  ).length;
  const observedWrites: HardwareWriteObservation[] = writes.map((instruction) => ({
    instructionAddress: instruction.address,
    registerAddress: instruction.targetAddress ?? 0,
    confidence: instruction.provenance === "confirmed_code" ? 0.92 : 0.74,
    source: instruction.provenance,
    note:
      instruction.provenance === "confirmed_code"
        ? "Confirmed write into SID register space from discovered code."
        : "SID write observed in a structured but not recursively confirmed code island.",
  }));

  return {
    writeInstructions: writes,
    controlTouches,
    observedWrites,
  };
}
