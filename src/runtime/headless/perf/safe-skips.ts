// Spec 135 (M8.3) v1 — fast-forward safe paths registry.
//
// Some C64 idle loops (KERNAL keyboard scan idle, BASIC READY wait)
// do not change externally visible state. This registry described a
// fast-forward optimisation for the (now-removed, Spec 723.3) fast-trap mode;
// it NEVER applied in true-drive where timing fidelity is the contract. The
// registry is retained only for its self-test (perf-ops-tests); it is not
// wired into the product step loop.

export interface SafeSkipPattern {
  name: string;
  pcMatcher: (pc: number) => boolean;
  // Per-cycle predicate: returns true if loop is provably idle.
  isIdle: (state: { pc: number; ramAt0291: number; ramAt00C5: number }) => boolean;
  // Cycles to fast-forward when activated.
  skipCycles: number;
}

export const SAFE_SKIP_REGISTRY: SafeSkipPattern[] = [
  // KERNAL keyboard polling at $E5CD..$E5E0: WAIT FOR KEY. RAM at
  // $00C5 = current matrix code; if 64 (no key), idle.
  {
    name: "kernal-kbd-idle",
    pcMatcher: (pc) => pc >= 0xE5CD && pc <= 0xE5E0,
    isIdle: ({ ramAt00C5 }) => ramAt00C5 === 64,
    skipCycles: 100,
  },
  // BASIC READY input loop $A483..$A4A2.
  {
    name: "basic-ready-loop",
    pcMatcher: (pc) => pc >= 0xA483 && pc <= 0xA4A2,
    isIdle: () => true,
    skipCycles: 100,
  },
];

export interface SafeSkipCounter {
  totalSkipped: number;
  byName: Map<string, number>;
}

export function newSafeSkipCounter(): SafeSkipCounter {
  return { totalSkipped: 0, byName: new Map() };
}

export function recordSkip(counter: SafeSkipCounter, name: string, cycles: number): void {
  counter.totalSkipped += cycles;
  counter.byName.set(name, (counter.byName.get(name) ?? 0) + cycles);
}
