// Spec 204 — Kernel hook registry.
//
// TrueDrive hook hygiene (ADR §6 + §10 criterion 5). Every legacy
// rescue hook (ATN $7C poke, synthetic IEC release, KERNAL traps,
// fake disk byte, forced PC jumps) registers here at kernel
// construction. Each fire calls `recordFire` which:
//
//   1. Checks `mode` is in the hook's `allowedModes`. Throws
//      `HookForbiddenError` otherwise — fires while mode = true-drive
//      are a hard test failure.
//   2. Bumps `fireCount`, stamps `lastFireClock` + `lastFireDescription`.
//
// `kernel.status().hooks` lists every registered hook with its
// last-fire clock so smoke tests + the workspace UI can audit.

import type { KernelMode } from "./kernel-status.js";

export type HookName =
  | "atn-poke-7c"          // legacy: poke $7C in drive RAM on ATN
  | "iec-release-clk"      // synthetic drive CLK release
  | "iec-release-data"     // synthetic drive DATA release
  | "kernal-serial-trap"   // KERNAL serial JMP-table traps
  | "kernal-fileio-trap"   // KERNAL file-IO traps
  | "kernal-io-trap"       // KERNAL I/O traps
  | "fake-disk-byte"       // synthetic disk byte delivery
  | "forced-pc-jump";      // forced CPU PC jump for stuck loaders

export interface HookStatus {
  readonly name: HookName;
  readonly allowedModes: readonly KernelMode[];
  fireCount: number;
  lastFireClock?: number;
  lastFireDescription?: string;
}

export class HookForbiddenError extends Error {
  constructor(
    public readonly hookName: HookName,
    public readonly mode: KernelMode,
    public readonly clock: number,
    public readonly description?: string,
  ) {
    const detail = description ? ` (${description})` : "";
    super(
      `[hook-hygiene] hook '${hookName}' fired in mode '${mode}'${detail} — ` +
      `forbidden by Spec 204 (ADR §10 criterion 5).`,
    );
    this.name = "HookForbiddenError";
  }
}

export class HookRegistry {
  private readonly hooks = new Map<HookName, HookStatus>();

  constructor(private readonly modeRef: () => KernelMode) {}

  register(name: HookName, allowedModes: readonly KernelMode[]): void {
    if (this.hooks.has(name)) return; // idempotent — kernel reset path
    this.hooks.set(name, {
      name,
      allowedModes: allowedModes.slice(),
      fireCount: 0,
    });
  }

  recordFire(name: HookName, clock: number, description?: string): void {
    const rec = this.hooks.get(name);
    if (!rec) {
      throw new Error(`[hook-hygiene] hook '${name}' not registered.`);
    }
    const mode = this.modeRef();
    if (!rec.allowedModes.includes(mode)) {
      throw new HookForbiddenError(name, mode, clock, description);
    }
    rec.fireCount += 1;
    rec.lastFireClock = clock;
    if (description !== undefined) rec.lastFireDescription = description;
  }

  list(): HookStatus[] {
    return Array.from(this.hooks.values()).map((r) => ({
      name: r.name,
      allowedModes: r.allowedModes,
      fireCount: r.fireCount,
      lastFireClock: r.lastFireClock,
      lastFireDescription: r.lastFireDescription,
    }));
  }

  reset(): void {
    for (const rec of this.hooks.values()) {
      rec.fireCount = 0;
      rec.lastFireClock = undefined;
      rec.lastFireDescription = undefined;
    }
  }
}
