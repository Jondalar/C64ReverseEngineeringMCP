import type { Drive1541, Drive1541Implementation } from "./drive1541.js";
import { Vice1541 } from "../vice1541/vice1541.js";
import {
  Legacy1541Adapter,
  type Legacy1541AdapterDeps,
} from "./legacy1541-adapter.js";

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
 * Instantiate the selected Drive1541 implementation. Phase 611.7e.2:
 *   - `"vice"` → fresh Vice1541 instance.
 *   - `"legacy"` → Legacy1541Adapter wrapping existing
 *     LEGACY1541 DriveCpu + IecBus (read-only adapter; LEGACY1541
 *     runtime path unchanged).
 *
 * Caller must supply `legacyDeps` when requesting "legacy" — the
 * adapter is READ-ONLY over the existing legacy stack, so it needs
 * pre-built references to `drive` and `iecBus`.
 */
export function createDrive1541(
  implementation: Drive1541Implementation,
  legacyDeps?: Legacy1541AdapterDeps,
): Drive1541 {
  if (implementation === "vice") {
    return new Vice1541();
  }
  if (implementation === "legacy") {
    if (!legacyDeps) {
      throw new Error(
        `[drive1541] createDrive1541("legacy") requires legacyDeps ` +
          `{ drive, iecBus } — the LEGACY1541 adapter is a read-only ` +
          `view over the existing stack. Pass the kernel's drive + ` +
          `iecBus.`,
      );
    }
    return new Legacy1541Adapter(legacyDeps);
  }
  throw new Error(`[drive1541] unsupported implementation: ${String(implementation)}`);
}
