// Spec 424 — Drive LED state + DOS error-blink detection.
//
// Tracks PB3 latch transitions (sourced from VIA2 PB write decoder
// via via2-gcr-shifter-coupling.ts:ledSink). Exposes:
//   - currentLedOn(): latest known on/off state
//   - isFlashing(currentClk): true if ≥3 PB3 edges within last 2M
//     drive cycles (= ~2 seconds at 1MHz). Matches 1541 DOS error
//     blink loop at $EBE7..$EC15 which toggles PB3 with ~0.5s period.
//
// Pure ring-buffer of edge timestamps; no allocation per edge.

const EDGE_WINDOW_CYCLES = 2_000_000; // ~2s at 1MHz drive clock
const FLASH_EDGE_THRESHOLD = 3;
const RING_SIZE = 16;

export class DriveLedMonitor {
  private ledOn = false;
  private edgeClks: Float64Array = new Float64Array(RING_SIZE);
  private edgeCount = 0;
  private edgeHead = 0;

  noteTransition(on: boolean, clk: number): void {
    this.ledOn = on;
    this.edgeClks[this.edgeHead] = clk;
    this.edgeHead = (this.edgeHead + 1) % RING_SIZE;
    if (this.edgeCount < RING_SIZE) this.edgeCount++;
  }

  currentLedOn(): boolean { return this.ledOn; }

  isFlashing(currentClk: number): boolean {
    if (this.edgeCount < FLASH_EDGE_THRESHOLD) return false;
    let recent = 0;
    for (let i = 0; i < this.edgeCount; i++) {
      if (currentClk - this.edgeClks[i]! <= EDGE_WINDOW_CYCLES) recent++;
    }
    return recent >= FLASH_EDGE_THRESHOLD;
  }

  reset(): void {
    this.ledOn = false;
    this.edgeCount = 0;
    this.edgeHead = 0;
  }
}
