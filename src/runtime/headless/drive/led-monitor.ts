// Spec 424 — Drive LED state, 1:1 VICE model.
//
// Cite: src/drive/drive.c:870-931 drive_update_ui_status_for_drive():
//   - Accumulate `led_active_ticks` while led_status bit 0 set.
//   - Each UI poll: compute PWM duty 0..1000 from active_ticks / period.
//   - sqrt curve for perceptual brightness.
//   - Result: fast PB3 toggles average to a smooth brightness — exactly
//     what real 1541 LED + human eye do.
//
// Replaces earlier on/off + flash-detection heuristic. The VICE model
// inherently captures both:
//   - DOS-active (PB3 steady high)            → PWM ≈ 1000 (bright)
//   - Fastloader fast toggle (PB3 strobe)     → PWM ≈ 500 (medium)
//   - DOS error blink (PB3 ~2Hz on/off)       → PWM oscillates 0↔1000
//                                               per UI poll
//   - Idle (PB3 low)                           → PWM = 0
//
// Caller polls `sampleAndReset(currentClk)` once per UI tick (= ~250ms).
// Returns { pwm: 0..1000, on: boolean } where:
//   - pwm = perceptual brightness 0..1000
//   - on  = raw latch state at sample time (= PB3 currently high)

const MAX_PWM = 1000;

export class DriveLedMonitor {
  /** Raw PB3 latch state (= true if last write set PB3 high). */
  private ledOn = false;
  /** Cycle accumulator while ledOn. Reset on each sample. */
  private ledActiveTicks = 0;
  /** Last clk seen — for delta calc. */
  private lastChangeClk = 0;
  /** Last clk a sample was taken. */
  private lastSampleClk = 0;
  /** Cached PWM from most recent sample (for repeated reads between
   *  polls — keeps UI stable between WS frames). */
  private lastPwm = 0;

  /**
   * Note a PB3 transition. Fold accumulated ticks since last change.
   * VICE drive.c:889-893: if led_status & 1, accumulate (clk - last).
   */
  noteTransition(on: boolean, clk: number): void {
    if (this.ledOn) {
      this.ledActiveTicks += clk - this.lastChangeClk;
    }
    this.lastChangeClk = clk;
    this.ledOn = on;
  }

  /** Raw latch state — true if PB3 last set high. */
  currentLedOn(): boolean { return this.ledOn; }

  /**
   * Sample PWM brightness + reset accumulator. VICE drive.c:880-922
   * shape. Returns:
   *   pwm: 0..1000 perceptual brightness (with sqrt curve).
   *   on:  raw current PB3 latch.
   *
   * Call once per UI poll. The cached PWM from the most recent call
   * is returned by peekPwm() for repeated reads between polls.
   */
  sampleAndReset(currentClk: number): { pwm: number; on: boolean } {
    // Fold partial-period ticks if currently on.
    if (this.ledOn) {
      this.ledActiveTicks += currentClk - this.lastChangeClk;
      this.lastChangeClk = currentClk;
    }
    const ledPeriod = currentClk - this.lastSampleClk;
    this.lastSampleClk = currentClk;
    if (ledPeriod === 0) {
      return { pwm: this.lastPwm, on: this.ledOn };
    }
    let pwm: number;
    if (this.ledActiveTicks > ledPeriod) {
      pwm = MAX_PWM;
    } else {
      const raw = (this.ledActiveTicks * MAX_PWM) / ledPeriod;
      // sqrt curve for human-eye brightness perception (VICE
      // drive.c:914-915).
      pwm = Math.round(MAX_PWM * Math.sqrt(raw / MAX_PWM));
      if (pwm > MAX_PWM) pwm = MAX_PWM;
    }
    this.ledActiveTicks = 0;
    this.lastPwm = pwm;
    return { pwm, on: this.ledOn };
  }

  /** Most recent PWM without resetting state (= cheap polls between samples). */
  peekPwm(): number { return this.lastPwm; }

  reset(): void {
    this.ledOn = false;
    this.ledActiveTicks = 0;
    this.lastChangeClk = 0;
    this.lastSampleClk = 0;
    this.lastPwm = 0;
  }
}
