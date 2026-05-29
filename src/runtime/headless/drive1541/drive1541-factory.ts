import type { Drive1541 } from "./drive1541.js";
// Spec 612 T3.1 — Vice1541Facade lives OUTSIDE `vice1541/` per Spec 612 §2 PL-3.
import { Vice1541Facade } from "./vice1541-facade.js";

/**
 * Spec 704 §11 R3 / 723.6a — instantiate the (only) Drive1541
 * implementation: a fresh Vice1541 facade. The legacy adapter and the
 * implementation-selection layer (resolve/assert) are gone.
 */
export function createDrive1541(): Drive1541 {
  return new Vice1541Facade();
}
