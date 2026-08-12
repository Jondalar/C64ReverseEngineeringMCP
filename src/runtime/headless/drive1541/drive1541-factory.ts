// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
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
