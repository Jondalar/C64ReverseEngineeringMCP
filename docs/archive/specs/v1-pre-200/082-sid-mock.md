# Spec 082 — SID 6581/8580 mock register file

## Problem

Headless emulator currently has no SID at all. Reads from $D400-$D41F return whatever the I/O bus default returns ($00 / open bus). Games that:
- Set SID volume + check it back ($D418)
- Read $D41B (oscillator 3 output, "noise" — used as PRNG by many games)
- Read $D41C (envelope 3 output — used as ADSR-completion poll)
- Wait for ADSR phase changes

…hit dead reads → degenerate code paths or hangs. Goal: make all SID reads/writes functional enough that no game crashes or hangs polling SID, without producing audio.

## Decision

Implement a SID **register-file model** with:
- Latch-on-write for all 32 registers ($D400 + $D420/$D440/… mirrors).
- Realistic read behaviour for $D41B (osc3) + $D41C (env3): pseudo-LFSR for $D41B that updates per cycle, ADSR envelope counter ticks for $D41C.
- All other reads return latched value (or last-write of read-only register).
- Voice ADSR engine ticks per cycle, advances envelope state machine (attack→decay→sustain→release) following the values in $D405/$D406/$D40C/$D413 etc.
- No audio sample output. No filter modelling. No oscillator waveform synthesis.

This is enough so ADSR-polling games (Maniac Mansion, Last Ninja, Impossible Mission) progress.

## Scope

### Module: `src/runtime/headless/peripherals/sid.ts`

```ts
export class Sid6581 {
  private latch = new Uint8Array(32);
  private osc3Lfsr = 0xACE1;       // deterministic 16-bit LFSR seed
  private env3State: EnvState[] = [{phase:'release', value:0, ...}, ...];
  private cyclesAccum = 0;

  read(reg: number): number;
  write(reg: number, value: number): void;
  tick(cycles: number): void;
  reset(): void;
  snapshot(): SidSnapshot;
  restore(snap: SidSnapshot): void;
}
```

### Read semantics (per register)

| Reg     | Read return                                                      |
|---------|------------------------------------------------------------------|
| $D400-$D418 | last latch                                                  |
| $D419   | POT X — return $00 (no paddles)                                  |
| $D41A   | POT Y — return $00                                               |
| $D41B   | upper 8 bits of `osc3Lfsr` (advances every Φ2 cycle by 1 step)   |
| $D41C   | env3.value (0-255) — current ADSR envelope output for voice 3    |
| $D41D-$D41F | open bus → $00                                               |
| $D420-$D7FF | mirror of $D400 + (reg & 0x1F)                              |

### Write semantics

- All writes update the latch.
- Voice control register ($D404 / $D40B / $D412): GATE bit (bit 0) drives ADSR phase transitions.
  - GATE 0→1 → start ATTACK from current value (or 0 if released).
  - GATE 1→0 → start RELEASE from current value.
- ATTACK/DECAY/SUSTAIN/RELEASE registers ($D405/$D406, $D40C/$D40D, $D413/$D414) — stored, used by ADSR engine.

### ADSR engine (per voice, ticks per cycle)

- Standard 6581 ADSR rates table (16 entries for attack, 16 for decay+release). Cycles-per-step values from VICE `src/sid/fastsid.c` ADSR table.
- State: `phase` (attack|decay|sustain|release|idle), `value` (0-255 envelope counter).
- ATTACK: increment value by 1 per N cycles (N from rate table for attack value), saturate at 255 → DECAY.
- DECAY: exponential decrement (8-step approximation — VICE uses lookup table) toward sustain level, → SUSTAIN at sustain level.
- SUSTAIN: hold at sustain level (sustain register * 17 = 0..255).
- RELEASE: same as DECAY but toward 0 → IDLE.

### LFSR for $D41B

Galois LFSR, 16-bit: each cycle, `osc3Lfsr = (osc3Lfsr >> 1) ^ ((osc3Lfsr & 1) ? 0xB400 : 0)`. Seed deterministic (0xACE1) so runs reproducible.

### Wire-up

`integrated-session.ts`:
- Construct `sid = new Sid6581()`.
- Register I/O handlers $D400-$D7FF for reads/writes via `bus.registerIoHandler`.
- Per `stepC64Instruction()` and trap path, call `sid.tick(consumed)`.
- VSF snapshot include sid state; restore handles it.

## Out of scope (explicit)

- Audio sample generation (WAV / live audio).
- Filter modelling.
- Oscillator waveform synthesis (triangle/saw/pulse/noise) for $D41B is approximated by LFSR only — not real oscillator.
- 8580 vs 6581 differences (model 6581 for now).
- SID combined waveforms.
- Ring modulation, sync.

## Acceptance

- All MM SID reads/writes work; MM does not crash or hang on SID polling.
- ADSR envelope $D41C reaches 0 from 255 within reasonable cycle budget for given release rate.
- $D41B varies on every read after multiple cycles.
- Existing tests still pass.
- Smoke test: start session, write $0F to $D418, read back → $0F.
