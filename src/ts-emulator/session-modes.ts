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
// Spec 098 (M1.1) — Session modes.
//
// Centralizes the boolean configuration for IntegratedSession into a
// small named-mode enum. Tools and agents can ask "what mode is this
// session?" instead of inspecting a bag of flags.
//
// Mapping summary (boolean fields on IntegratedSessionOptions):
//
//   Mode               | traps | microcoded | channels
//   -------------------|-------|------------|----------
//   true-drive         |  off  |  microcd.  |  none
//   debug-vice-compare |  off  |  microcd.  |  iec+drive
//   custom             | (caller-provided booleans honored)

// Spec 723.3: fast-trap / real-kernal (legacy KERNAL-trap + legacy-CPU modes)
// removed. true-drive is the product path; debug-* are oracle-only.
// Spec 723.7a: debug-push-only / debug-hybrid removed (dead label-only modes).
// Spec 723.7b: debug-lockstep removed with the cycle-lockstep scheduler.
export type SessionMode =
  | "true-drive"
  | "debug-vice-compare"
  | "custom";

export interface SessionModeFlags {
  enableKernalFileIoTraps: boolean;
  enableKernalSerialTraps: boolean;
  enableKernalIoTraps: boolean;
  // Spec 723.4a: useMicrocodedCpu removed — microcoded is the only product CPU.
  // Spec 723.7b: useCycleLockstep removed — event-catchup is the only scheduler.
  traceIec: boolean;
  traceDrive: boolean;
}

export interface SessionModeReport {
  mode: SessionMode;
  traps: boolean;       // any of the three trap flags ON
  microcoded: boolean;
  channels: "none" | "iec" | "drive" | "iec+drive";
}

// Resolve a SessionMode (and optional explicit overrides) to the
// boolean flag set the constructor expects. Overrides win over the
// mode preset; if any override is provided, the resolved mode is
// "custom" unless caller explicitly asked for a non-custom mode.
export function resolveSessionFlags(
  mode: SessionMode | undefined,
  overrides?: Partial<SessionModeFlags>,
): SessionModeFlags {
  // Spec 723.2: single-path default. No mode → the product runtime
  // (true-drive = real KERNAL, no fast-traps, microcoded CPU, event-catchup).
  const base = presetFlags(mode ?? "true-drive");
  if (!overrides) return base;
  // Skip undefined keys so callers passing `{ x: undefined }` don't
  // nuke the preset value with undefined.
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function presetFlags(mode: SessionMode): SessionModeFlags {
  switch (mode) {
    case "true-drive":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        traceIec: false,
        traceDrive: false,
      };
    case "debug-vice-compare":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        traceIec: true,
        traceDrive: true,
      };
    case "custom":
    default:
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        traceIec: false,
        traceDrive: false,
      };
  }
}

// Identify which mode best matches a flag set. Used to label sessions
// constructed via the legacy boolean path so `session.mode` always
// has a stable answer.
export function identifyMode(flags: SessionModeFlags): SessionMode {
  for (const candidate of ["true-drive", "debug-vice-compare"] as SessionMode[]) {
    const preset = presetFlags(candidate);
    if (flagsEqual(preset, flags)) return candidate;
  }
  return "custom";
}

function flagsEqual(a: SessionModeFlags, b: SessionModeFlags): boolean {
  return (
    a.enableKernalFileIoTraps === b.enableKernalFileIoTraps
    && a.enableKernalSerialTraps === b.enableKernalSerialTraps
    && a.enableKernalIoTraps === b.enableKernalIoTraps
    && a.traceIec === b.traceIec
    && a.traceDrive === b.traceDrive
  );
}

export function makeModeReport(mode: SessionMode, flags: SessionModeFlags): SessionModeReport {
  const traps = flags.enableKernalFileIoTraps || flags.enableKernalSerialTraps || flags.enableKernalIoTraps;
  const channels = flags.traceIec && flags.traceDrive ? "iec+drive"
    : flags.traceIec ? "iec"
    : flags.traceDrive ? "drive"
    : "none";
  return {
    mode,
    traps,
    microcoded: true,  // Spec 723.4a: always microcoded (the only product CPU)
    channels,
  };
}
