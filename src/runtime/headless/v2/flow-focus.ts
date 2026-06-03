// Spec 746.13 — MAIN/IRQ/NMI flow-focus, derive-at-read (OQ5 = A).
//
// The binary CPU firehose records only RETIRED instructions (CPU_STEP:
// cycle/pc/opcode/A/X/Y/SP/P) — no interrupt-entry marker. So we replay the
// Monitor's FlowTracker classification (Spec 623 §4.2, `stepping.ts:88-101`)
// over the recorded stream to derive a per-step flow lane. NO format change,
// ZERO hot-path cost (runs in the reader over existing `.c64retrace`).
//
// Detection (matching `stepOne`): between two consecutive retired instructions
// the stack pointer can only drop by exactly 3 via the hardware IRQ/NMI
// sequence or BRK (push PCH, PCL, P). Every other instruction's SP delta is
// fully determined by its own opcode. So:
//
//   delta = (prevSP + stackEffect(op) - SP) & 0xff
//   delta === 3 && op !== BRK  → a hardware IRQ/NMI was dispatched BEFORE this
//                                (first-handler) instruction
//   op === BRK ($00)           → software interrupt entry
//   op === RTI ($40)           → interrupt return (pop)
//
// 3-lane model (OQ5b): `main | irq | nmi`. BRK folds into `irq` (shares the
// $FFFE vector); `trap` is dropped (vestigial in the single-path runtime).
// NMI vs IRQ (OQ5a, derive-at-read, accept rare miss): NMI if the entry
// preempts an existing irq/nmi frame (only NMI can preempt IRQ) or matches a
// supplied NMI vector; else IRQ. An NMI taken directly from main flow with no
// vector hint classifies as `irq` — the documented A-limitation; the B-fallback
// (capture-time tag from `onInterruptServiced`, which knows the vector) is the
// exact path if this proves too coarse.
//
// Cold start: a slice that begins mid-handler has no stack history, so the
// first frame defaults to `main` (best-effort, same as FlowTracker's cold
// break — Spec 623 §4.3).

export type FlowKind = "main" | "irq" | "nmi";

const OP_BRK = 0x00;
const OP_JSR = 0x20;
const OP_PLP = 0x28;
const OP_RTI = 0x40;
const OP_PHA = 0x48;
const OP_RTS = 0x60;
const OP_PLA = 0x68;
const OP_PHP = 0x08;
const OP_TXS = 0x9a;

/** SP delta (post − pre) caused by an instruction's OWN execution. */
function stackEffect(op: number): number {
  switch (op) {
    case OP_PHA: case OP_PHP: return -1;
    case OP_PLA: case OP_PLP: return +1;
    case OP_JSR: return -2;
    case OP_RTS: return +2;
    case OP_RTI: return +3;
    case OP_BRK: return -3;
    default: return 0;
  }
}

export interface FlowStep {
  cycle: number;
  pc: number;
  opcode: number;
  sp: number;
}

export interface DeriveFlowOptions {
  /** If known, the NMI handler entry address (value at $FFFA/$FFFB). When the
   *  first handler instruction's PC matches it, the entry is classified `nmi`. */
  nmiVector?: number;
}

/**
 * Replay the FlowTracker classification over an ordered CPU_STEP stream and
 * return a per-cycle flow lane (`main|irq|nmi`). `steps` must be sorted by
 * cycle ascending and be the COMPLETE stream for the window (the derivation is
 * stateful — a filtered/sparse stream yields best-effort results only).
 */
export function deriveFlow(steps: FlowStep[], opts: DeriveFlowOptions = {}): Map<number, FlowKind> {
  const flowByCycle = new Map<number, FlowKind>();
  const stack: FlowKind[] = [];
  const current = (): FlowKind => (stack.length ? stack[stack.length - 1]! : "main");

  let prevSp: number | undefined;
  for (const s of steps) {
    const op = s.opcode & 0xff;
    const sp = s.sp & 0xff;

    // 1. Hardware IRQ/NMI dispatched before this (first-handler) instruction.
    //    TXS writes SP arbitrarily, so the delta is meaningless for it — skip.
    if (prevSp !== undefined && op !== OP_TXS && op !== OP_BRK) {
      const delta = (prevSp + stackEffect(op) - sp) & 0xff;
      if (delta === 3) {
        const isNmi =
          (opts.nmiVector !== undefined && (s.pc & 0xffff) === (opts.nmiVector & 0xffff))
          || current() !== "main"; // only NMI can preempt an IRQ/NMI frame
        stack.push(isNmi ? "nmi" : "irq");
      }
    }

    // 2. BRK = software interrupt entry (folds into irq, 3-lane model).
    if (op === OP_BRK) {
      stack.push("irq");
    }

    // 3. This instruction runs in the current (post-entry) flow.
    flowByCycle.set(s.cycle, current());

    // 4. RTI returns from the innermost interrupt frame — pop AFTER recording
    //    (the RTI instruction itself runs in the handler flow).
    if (op === OP_RTI && stack.length) {
      stack.pop();
    }

    prevSp = sp;
  }

  return flowByCycle;
}
