import { VicEvidence } from "./c64-hardware";
import {
  AnalyzerContext,
  CodeSemantics,
  DisplayRole,
  DisplayStateFact,
  DisplayTransferFact,
  IndirectPointerConstructionFact,
  InstructionFact,
  Segment,
} from "./types";
import { clampConfidence, formatAddress } from "./utils";

function confirmedInstructions(context: AnalyzerContext): InstructionFact[] {
  return [...(context.discoveredCode?.instructions ?? [])].sort((left, right) => left.address - right.address);
}

function confirmedCodeSegments(segments: Segment[]): Segment[] {
  return segments
    .filter((segment) => segment.kind === "code" || segment.kind === "basic_stub")
    .sort((left, right) => left.start - right.start);
}

function lastExactWriteBefore(
  registerAddress: number,
  address: number,
  vic: VicEvidence,
): number | undefined {
  const matches = vic.observedWrites
    .filter(
      (write) =>
        write.source === "confirmed_code" &&
        write.registerAddress === registerAddress &&
        write.instructionAddress <= address &&
        write.inferredValue !== undefined &&
        write.confidence >= 0.72,
    )
    .sort((left, right) => left.instructionAddress - right.instructionAddress);
  return matches.at(-1)?.inferredValue;
}

function deriveStateForSegment(segment: Segment, vic: VicEvidence): DisplayStateFact | undefined {
  const dd00 = lastExactWriteBefore(0xdd00, segment.end, vic);
  const d011 = lastExactWriteBefore(0xd011, segment.end, vic);
  const d016 = lastExactWriteBefore(0xd016, segment.end, vic);
  const d018 = lastExactWriteBefore(0xd018, segment.end, vic);

  if (dd00 === undefined && d011 === undefined && d016 === undefined && d018 === undefined) {
    return undefined;
  }

  const bankBase = dd00 !== undefined ? 0xc000 - ((dd00 & 0x03) * 0x4000) : undefined;
  const screenAddress = bankBase !== undefined && d018 !== undefined ? bankBase + (((d018 >> 4) & 0x0f) * 0x0400) : undefined;
  const charsetAddress = bankBase !== undefined && d018 !== undefined ? bankBase + (((d018 >> 1) & 0x07) * 0x0800) : undefined;
  const bitmapAddress =
    bankBase !== undefined && d018 !== undefined ? bankBase + ((d018 & 0x08) !== 0 ? 0x2000 : 0x0000) : undefined;
  const bitmapModeEnabled = d011 !== undefined ? (d011 & 0x20) !== 0 : undefined;
  const multicolorEnabled = d016 !== undefined ? (d016 & 0x10) !== 0 : undefined;

  return {
    start: segment.start,
    end: segment.end,
    bankBase,
    screenAddress,
    charsetAddress,
    bitmapAddress,
    bitmapModeEnabled,
    multicolorEnabled,
    confidence: clampConfidence(
      0.58 +
        (bankBase !== undefined ? 0.1 : 0) +
        (screenAddress !== undefined ? 0.08 : 0) +
        (bitmapAddress !== undefined ? 0.08 : 0) +
        (bitmapModeEnabled !== undefined ? 0.06 : 0) +
        (multicolorEnabled !== undefined ? 0.04 : 0),
    ),
    reasons: [
      bankBase !== undefined
        ? `Last exact $DD00 write before this segment selects VIC bank ${formatAddress(bankBase)}.`
        : "No exact VIC bank select was recovered before this segment.",
      screenAddress !== undefined
        ? `Last exact $D018 write before this segment implies screen RAM at ${formatAddress(screenAddress)}.`
        : "No exact screen-memory select was recovered before this segment.",
      bitmapAddress !== undefined && bitmapModeEnabled
        ? `Bitmap mode is active with bitmap base ${formatAddress(bitmapAddress)}.`
        : bitmapAddress !== undefined
          ? `A bitmap base ${formatAddress(bitmapAddress)} is implied by $D018, but bitmap mode is not confirmed here.`
          : "No exact bitmap/charset base was recovered before this segment.",
    ],
  };
}

function instructionsForSegment(segment: Segment, instructions: InstructionFact[]): InstructionFact[] {
  return instructions.filter((instruction) => instruction.address >= segment.start && instruction.address <= segment.end);
}

function helperCallAfter(
  fact: IndirectPointerConstructionFact,
  instructions: InstructionFact[],
): InstructionFact | undefined {
  const window = instructions.filter(
    (instruction) =>
      instruction.address > fact.end &&
      instruction.address <= fact.end + 16 &&
      instruction.mnemonic === "jsr" &&
      instruction.targetAddress !== undefined,
  );
  return window[0];
}

function inferDisplayRole(destinationAddress: number, state: DisplayStateFact | undefined): DisplayRole {
  if (destinationAddress >= 0xd800 && destinationAddress <= 0xdbe7) {
    return "color";
  }
  if (!state) {
    return "unknown";
  }
  if (state.bitmapAddress !== undefined && destinationAddress >= state.bitmapAddress && destinationAddress < state.bitmapAddress + 0x2000) {
    return "bitmap";
  }
  if (state.screenAddress !== undefined && destinationAddress >= state.screenAddress && destinationAddress < state.screenAddress + 0x0400) {
    return "screen";
  }
  if (state.charsetAddress !== undefined && destinationAddress >= state.charsetAddress && destinationAddress < state.charsetAddress + 0x0800) {
    return "charset";
  }
  return "unknown";
}

function findTransferPairs(
  segment: Segment,
  state: DisplayStateFact | undefined,
  semantics: CodeSemantics,
  instructions: InstructionFact[],
): DisplayTransferFact[] {
  const pointerFacts = semantics.indirectPointers
    .filter(
      (fact) =>
        fact.provenance === "confirmed_code" &&
        fact.constantTarget !== undefined &&
        fact.start >= segment.start &&
        fact.start <= segment.end,
    )
    .sort((left, right) => left.start - right.start);

  const transfers: DisplayTransferFact[] = [];

  for (let index = 0; index < pointerFacts.length - 1; index += 1) {
    const source = pointerFacts[index];
    const destination = pointerFacts[index + 1];
    if (source.constantTarget === undefined || destination.constantTarget === undefined) {
      continue;
    }
    if (destination.start - source.start > 0x20) {
      continue;
    }
    if (destination.zeroPageBase !== ((source.zeroPageBase + 2) & 0xff)) {
      continue;
    }

    const helper = helperCallAfter(destination, instructions);
    const role = inferDisplayRole(destination.constantTarget, state);
    if (role === "unknown" && helper === undefined) {
      continue;
    }

    transfers.push({
      start: source.start,
      end: helper?.address ?? destination.end,
      destinationSetupAddress: destination.start,
      sourceAddress: source.constantTarget,
      destinationAddress: destination.constantTarget,
      sourcePointerBase: source.zeroPageBase,
      destinationPointerBase: destination.zeroPageBase,
      helperRoutine: helper?.targetAddress,
      helperCallAddress: helper?.address,
      role,
      confidence: clampConfidence(
        0.72 +
          (role !== "unknown" ? 0.1 : 0) +
          (helper !== undefined ? 0.08 : 0) +
          (destination.start - source.start <= 0x10 ? 0.04 : 0),
      ),
      reasons: [
        `Constant source pointer ${formatAddress(source.constantTarget)} is followed by destination pointer ${formatAddress(destination.constantTarget)} using adjacent zero-page pairs.`,
        helper?.targetAddress !== undefined
          ? `The pair is consumed by JSR ${formatAddress(helper.targetAddress)} immediately afterwards.`
          : "No helper call was found immediately after the pointer setup pair.",
        role !== "unknown"
          ? `Destination falls inside the active ${role} display region for this segment.`
          : "Destination does not yet match a proven display target exactly.",
      ],
    });
  }

  return transfers;
}

export function extractDisplaySemantics(
  context: AnalyzerContext,
  semantics: CodeSemantics,
  vic: VicEvidence,
  segments: Segment[],
): Pick<CodeSemantics, "displayStates" | "displayTransfers"> {
  const instructions = confirmedInstructions(context);
  const displayStates: DisplayStateFact[] = [];
  const displayTransfers: DisplayTransferFact[] = [];

  for (const segment of confirmedCodeSegments(segments)) {
    const state = deriveStateForSegment(segment, vic);
    if (state) {
      displayStates.push(state);
    }

    const segmentInstructionsList = instructionsForSegment(segment, instructions);
    displayTransfers.push(...findTransferPairs(segment, state, semantics, segmentInstructionsList));
  }

  return {
    displayStates,
    displayTransfers,
  };
}
