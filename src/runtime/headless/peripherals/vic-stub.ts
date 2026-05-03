// Spec 065 placeholder VIC stubs. Replaced by full VIC II in Sprint 70+.
// For now: minimal handlers that let KERNAL cold-start get past the
// PAL/NTSC raster polling at $FF5E and any code that polls $D019.

import type { HeadlessMemoryBus } from "../memory-bus.js";

export function installVicMinimalStubs(bus: HeadlessMemoryBus): void {
  bus.registerIoHandler(0xd011, {
    read: () => bus.io[0xd011 - 0xd000]! & 0x7f,
    write: (_addr, value) => { bus.io[0xd011 - 0xd000] = value & 0xff; },
  });
  bus.registerIoHandler(0xd012, {
    read: () => 0,
    write: (_addr, value) => { bus.io[0xd012 - 0xd000] = value & 0xff; },
  });
  bus.registerIoHandler(0xd019, {
    read: () => 0,
    write: (_addr, value) => { bus.io[0xd019 - 0xd000] = value & 0xff; },
  });
}
