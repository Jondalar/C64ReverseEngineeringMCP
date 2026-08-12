// Spec 623 §4.3 / 764 — shared backtrace builder. Scans the 6502 stack page for
// JSR return-address candidates (VICE-style best-guess after free-run) and lists
// the FlowTracker IRQ/NMI/BRK frames (exact, from stepping — more than VICE).
//
// Extracted so BOTH the monitor `bt` command and the JAM/BRK auto-break drop-in
// (Spec 764 P2) produce identical output, without the controller importing the
// monitor shell (no cycle). Loosely structurally typed to avoid importing the
// concrete IntegratedSession / FlowTracker types here.

export interface FlowFrame {
  kind: string;
  enteredAtPc: number;
}

interface BacktraceSession {
  c64Cpu: { sp: number };
  c64Bus: { peek(address: number, lens?: string): number };
}

const h = (n: number, w: number): string => (n & 0xffff).toString(16).padStart(w, "0").toUpperCase();

/** Build the backtrace lines (stack-scan candidates + exact flow frames). */
export function buildBacktrace(s: BacktraceSession, flowStack: readonly FlowFrame[]): string[] {
  const sp = s.c64Cpu.sp & 0xff;
  const lines: string[] = ["backtrace (live stack scan — best-effort; refine with `chis`):"];
  let found = 0;
  for (let a = 0x0100 + ((sp + 1) & 0xff); a <= 0x01ff && found < 16; a += 2) {
    const lo = s.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
    const hi = s.c64Bus.peek((a + 1) & 0xffff, "cpu") & 0xff;
    const ret = (((hi << 8) | lo) + 1) & 0xffff;
    lines.push(`  $${h(a, 4)}: -> $${h(ret, 4)}  (JSR return?)`);
    found++;
  }
  if (!found) lines.push("  (stack empty — SP at top)");
  if (flowStack.length) {
    lines.push("flow frames (exact, from stepping):");
    for (const fr of flowStack) lines.push(`  ${fr.kind} @ $${h(fr.enteredAtPc, 4)}`);
  }
  return lines;
}
