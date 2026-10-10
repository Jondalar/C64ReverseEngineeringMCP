import type { PlatformTag } from "../lib/platform-kb";
import { InstructionFact } from "./types";

export interface IrqHandlerEvidence {
  hasVectorReference: boolean;
  touchesRasterLine: boolean;
  acknowledgesVicIrq: boolean;
  chainsToKernalIrqTail: boolean;
  savesOrRestoresRegisters: boolean;
  directVicControlTouches: number;
}

function isImmediateStoreToAddress(current: InstructionFact, next: InstructionFact | undefined, address: number): boolean {
  return (
    current.mnemonic === "lda" &&
    current.addressingMode === "imm" &&
    next?.mnemonic === "sta" &&
    next.targetAddress === address
  );
}

// The raster, acknowledge, KERNAL-tail and direct-control signals below are VIC-II / CIA2 /
// C64 KERNAL facts. On any other machine they do not exist, so they are never counted there.
export function analyzeIrqHandlerEvidence(
  instructions: InstructionFact[],
  hasVectorReference: boolean,
  platform: PlatformTag = "c64",
): IrqHandlerEvidence {
  const c64 = platform === "c64";
  let touchesRasterLine = false;
  let acknowledgesVicIrq = false;
  let chainsToKernalIrqTail = false;
  let savesOrRestoresRegisters = false;
  let directVicControlTouches = 0;

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const next = instructions[index + 1];

    if (c64 && (instruction.targetAddress === 0xd012 || isImmediateStoreToAddress(instruction, next, 0xd012))) {
      touchesRasterLine = true;
    }
    if (c64 && instruction.targetAddress === 0xd019) {
      acknowledgesVicIrq = true;
    }
    if (
      c64 &&
      instruction.mnemonic === "jmp" &&
      instruction.targetAddress !== undefined &&
      (instruction.targetAddress === 0xea31 || instruction.targetAddress === 0xea7e || instruction.targetAddress === 0xea81)
    ) {
      chainsToKernalIrqTail = true;
    }
    if (
      instruction.mnemonic === "pha" ||
      instruction.mnemonic === "pla" ||
      instruction.mnemonic === "php" ||
      instruction.mnemonic === "plp" ||
      instruction.mnemonic === "tsx" ||
      instruction.mnemonic === "txs"
    ) {
      savesOrRestoresRegisters = true;
    }
    if (
      c64 &&
      instruction.targetAddress !== undefined &&
      ((instruction.targetAddress >= 0xd000 && instruction.targetAddress <= 0xd02e) || instruction.targetAddress === 0xdd00)
    ) {
      directVicControlTouches += 1;
    }
  }

  return {
    hasVectorReference,
    touchesRasterLine,
    acknowledgesVicIrq,
    chainsToKernalIrqTail,
    savesOrRestoresRegisters,
    directVicControlTouches,
  };
}

export function isValidIrqHandler(
  instructions: InstructionFact[],
  hasVectorReference: boolean,
  platform: PlatformTag = "c64",
): boolean {
  // The judgement is "does this look like a C64 raster IRQ"; there is no such test for another machine.
  if (platform !== "c64") return true;
  const evidence = analyzeIrqHandlerEvidence(instructions, hasVectorReference, platform);
  if (!evidence.hasVectorReference) {
    return false;
  }

  const coreSignals =
    Number(evidence.touchesRasterLine) +
    Number(evidence.acknowledgesVicIrq) +
    Number(evidence.chainsToKernalIrqTail);

  return coreSignals >= 2 || (coreSignals >= 1 && evidence.directVicControlTouches >= 3);
}
