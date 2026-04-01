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

export function analyzeIrqHandlerEvidence(
  instructions: InstructionFact[],
  hasVectorReference: boolean,
): IrqHandlerEvidence {
  let touchesRasterLine = false;
  let acknowledgesVicIrq = false;
  let chainsToKernalIrqTail = false;
  let savesOrRestoresRegisters = false;
  let directVicControlTouches = 0;

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const next = instructions[index + 1];

    if (instruction.targetAddress === 0xd012 || isImmediateStoreToAddress(instruction, next, 0xd012)) {
      touchesRasterLine = true;
    }
    if (instruction.targetAddress === 0xd019) {
      acknowledgesVicIrq = true;
    }
    if (
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
): boolean {
  const evidence = analyzeIrqHandlerEvidence(instructions, hasVectorReference);
  if (!evidence.hasVectorReference) {
    return false;
  }

  const coreSignals =
    Number(evidence.touchesRasterLine) +
    Number(evidence.acknowledgesVicIrq) +
    Number(evidence.chainsToKernalIrqTail);

  return coreSignals >= 2 || (coreSignals >= 1 && evidence.directVicControlTouches >= 3);
}
