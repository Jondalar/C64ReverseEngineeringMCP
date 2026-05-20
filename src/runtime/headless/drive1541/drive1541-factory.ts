import type { Drive1541, Drive1541Implementation } from "./drive1541.js";
// Spec 612 T3.1 — replace quarantine import with new snake_case port facade.
// Vice1541Facade lives OUTSIDE `vice1541/` per Spec 612 §2 PL-3.
import { Vice1541Facade } from "./vice1541-facade.js";
import {
  Legacy1541Adapter,
  type Legacy1541AdapterDeps,
} from "./legacy1541-adapter.js";

export function resolveDrive1541Implementation(
  requested?: Drive1541Implementation,
): Drive1541Implementation {
  // 2026-05-20 (user mandate, codex/615 branch): vice1541 is the DEFAULT
  // everywhere. Legacy is opt-in ONLY — pass `requested="legacy"` explicitly
  // or set `C64RE_DRIVE1541=legacy`. Spec 622 §4.0 made vice mode VICE-shaped
  // (EventCatchupStrategy) + ~0.8x realtime + fixed the $DD00 fastloader
  // timing (7/7 games load), so there is no longer a reason for any caller
  // to silently fall back to legacy.
  const env = process.env.C64RE_DRIVE1541;
  const selected = requested ?? (
    env === "vice" || env === "legacy" ? env : undefined
  ) ?? "vice";

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
    return new Vice1541Facade();
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
