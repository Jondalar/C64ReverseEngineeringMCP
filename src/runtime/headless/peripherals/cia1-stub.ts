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
