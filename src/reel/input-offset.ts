// Spec 899 D1/D2 — where in the frame an input lands, and how that is chosen.
//
// A scripted press used to reach the machine at the cycle the previous step ended on, and
// that cycle is the same on every run: the game saw the key at the same beam position
// forever. An offset moves the press INSIDE the frame; `jitter_seed` gives every input step
// its own offset; a sweep walks the whole frame. Everything here is a pure function of
// (options, step index, frame length), so a run that failed can be run again with exactly
// the offsets it used — and the result lists them.

export interface InputOffsetOptions {
  /** Every input step presses this many cycles past the point it would have pressed at. */
  inputOffsetCycles?: number;
  /** Every input step gets its own offset in [0, one frame), derived from this seed and the step's index. */
  jitterSeed?: number;
}

/** Is either offset option in play? Without one, nothing about a run changes. */
export function offsetsRequested(o: InputOffsetOptions): boolean {
  return o.inputOffsetCycles !== undefined || o.jitterSeed !== undefined;
}

/** A refusal, or undefined when the options are usable. */
export function offsetRefusal(o: InputOffsetOptions): string | undefined {
  if (o.inputOffsetCycles !== undefined && o.jitterSeed !== undefined) {
    return "input_offset_cycles and jitter_seed are two ways to choose the offset — give one";
  }
  if (o.inputOffsetCycles !== undefined && (!Number.isSafeInteger(o.inputOffsetCycles) || o.inputOffsetCycles < 0)) {
    return `input_offset_cycles must be a whole number of cycles, 0 or more (got ${o.inputOffsetCycles})`;
  }
  if (o.jitterSeed !== undefined && !Number.isSafeInteger(o.jitterSeed)) {
    return `jitter_seed must be a whole number (got ${o.jitterSeed})`;
  }
  return undefined;
}

/** 32-bit integer finaliser (murmur3's), the whole of the "randomness": same input, same output. */
function mix32(x: number): number {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/**
 * The offset input step `stepIndex` uses, in cycles — or undefined when no offset option is
 * set (the step then presses exactly where it always did). A seeded offset depends on the
 * seed and the step's own index only, never on how many steps came before it or what they
 * did, so removing a wait does not reshuffle the presses.
 */
export function inputOffsetFor(o: InputOffsetOptions, stepIndex: number, cyclesPerFrame: number): number | undefined {
  if (o.inputOffsetCycles !== undefined) return o.inputOffsetCycles;
  if (o.jitterSeed !== undefined) {
    return mix32(mix32(o.jitterSeed | 0) ^ Math.imul(stepIndex + 1, 0x27d4eb2f)) % cyclesPerFrame;
  }
  return undefined;
}

/** `count` offsets spread evenly across one frame: i * frame / count, rounded down. */
export function sweepOffsets(count: number, cyclesPerFrame: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.floor((i * cyclesPerFrame) / count));
}


/** What one input step reports: the offset it used and the cycles it landed on. */
export interface InputRecord {
  /** Index of the step in the schedule. */
  readonly step: number;
  /** The step as written. */
  readonly text: string;
  /** Cycles past the point the step would have pressed at. */
  readonly offset: number;
  /** The absolute cycle the press was scheduled for. */
  readonly pressAt: number;
  /** For a hold of N frames: the cycle it lets go at. */
  readonly releaseAt?: number;
}
