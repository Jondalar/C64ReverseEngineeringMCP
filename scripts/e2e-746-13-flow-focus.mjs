// Spec 746.13 — derive-at-read MAIN/IRQ/NMI flow-focus. The reader replays the
// FlowTracker classification over a CPU_STEP stream (cycle/pc/opcode/sp) and
// labels each step main|irq|nmi via the SP-delta-3 interrupt detector.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 746.13 — flow-focus derive-at-read (main/irq/nmi)\n");

const { deriveFlow } = await import(`${ROOT}/dist/runtime/headless/v2/flow-focus.js`);

const NOP = 0xea, PHA = 0x48, PLA = 0x68, TXA = 0x8a, RTI = 0x40, BRK = 0x00;
const s = (cycle, pc, opcode, sp) => ({ cycle, pc, opcode, sp });
const lane = (map, cyc) => map.get(cyc);

// ── 1. Single IRQ: main → handler (SP-3 entry) → RTI → main ──────────────────
// SP bookkeeping: main sp=0xFF; hw int pushes 3 → 0xFC; handler PHA/.../PLA;
// RTI pulls 3 → 0xFF.
{
  const stream = [
    s(0, 0x1000, NOP, 0xff),  // main
    s(2, 0x1001, NOP, 0xff),  // main
    s(4, 0xff48, PHA, 0xfb),  // IRQ entry: delta=(0xFF-1-0xFB)=3 → irq
    s(6, 0xff49, TXA, 0xfb),  // irq
    s(8, 0xff4a, PHA, 0xfa),  // irq
    s(10, 0xff60, PLA, 0xfb), // irq
    s(11, 0xff61, PLA, 0xfc), // irq (sp back to 0xFC)
    s(12, 0xff62, RTI, 0xff), // irq (record), then pop
    s(14, 0x1002, NOP, 0xff), // main
  ];
  const f = deriveFlow(stream);
  ok(lane(f, 0) === "main" && lane(f, 2) === "main", "1 pre-IRQ steps = main");
  ok(lane(f, 4) === "irq", "1 SP-3 entry → first handler instr = irq", `got ${lane(f, 4)}`);
  ok(lane(f, 6) === "irq" && lane(f, 8) === "irq" && lane(f, 10) === "irq" && lane(f, 11) === "irq", "1 handler body = irq");
  ok(lane(f, 12) === "irq", "1 RTI itself runs in irq flow");
  ok(lane(f, 14) === "main", "1 after RTI → back to main", `got ${lane(f, 14)}`);
}

// ── 2. BRK → irq (3-lane model folds brk into irq) ───────────────────────────
{
  const stream = [
    s(0, 0x2000, NOP, 0xff),  // main
    s(2, 0x2001, BRK, 0xfc),  // BRK entry (pushes 3) → irq
    s(4, 0xff48, NOP, 0xfc),  // irq
    s(6, 0xff49, RTI, 0xff),  // irq, then pop
    s(8, 0x2003, NOP, 0xff),  // main
  ];
  const f = deriveFlow(stream);
  ok(lane(f, 0) === "main", "2 pre-BRK = main");
  ok(lane(f, 2) === "irq", "2 BRK instruction → irq (folded)", `got ${lane(f, 2)}`);
  ok(lane(f, 4) === "irq", "2 BRK handler = irq");
  ok(lane(f, 8) === "main", "2 after RTI → main");
}

// ── 3. Nested NMI during IRQ (NMI preempts an irq frame → nmi) ───────────────
// main sp=0xFF; IRQ pushes 3→0xFC, PHA→0xFB; NMI pushes 3→0xF8, PHA→0xF7;
// NMI PLA→0xF8, RTI pulls 3→0xFB; back in IRQ; IRQ RTI pulls (sp→0xFF).
{
  const stream = [
    s(0, 0x1000, NOP, 0xff),  // main
    s(2, 0xff48, PHA, 0xfb),  // IRQ entry: delta=(0xFF-1-0xFB)=3 → irq
    s(4, 0xff49, NOP, 0xfb),  // irq
    s(6, 0xfe43, PHA, 0xf7),  // NMI entry while in irq: delta=(0xFB-1-0xF7)=3, current=irq → nmi
    s(8, 0xfe44, PLA, 0xf8),  // nmi
    s(10, 0xfe45, RTI, 0xfb), // nmi (record), pop → irq
    s(12, 0xff4a, NOP, 0xfb), // irq
    s(14, 0xff4b, PLA, 0xfc), // irq
    s(15, 0xff4c, RTI, 0xff), // irq, pop → main
    s(16, 0x1001, NOP, 0xff), // main
  ];
  const f = deriveFlow(stream);
  ok(lane(f, 2) === "irq", "3 outer = irq");
  ok(lane(f, 6) === "nmi", "3 NMI preempting irq → nmi", `got ${lane(f, 6)}`);
  ok(lane(f, 8) === "nmi" && lane(f, 10) === "nmi", "3 NMI body = nmi");
  ok(lane(f, 12) === "irq" && lane(f, 15) === "irq", "3 back to irq after NMI RTI", `12=${lane(f, 12)} 15=${lane(f, 15)}`);
  ok(lane(f, 16) === "main", "3 back to main after IRQ RTI");
}

// ── 4. NMI vector hint classifies an NMI-from-main correctly ─────────────────
{
  const stream = [
    s(0, 0x1000, NOP, 0xff),  // main
    s(2, 0xfe43, PHA, 0xfb),  // entry from main; with nmiVector hint → nmi
    s(4, 0xfe44, RTI, 0xff),  // nmi, pop
    s(6, 0x1001, NOP, 0xff),  // main
  ];
  const noHint = deriveFlow(stream);
  ok(noHint.get(2) === "irq", "4a NMI-from-main w/o hint defaults to irq (documented A-limit)", `got ${noHint.get(2)}`);
  const withHint = deriveFlow(stream, { nmiVector: 0xfe43 });
  ok(withHint.get(2) === "nmi", "4b NMI-from-main WITH nmiVector hint → nmi", `got ${withHint.get(2)}`);
}

// ── 5. No interrupts → all main; cold-start mid-handler defaults to main ─────
{
  const f = deriveFlow([s(0, 0x800, NOP, 0xff), s(2, 0x801, NOP, 0xff), s(4, 0x802, NOP, 0xff)]);
  ok([0, 2, 4].every((c) => f.get(c) === "main"), "5 no interrupts → all main");
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 746.13 flow-focus: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
