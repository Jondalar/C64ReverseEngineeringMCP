// Spec 611 phase 611.4 — minimal IEC bus model for VICE1541.
//
// VICE source:  src/iecbus/iecbus.c + src/c64/c64iec.c
// Doc anchor:   docs/vice-iec-arc42.md §5.1 + §5.5 + §6
//
// Single-drive (unit 0) only. Burst mode out of scope (Spec 611 §"Out
// of scope"). Wired-AND open-collector semantics per arch doc.
//
// Polarity (matches Spec 611 §3a Drive1541 interface convention):
//   bus_atn / bus_clk / bus_data : true = released (high), false = pulled low
//
// VICE internals here use the "released" flag form rather than the
// VICE raw byte layout (which packs ATN/CLK/DATA across two bytes
// via `iec_update_cpu_bus` shifts). The PB read formula in via1d.ts
// converts to/from the VICE byte layout at the boundary.

/** Per-unit drive PB output snapshot (released-flag form). */
export interface DriveBusContrib {
  /** Drive pulls DATA low when this is false; releases when true. */
  drvDataReleased: boolean;
  /** Drive pulls CLK low when false; releases when true. */
  drvClkReleased: boolean;
  /** Drive asserts ATNA (drive-side ATN ack) when false; releases when true. */
  drvAtnaReleased: boolean;
}

/** C64-side line state (released = high). */
export interface C64BusContrib {
  busAtnReleased: boolean;
  busClkReleased: boolean;
  busDataReleased: boolean;
}

/**
 * Single-drive IEC bus. Track 1541's contribution (unit 0) + C64's
 * contribution. Combined line state = wired-AND of both (open
 * collector — line is high iff every driver releases it).
 *
 * Phase 611.4 does not model the ATNA-AND-gate fully (see VICE
 * `iec_update_ports` in iecbus.c). The simplification: combined
 * `bus_data_combined = c64DataReleased && drvDataReleased && drvAtnaReleased`
 * captures the dominant case (ATN auto-pull through ATNA) for the
 * 1541-only setup. Refined in 611.5+ if the simplification breaks
 * the synthetic ATN/CA1 acceptance.
 */
export class Vice1541IecBus {
  // C64-side state — written by Vice1541.iecLineDrive().
  c64AtnReleased: boolean = true;
  c64ClkReleased: boolean = true;
  c64DataReleased: boolean = true;

  // Drive-side contribution — written by via1d.ts on PB write.
  drvDataReleased: boolean = true;
  drvClkReleased: boolean = true;
  drvAtnaReleased: boolean = true;

  /** Combined ATN-line state. ATN is C64-driven only. */
  busAtn(): boolean { return this.c64AtnReleased; }

  /** Combined CLK-line state (wired-AND). */
  busClk(): boolean { return this.c64ClkReleased && this.drvClkReleased; }

  /** Combined DATA-line state (wired-AND, includes ATNA-AND gate). */
  busData(): boolean {
    // Per VICE iec_update_ports: drive DATA is logical-ANDed with the
    // drive's ATNA, so the drive auto-pulls DATA whenever its ATNA
    // says "I haven't acknowledged ATN yet" (or whenever ATN is low).
    const drvDataEffective = this.drvDataReleased || (this.busAtn() && this.drvAtnaReleased);
    return this.c64DataReleased && drvDataEffective;
  }

  /**
   * Compute drv_port byte per VICE: low nibble of the drive's
   * combined-bus view, packed into the bit positions the VIA1 PB
   * read formula expects. See arch doc §6.4 + iec-arc42 §5.5.
   *
   * Bit layout (drv_port, used by the VIA1 read_prb formula):
   *   bit 0 = DATA_IN     (combined; 1 when bus released)
   *   bit 2 = CLK_IN      (combined; 1 when bus released)
   *   bit 7 = ATN_IN      (C64-driven; 1 when ATN released)
   *
   * VICE's full byte includes more bits used by other drive types;
   * we set only what the 1541 read_prb formula consumes.
   */
  driveDrvPort(): number {
    let v = 0;
    if (this.busData()) v |= 0x01;
    if (this.busClk()) v |= 0x04;
    if (this.busAtn()) v |= 0x80;
    return v & 0xff;
  }

  /** Reset to all-released. */
  reset(): void {
    this.c64AtnReleased = true;
    this.c64ClkReleased = true;
    this.c64DataReleased = true;
    this.drvDataReleased = true;
    this.drvClkReleased = true;
    this.drvAtnaReleased = true;
  }
}
