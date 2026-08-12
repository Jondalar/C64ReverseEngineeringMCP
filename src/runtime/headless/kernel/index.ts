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
// Spec 200 — Kernel barrel.

export * from "./clock-domains.js";
export * from "./kernel-bus.js";
export * from "./kernel-status.js";
export * from "./kernel-trace.js";
export * from "./machine-kernel.js";
export * from "./sync-strategy.js";
export * from "./headless-machine-kernel.js";
export * from "./event-catchup-strategy.js";
export * from "./kernel-irq.js";
export * from "./kernel-hooks.js";
