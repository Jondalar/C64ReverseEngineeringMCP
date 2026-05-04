// SID 6581 register-file model (Spec 082).
//
// Mock — no audio output. Implements:
// - Latch-on-write for all 32 registers $D400-$D41F (mirrored $D420-$D7FF).
// - $D41B (osc3 noise) → 16-bit Galois LFSR upper byte, advances per cycle.
// - $D41C (env3) → ADSR envelope counter for voice 3, ticks per cycle.
// - ADSR engine for all 3 voices: GATE bit transitions A→D→S→R.
// - Read $D419/$D41A (POT X/Y) → 0 (no paddles).
//
// Out of scope: oscillator waveforms, filter, audio sample generation.

const NUM_REGS = 32;
const NUM_VOICES = 3;

// VICE fastsid attack rate table (cycles per envelope step).
// Index = ATTACK 4-bit value (0-15).
const ATTACK_RATE_CYCLES = [
  9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
];

// Decay/Release rate table (cycles per step). 3× attack rate per VICE model.
const DECAY_RELEASE_RATE_CYCLES = ATTACK_RATE_CYCLES.map((c) => c * 3);

interface VoiceEnv {
  phase: "idle" | "attack" | "decay" | "sustain" | "release";
  value: number;            // 0-255 envelope output
  cycleAccum: number;       // sub-cycle accumulator
  prevGate: boolean;
}

export interface SidSnapshot {
  regs: number[];
  osc3Lfsr: number;
  envs: VoiceEnv[];
}

export class Sid6581 {
  public readonly regs = new Uint8Array(NUM_REGS);
  // Spec 108 (M2.6c) v1: POT readback bridge. Caller (session) sets
  // a getter that returns paddle values 0..3 (POTAX, POTAY, POTBX,
  // POTBY). Real HW has $D419 = port A, $D41A = port B; only one
  // paddle per port routes through internally — we expose paddle 0
  // → $D419 and paddle 2 → $D41A by default.
  public potReader?: (idx: 0 | 1) => number;
  private osc3Lfsr = 0xACE1;     // deterministic seed
  private envs: VoiceEnv[] = [];

  constructor() {
    for (let v = 0; v < NUM_VOICES; v++) {
      this.envs.push({ phase: "idle", value: 0, cycleAccum: 0, prevGate: false });
    }
  }

  reset(): void {
    this.regs.fill(0);
    this.osc3Lfsr = 0xACE1;
    for (const env of this.envs) {
      env.phase = "idle"; env.value = 0; env.cycleAccum = 0; env.prevGate = false;
    }
  }

  // Read a SID register. Mirrors handled by caller (addr & 0x1F).
  read(reg: number): number {
    const r = reg & 0x1F;
    switch (r) {
      case 0x19: return (this.potReader?.(0) ?? 0) & 0xFF; // POT X (port A)
      case 0x1A: return (this.potReader?.(1) ?? 0) & 0xFF; // POT Y (port B)
      case 0x1B: return (this.osc3Lfsr >> 8) & 0xFF;  // osc3
      case 0x1C: return this.envs[2]!.value & 0xFF;   // env3
      case 0x1D: case 0x1E: case 0x1F: return 0; // open bus
      default:   return this.regs[r]!;
    }
  }

  write(reg: number, value: number): void {
    const r = reg & 0x1F;
    const prev = this.regs[r]!;
    this.regs[r] = value & 0xFF;
    // Voice control register at offsets 4, 11 ($0B), 18 ($12) — GATE bit 0.
    const voiceCtrlOffsets = [0x04, 0x0B, 0x12];
    const voiceIdx = voiceCtrlOffsets.indexOf(r);
    if (voiceIdx >= 0) {
      const env = this.envs[voiceIdx]!;
      const newGate = (value & 0x01) !== 0;
      if (newGate && !env.prevGate) {
        env.phase = "attack";
        env.cycleAccum = 0;
      } else if (!newGate && env.prevGate) {
        env.phase = "release";
        env.cycleAccum = 0;
      }
      env.prevGate = newGate;
      void prev;
    }
  }

  // Tick the SID by N cycles. Advances LFSR + ADSR envelopes.
  tick(cycles: number): void {
    // LFSR step per cycle (cheap).
    for (let i = 0; i < cycles; i++) {
      const bit = this.osc3Lfsr & 1;
      this.osc3Lfsr = (this.osc3Lfsr >>> 1) ^ (bit ? 0xB400 : 0);
    }
    // ADSR step per voice.
    for (let v = 0; v < NUM_VOICES; v++) {
      this.tickEnvelope(v, cycles);
    }
  }

  private tickEnvelope(voiceIdx: number, cycles: number): void {
    const env = this.envs[voiceIdx]!;
    if (env.phase === "idle" || env.phase === "sustain") {
      // Sustain holds at sustain level (recompute in case sustain changed).
      if (env.phase === "sustain") {
        const sustainReg = this.regs[6 + voiceIdx * 7]!;  // AD at +5, SR at +6 within voice block
        const sustainNibble = (sustainReg >> 4) & 0x0F;
        env.value = sustainNibble * 17; // 0..255
      }
      return;
    }
    const baseReg = voiceIdx * 7;
    const adReg = this.regs[baseReg + 5]!;
    const srReg = this.regs[baseReg + 6]!;
    const attackIdx = (adReg >> 4) & 0x0F;
    const decayIdx = adReg & 0x0F;
    const sustainNibble = (srReg >> 4) & 0x0F;
    const releaseIdx = srReg & 0x0F;
    const sustainLevel = sustainNibble * 17;
    let cyclesLeft = cycles;
    while (cyclesLeft > 0) {
      let rate: number;
      switch (env.phase) {
        case "attack":  rate = ATTACK_RATE_CYCLES[attackIdx]!; break;
        case "decay":   rate = DECAY_RELEASE_RATE_CYCLES[decayIdx]!; break;
        case "release": rate = DECAY_RELEASE_RATE_CYCLES[releaseIdx]!; break;
        default: return;
      }
      const cyclesToStep = rate - env.cycleAccum;
      if (cyclesLeft < cyclesToStep) {
        env.cycleAccum += cyclesLeft;
        return;
      }
      cyclesLeft -= cyclesToStep;
      env.cycleAccum = 0;
      // Step envelope value.
      switch (env.phase) {
        case "attack":
          env.value = Math.min(255, env.value + 1);
          if (env.value >= 255) { env.phase = "decay"; env.cycleAccum = 0; }
          break;
        case "decay":
          if (env.value <= sustainLevel) {
            env.phase = "sustain";
            env.value = sustainLevel;
            return;
          }
          env.value = Math.max(0, env.value - 1);
          break;
        case "release":
          if (env.value <= 0) {
            env.phase = "idle"; env.value = 0; return;
          }
          env.value = Math.max(0, env.value - 1);
          break;
      }
    }
  }

  snapshot(): SidSnapshot {
    return {
      regs: Array.from(this.regs),
      osc3Lfsr: this.osc3Lfsr,
      envs: this.envs.map((e) => ({ ...e })),
    };
  }

  restore(snap: SidSnapshot): void {
    for (let i = 0; i < NUM_REGS; i++) this.regs[i] = snap.regs[i] ?? 0;
    this.osc3Lfsr = snap.osc3Lfsr;
    for (let v = 0; v < NUM_VOICES; v++) {
      this.envs[v] = { ...snap.envs[v]! };
    }
  }
}

// Install SID I/O handlers $D400-$D7FF (with mirror).
export function installSid(bus: { registerIoHandler(addr: number, h: { read: (a: number) => number; write: (a: number, v: number) => void }): void }): Sid6581 {
  const sid = new Sid6581();
  for (let a = 0xD400; a < 0xD800; a++) {
    bus.registerIoHandler(a, {
      read: () => sid.read(a),
      write: (_addr, value) => sid.write(a, value),
    });
  }
  return sid;
}
