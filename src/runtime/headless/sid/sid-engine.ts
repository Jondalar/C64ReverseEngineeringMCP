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
import { ResidWasm } from "./resid-wasm-engine.js";

// Spec 703 §4 engine model. `resid-wasm` = the compiled reSID audio authority;
// `resid` = the simplified TS synth (703.6 fallback/test-only); `fastsid` =
// register-state only, no synth (trace/no-audio). The 703 spec names these
// `resid-wasm` / `fastsid-register`; the legacy short names stay accepted.
export type SidEngineKind = "resid-wasm" | "resid" | "fastsid";

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
  /**
   * Resolves when the engine is fully ready to emit audio. Synchronous
   * engines (TS `Resid`) may omit it (treated as already ready); the reSID
   * WASM engine resolves once its module has loaded, and rejects on load
   * failure. Callers driving a synchronous pump (export) should await it.
   */
  ready?(): Promise<void>;

  // Spec 705.A step 4 — reSID synthesis-state checkpoint (ResidWasm only; the
  // synchronous TS engines have no separate WASM synthesis state). Optional so
  // non-reSID engines satisfy the interface.
  /** True once reSID is loaded and its synthesis state is capturable. */
  readonly residReady?: boolean;
  /** Capture reSID's full synthesis state (VICE sid_snapshot_state_t content). */
  captureResidState?(): Uint8Array | null;
  /** Restore reSID synthesis state (no register replay afterwards). */
  restoreResidState?(bytes: Uint8Array): void;
  /** TS-side sample-cadence remainder (part of the audio checkpoint). */
  cycleAccumulator?: number;
}

export function isAudioSid(sid: SidLike): sid is AudioSidLike {
  return typeof (sid as any).emit === "function";
}

/**
 * Construct a SID engine. Selection precedence: explicit > env > default.
 */
export function createSid(opts: SidFactoryOptions = {}): SidLike {
  const explicit = opts.engine;
  const envChoice = normalizeEngineKind(process.env["C64RE_SID_ENGINE"]);
  const kind: SidEngineKind = explicit ?? envChoice ?? "fastsid";
  if (kind === "resid-wasm") return new ResidWasm(undefined, opts);
  if (kind === "resid") return new Resid(undefined, opts);
  return new Sid6581();
}

/**
 * Construct an **audio-capable** SID engine (has `emit()`), for the audio
 * recorder / export / live-stream paths which must produce PCM. Selection:
 * explicit > env > default `resid-wasm` (the committed reSID WASM authority,
 * Spec 703). `fastsid` is silently upgraded to `resid-wasm` here because it
 * cannot synthesise. Falls back to the TS `Resid` only when explicitly asked.
 */
export function createAudioSid(opts: SidFactoryOptions = {}): AudioSidLike {
  const explicit = opts.engine;
  const envKind = normalizeEngineKind(process.env["C64RE_SID_ENGINE"]);
  let kind: SidEngineKind = explicit ?? envKind ?? "resid-wasm";
  if (kind === "fastsid") kind = "resid-wasm"; // register-only can't emit
  if (kind === "resid") return new Resid(undefined, opts);
  return new ResidWasm(undefined, opts);
}

/** Map env / config strings (incl. the Spec 703 long names) to a kind. */
function normalizeEngineKind(v: string | undefined): SidEngineKind | undefined {
  switch ((v || "").toLowerCase()) {
    case "resid-wasm":
    case "residwasm":
      return "resid-wasm";
    case "resid":
      return "resid";
    case "fastsid":
    case "fastsid-register":
      return "fastsid";
    default:
      return undefined;
  }
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
