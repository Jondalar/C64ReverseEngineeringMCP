import type { Drive1541Implementation } from "./drive1541.js";
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

export function assertDrive1541ImplementationAvailable(
  implementation: Drive1541Implementation,
): void {
  if (implementation === "vice") {
    // Spec 611 phase 611.1 — factory recognises "vice" and instantiates
    // the throwing VICE1541 stub. The Vice1541 constructor throws with
    // the Spec-611.1 stub message, so the error trail names the stub as
    // origin (proves the factory wiring without needing a separate
    // "would-be-instantiated" check).
    new Vice1541();
  }
}
