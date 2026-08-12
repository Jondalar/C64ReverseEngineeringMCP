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
// Spec 064 placeholder CIA1 keyboard stub. Replaced by full CIA1 in
// Sprint 69. Returns "all keys released" so KERNAL keyboard scan
// doesn't pollute the buffer.

import type { HeadlessMemoryBus } from "../memory-bus.js";

export function installCia1KeyboardStub(bus: HeadlessMemoryBus): void {
  bus.registerIoHandler(0xdc01, {
    read: () => 0xff,
    write: (_addr, value) => { bus.io[0xdc01 - 0xd000] = value & 0xff; },
  });
}
