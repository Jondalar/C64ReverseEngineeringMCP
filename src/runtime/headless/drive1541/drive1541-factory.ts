import type { Drive1541, Drive1541Implementation } from "./drive1541.js";
import { Vice1541 } from "../vice1541/vice1541.js";

export function resolveDrive1541Implementation(
  requested?: Drive1541Implementation,
): Drive1541Implementation {
  const env = process.env.C64RE_DRIVE1541;
  const selected = requested ?? (
    env === "vice" || env === "legacy" ? env : undefined
  ) ?? "legacy";

  if (selected !== "legacy" && selected !== "vice") {
    throw new Error(`[drive1541] unsupported implementation: ${String(selected)}`);
  }
  return selected;
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
 * Instantiate the selected Drive1541 implementation. Phase 611.2 only
 * supports `"vice"` here; the LEGACY1541 adapter behind this entrypoint
 * lands in a later phase (C64 side still wires the legacy DriveCpu
 * directly until then).
 */
export function createDrive1541(
  implementation: Drive1541Implementation,
): Drive1541 {
  if (implementation === "vice") {
    return new Vice1541();
  }
  throw new Error(
    `[drive1541] LEGACY1541 adapter via createDrive1541 is not built ` +
      `yet (Spec 611 — landed in a later phase). The C64 side wires the ` +
      `existing legacy DriveCpu directly for "legacy"; use this entrypoint ` +
      `only with drive1541: "vice".`,
  );
}
