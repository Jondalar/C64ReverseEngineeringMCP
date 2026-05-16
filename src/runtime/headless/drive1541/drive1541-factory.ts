import type { Drive1541Implementation } from "./drive1541.js";

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
    throw new Error(
      "[drive1541] VICE1541 is not implemented yet; use drive1541: \"legacy\" until Spec 611 phases build it",
    );
  }
}
