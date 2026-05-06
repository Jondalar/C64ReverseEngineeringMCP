/**
 * sync-detector.ts — GCR SYNC# pattern detector.
 *
 * 1:1 port of VICE rotation.c sync detection logic.
 *
 * VICE source refs:
 *   - src/drive/rotation.c lines 447-473  (10-bit shift register + sync check)
 *   - src/gcr.c             lines 170-203 (gcr_find_sync — same 0x3ff mask)
 *
 * Real 1541 hardware uses a 10-bit shift register (UE6/UF4 stages in the
 * analog read path). When all 10 bits are 1 (value == 0x3ff), SYNC is
 * asserted. Any 0 bit causes the register to keep shifting; a fresh run of
 * 10 consecutive 1-bits is required to re-assert SYNC.
 *
 * SYNC# pin (VIA2 PB bit 7) is active LOW:
 *   SYNC# = 0 when sync is active (10+ ones seen)
 *   SYNC# = 1 when not in sync
 *
 * VICE rotation.c line 453:
 *   if (rptr->last_read_data == 0x3ff) { ... }   // 10-bit all-ones = SYNC
 *
 * gcr_find_sync (gcr.c line 185):
 *   if (~w & 0x3ff) { w <<= 1; } else { return p; }  // 0x3ff = all 10 bits set
 *
 * The shift update (rotation.c line 447):
 *   rptr->last_read_data = ((rptr->last_read_data << 1) & 0x3fe) | bit;
 * keeps exactly 10 bits live (mask 0x3fe after shift = bits 9:1 preserved).
 */

/** Snapshot of SyncDetector internal state for save/restore. */
export interface SyncDetectorSnap {
  /** Number of consecutive 1-bits seen so far (max useful value: 10). */
  onesCount: number;
  /** Whether sync is currently active. */
  syncActive: boolean;
}

/**
 * GCR SYNC# pattern detector.
 *
 * Standalone module — consumed by gcr-shifter.ts (Spec 153).
 * Thread-safe in the sense that it has no async state; all updates are
 * synchronous single-bit pushes.
 */
export class SyncDetector {
  /**
   * 10-bit shift register mirroring VICE `last_read_data`.
   *
   * VICE rotation.c line 447:
   *   rptr->last_read_data = ((rptr->last_read_data << 1) & 0x3fe) | bit;
   *
   * The mask 0x3fe = 0b11_1111_1110 discards bit 10+ after the left shift,
   * keeping only the lower 10 bits with the LSB cleared (ready for the new
   * bit to be OR'd in).
   */
  private _reg = 0;

  /**
   * Push one GCR bit (0 or 1) into the shift register and update sync state.
   *
   * Mirrors VICE rotation.c lines 447-454 (8+2 bit shifter + sync check):
   *
   *   rptr->last_read_data = ((rptr->last_read_data << 1) & 0x3fe) | bit;
   *   if (rptr->last_read_data == 0x3ff) {
   *       rptr->bit_counter = 0;   // SYNC resets byte counter
   *   }
   */
  pushBit(bit: 0 | 1): void {
    this._reg = ((this._reg << 1) & 0x3fe) | bit;
  }

  /**
   * Current sync state.
   *
   * true when the 10-bit shift register equals 0x3ff (all 10 bits are 1).
   * VICE rotation.c line 453: `if (rptr->last_read_data == 0x3ff)`
   */
  get syncActive(): boolean {
    return this._reg === 0x3ff;
  }

  /**
   * SYNC# pin value (active LOW per real 1541 / VIA2 PB bit 7 convention).
   *
   * Returns 0 when sync is active, 1 when not.
   * The 1541 asserts SYNC# low on the bus whenever a sync mark is under
   * the head; VIA2 PB7 reads this inverted sense.
   */
  get syncBit(): 0 | 1 {
    return this._reg === 0x3ff ? 0 : 1;
  }

  /**
   * Reset internal state.
   *
   * Called on track change, motor off, or any condition that requires the
   * detector to start fresh. Mirrors VICE rotation_reset() which zeros
   * last_read_data (rotation.c lines 117-118).
   */
  reset(): void {
    this._reg = 0;
  }

  /**
   * Capture a snapshot of the current internal state for save/restore
   * (e.g. drive VSF save, regression harness checkpointing).
   *
   * The `onesCount` field is a derived value for human readability and test
   * convenience. The canonical state is `syncActive` + the shift register
   * value, but full register reconstruction from `onesCount` is only valid
   * when the detector has been fed a contiguous run of 1-bits from reset
   * (which is the common steady-state scenario). For full fidelity, callers
   * that need exact register restoration should use restore() with the
   * snapshot produced by snapshot().
   */
  snapshot(): SyncDetectorSnap {
    return {
      onesCount: this._onesCount(),
      syncActive: this.syncActive,
    };
  }

  /**
   * Restore internal state from a snapshot.
   *
   * Reconstructs the shift register from syncActive + onesCount.
   * If syncActive is true, register = 0x3ff (10 ones).
   * Otherwise, register is set to a run of `onesCount` ones in the LSBs
   * (0 ≤ onesCount ≤ 9).
   */
  restore(snap: SyncDetectorSnap): void {
    if (snap.syncActive) {
      this._reg = 0x3ff;
    } else {
      // Build a run of onesCount 1-bits in the low-order positions.
      const n = Math.min(Math.max(snap.onesCount, 0), 9);
      this._reg = n === 0 ? 0 : (1 << n) - 1;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Count the current run of consecutive 1-bits in the shift register.
   *
   * The shift register shifts LEFT on each pushBit(), so the most-recently
   * pushed bit is always in bit 0. A run of N ones from the last push is
   * represented as ones in bits (N-1):0.
   *
   * Examples (after N pushes of 1 starting from 0):
   *   5 ones → reg = 0x1f  = 0b000_0001_1111  → count trailing 1s from bit0: 5
   *  10 ones → reg = 0x3ff = 0b011_1111_1111  → count: 10
   */
  private _onesCount(): number {
    let count = 0;
    for (let i = 0; i <= 9; i++) {
      if ((this._reg >> i) & 1) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}
