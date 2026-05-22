import type { Drive1541, Drive1541Implementation } from "./drive1541.js";
// Spec 612 T3.1 — Vice1541Facade lives OUTSIDE `vice1541/` per Spec 612 §2 PL-3.
import { Vice1541Facade } from "./vice1541-facade.js";

export function resolveDrive1541Implementation(
  _requested?: Drive1541Implementation,
): Drive1541Implementation {
  // Spec 704 §11 R3 — VICE1541 is the ONLY drive. The legacy drive was
  // removed; any requested value (including `"legacy"` or
  // `C64RE_DRIVE1541=legacy`) now resolves to vice.
  return "vice";
}

/**
 * Spec 611 phase 611.2 — no-op. VICE1541 ctor now succeeds (builds the
 * idle DiskUnitContext + DriveContext). Phase 611.1's throw-on-construct
 * gating is superseded; production-readiness gating moves to the
 * C64-side wiring once 611.9 flips the default.
 */
export function assertDrive1541ImplementationAvailable(
  _implementation: Drive1541Implementation,
): void {
  // intentionally empty
}

/**
 * Spec 704 §11 R3 — instantiate the (only) Drive1541 implementation: a
 * fresh Vice1541 facade. The legacy adapter is removed.
 */
export function createDrive1541(
  _implementation: Drive1541Implementation = "vice",
): Drive1541 {
  return new Vice1541Facade();
}
