// Spec 741 §3.2 — static relocation detection.
//
// Recognises copy loops that move a stored region to a runtime region
// (`LDA src,X / STA dst,X` style, optionally unrolled over pages) and the
// following `JMP`/`JSR` into the destination, and proposes the inferred
// {fileStart→runtimeAddr, length} as a relocation. Proposals are surfaced
// through propose_annotations; the accepted set feeds disasm_prg.relocations.
//
// This is deliberately generic — it keys off the existing decoded
// instruction stream, NOT any game-specific signature.

import { InstructionFact, IndexedRegister, MemoryMapping, RelocationProposal } from "./types";
import { formatAddress } from "./utils";

function isHardwareAddress(address: number): boolean {
  return address >= 0xd000 && address <= 0xdfff;
}

// Count how many of the sorted bases form a contiguous page walk
// (min, min+0x100, min+0x200, ...). 1 for a single base.
function countContiguousPages(sortedBases: number[]): number {
  let pages = 1;
  for (let i = 1; i < sortedBases.length; i += 1) {
    if (sortedBases[i] === sortedBases[0] + i * 0x100) pages += 1;
    else break;
  }
  return pages;
}

// Infer the per-page byte count of a copy loop from its bound:
//   - an in-loop `cpx/cpy #imm` (matching index reg) → imm (certain),
//   - else an up-counting `inx/iny + bne` wrapping a full page → 256,
//   - else a pre-loop `ldx/ldy #imm` down-count → imm (certain),
//   - else 256 (uncertain).
function inferPerPage(
  loopInstr: InstructionFact[],
  register: IndexedRegister,
  allSorted: InstructionFact[],
  loopStartAddress: number,
): { value: number; certain: boolean } {
  const cmpMnemonic = register === "x" ? "cpx" : "cpy";
  const compare = loopInstr.find((ins) => ins.mnemonic === cmpMnemonic && ins.addressingMode === "imm" && ins.operandValue !== undefined);
  if (compare && compare.operandValue !== undefined && compare.operandValue > 0) {
    return { value: compare.operandValue & 0xff || 256, certain: true };
  }

  const downCount = loopInstr.some((ins) => ins.mnemonic === (register === "x" ? "dex" : "dey"));
  if (downCount) {
    // nearest pre-loop immediate load of the same register
    const loadMnemonic = register === "x" ? "ldx" : "ldy";
    let best: InstructionFact | undefined;
    for (const ins of allSorted) {
      if (ins.address >= loopStartAddress) break;
      if (ins.mnemonic === loadMnemonic && ins.addressingMode === "imm" && ins.operandValue !== undefined) best = ins;
    }
    if (best && best.operandValue !== undefined && best.operandValue > 0) {
      return { value: best.operandValue, certain: true };
    }
  }

  // up-counting inx/iny + bne wraps a full page
  return { value: 256, certain: false };
}

export function detectRelocationProposals(instructions: InstructionFact[], mapping: MemoryMapping): RelocationProposal[] {
  const allSorted = [...instructions].sort((a, b) => a.address - b.address);
  const proposals: RelocationProposal[] = [];

  for (const branch of allSorted) {
    if (branch.addressingMode !== "rel" || branch.targetAddress === undefined || branch.targetAddress >= branch.address) {
      continue;
    }
    const loopStart = branch.targetAddress;
    const loopEnd = branch.address;
    const loopInstr = allSorted.filter((ins) => ins.address >= loopStart && ins.address <= loopEnd);
    if (loopInstr.length < 3 || loopInstr.length > 32) continue;

    const register: IndexedRegister | undefined =
      loopInstr.some((ins) => ins.mnemonic === "inx" || ins.mnemonic === "dex") ? "x"
        : loopInstr.some((ins) => ins.mnemonic === "iny" || ins.mnemonic === "dey") ? "y"
          : undefined;
    if (!register) continue;

    const mode = `abs,${register}`;
    const stores = loopInstr.filter(
      (ins) => ins.mnemonic.startsWith("st") && ins.addressingMode === mode && ins.targetAddress !== undefined && !isHardwareAddress(ins.targetAddress),
    );
    const reads = loopInstr.filter(
      (ins) => ins.mnemonic === "lda" && ins.addressingMode === mode && ins.targetAddress !== undefined && !isHardwareAddress(ins.targetAddress),
    );
    if (stores.length < 1 || reads.length < 1) continue;

    const destinationBases = Array.from(new Set(stores.map((ins) => ins.targetAddress!))).sort((l, r) => l - r);
    const sourceBases = Array.from(new Set(reads.map((ins) => ins.targetAddress!))).sort((l, r) => l - r);
    const src = sourceBases[0];
    const dst = destinationBases[0];
    if (src === dst) continue;

    const pages = Math.max(countContiguousPages(destinationBases), countContiguousPages(sourceBases));
    const perPage = inferPerPage(loopInstr, register, allSorted, loopStart);
    let length = (pages - 1) * 256 + perPage.value;

    let fileStart = src;
    let fileEnd = src + length - 1;
    if (fileStart < mapping.startAddress) continue;
    if (fileEnd > mapping.endAddress) {
      fileEnd = mapping.endAddress;
      length = fileEnd - fileStart + 1;
    }
    if (length <= 0) continue;

    // A following JMP/JSR into the destination confirms it is executed there.
    const followedByJump = allSorted.some(
      (ins) =>
        ins.address > loopEnd &&
        ins.address <= loopEnd + 64 &&
        (ins.mnemonic === "jmp" || ins.mnemonic === "jsr") &&
        ins.targetAddress !== undefined &&
        ins.targetAddress >= dst &&
        ins.targetAddress < dst + length,
    );

    const confirmed = branch.provenance === "confirmed_code";
    const confidence = Math.min(
      0.95,
      0.6 + (followedByJump ? 0.15 : 0) + (perPage.certain ? 0.05 : 0) + (confirmed ? 0.08 : 0) + (pages >= 2 ? 0.05 : 0),
    );

    proposals.push({
      fileStart,
      fileEnd,
      runtimeAddr: dst,
      length,
      indexRegister: register,
      confidence,
      followedByJump,
      lengthCertain: perPage.certain,
      source: "static-copy-loop",
      reasons: [
        `Copy loop at ${formatAddress(loopStart)}-${formatAddress(loopEnd)} moves ${formatAddress(src)} → ${formatAddress(dst)}.`,
        `${stores.length} indexed store(s), ${pages} page(s); inferred length ${length} byte(s)${perPage.certain ? " (from loop bound)" : " (page-wrap estimate — verify)"}.`,
        followedByJump
          ? `A following JMP/JSR targets the destination range, confirming it executes at ${formatAddress(dst)}.`
          : "No following JMP/JSR into the destination was seen near the loop; confirm the destination is executed.",
      ],
    });
  }

  // Dedupe identical proposals (confirmed + probable streams overlap); keep
  // the highest-confidence instance per (fileStart, runtimeAddr, length).
  const byKey = new Map<string, RelocationProposal>();
  for (const p of proposals) {
    const key = `${p.fileStart}:${p.runtimeAddr}:${p.length}`;
    const existing = byKey.get(key);
    if (!existing || p.confidence > existing.confidence) byKey.set(key, p);
  }
  return Array.from(byKey.values()).sort((a, b) => a.fileStart - b.fileStart);
}
