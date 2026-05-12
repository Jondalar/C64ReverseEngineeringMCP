// Spec 263 — SID engine selector.
//
// V3 sessions default to `resid` (audio-capable). Trace-mode and pre-V3
// flows use `fastsid` (register-state only, no synth). Engine selection:
//   - explicit `engine` option to createSid()
//   - else env var C64RE_SID_ENGINE = "resid" | "fastsid"
//   - else default "fastsid" (back-compat with non-audio sessions)
//
// The selector returns a Sid6581-compatible object — Resid wraps the
// register-state SID 1:1, so chip-bus install / snapshot / trace paths
// are identical for both engines.

import { Sid6581 } from "./sid.js";
import { Resid, type ResidEmitOptions } from "./resid.js";

export type SidEngineKind = "resid" | "fastsid";

export interface SidFactoryOptions extends ResidEmitOptions {
  engine?: SidEngineKind;
}

/**
 * Sid6581-compatible interface used by integrated-session and chip-bus
 * install. Both Sid6581 and Resid satisfy this shape.
 */
export interface SidLike {
  read(addr: number): number;
  write(addr: number, value: number): void;
  reset(): void;
  tick(cycles: number): void;
  snapshot(): unknown;
  restore(snap: any): void;
  readonly regs: Uint8Array;
  potReader?: ((idx: 0 | 1) => number) | undefined;
  writeTrace?: ((addr: number, value: number) => void) | undefined;
}

export interface AudioSidLike extends SidLike {
  emit(cycles: number): Int16Array;
  readonly sampleRate: number;
  readonly clockFreq: number;
}

export function isAudioSid(sid: SidLike): sid is AudioSidLike {
  return typeof (sid as any).emit === "function";
}

/**
 * Construct a SID engine. Selection precedence: explicit > env > default.
 */
export function createSid(opts: SidFactoryOptions = {}): SidLike {
  const explicit = opts.engine;
  const envChoice = (process.env["C64RE_SID_ENGINE"] || "").toLowerCase();
  let kind: SidEngineKind;
  if (explicit) kind = explicit;
  else if (envChoice === "resid" || envChoice === "fastsid") kind = envChoice;
  else kind = "fastsid";
  if (kind === "resid") return new Resid(undefined, opts);
  return new Sid6581();
}

/**
 * Convenience: install a SID engine onto a memory bus. Mirrors
 * sid.ts#installSid but returns the engine wrapper (so audio callers
 * can call .emit). Bus install registers $D400-$D7FF mirror tile.
 */
export function installSidEngine(
  bus: { registerIoHandler(addr: number, h: { read: (a: number) => number; write: (a: number, v: number) => void }): void },
  opts: SidFactoryOptions = {},
): SidLike {
  const sid = createSid(opts);
  for (let a = 0xD400; a < 0xD800; a++) {
    bus.registerIoHandler(a, {
      read: () => sid.read(a),
      write: (_addr, value) => sid.write(a, value),
    });
  }
  return sid;
}
