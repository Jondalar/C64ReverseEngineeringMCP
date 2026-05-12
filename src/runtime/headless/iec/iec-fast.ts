// Spec 422 — IEC Phase G: Burst mode (deferred stub).
//
// Doc cite:  docs/vice-iec-arc42.md §15 Phase G (step 17), §5.8 burst
//            mode, §13 out-of-scope notes.
// VICE cite: src/c64/c64fastiec.c — `c64fastiec_fast_cpu_write` is
//            the CIA SDR reroute hook used by burst-mode parallel
//            transfer (= JiffyDOS path). Bit-bang IEC stays active
//            for ATN handshake; burst is a parallel-only data path.
//
// Status:    Burst mode / JiffyDOS is out of scope for the arch-port
//            game corpus (MM, Scramble, motm, IM2, LNR all use
//            bit-bang IEC + custom fastloaders). This file exists
//            only so future call sites compile against a documented
//            signature.
//
// OQ-422-1:  Is JiffyDOS in scope? Decision per spec 422: defer.

/**
 * VICE port of `c64fastiec_fast_cpu_write` (src/c64/c64fastiec.c).
 *
 * In VICE this is invoked when the CIA2 Serial Data Register is
 * written and burst mode is active; the byte is shifted out on the
 * parallel burst lines to the drive instead of (or in addition to)
 * the normal bit-bang IEC path.
 *
 * @param _value Byte written to CIA2 SDR.
 *
 * not implemented; JiffyDOS not in scope
 */
export function c64fastiec_fast_cpu_write(_value: number): void {
  // not implemented; JiffyDOS not in scope
}
