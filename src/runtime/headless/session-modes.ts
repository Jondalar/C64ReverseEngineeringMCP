// Spec 098 (M1.1) — Session modes.
//
// Centralizes the boolean configuration for IntegratedSession into a
// small named-mode enum. Tools and agents can ask "what mode is this
// session?" instead of inspecting a bag of flags.
//
// Mapping summary (boolean fields on IntegratedSessionOptions):
//
//   Mode               | traps | microcoded | lockstep | channels
//   -------------------|-------|------------|----------|----------
//   true-drive         |  off  |  microcd.  |  off     |  none
//   debug-vice-compare |  off  |  microcd.  |  off     |  iec+drive
//   debug-lockstep     |  off  |  microcd.  |  on      |  none
//   custom             | (caller-provided booleans honored)

// Spec 723.3: fast-trap / real-kernal (legacy KERNAL-trap + legacy-CPU modes)
// removed. true-drive is the product path; debug-* are oracle-only.
// Spec 723.7a: debug-push-only / debug-hybrid removed (dead label-only modes).
export type SessionMode =
  | "true-drive"
  | "debug-vice-compare"
  | "debug-lockstep"
  | "custom";

export interface SessionModeFlags {
  enableKernalFileIoTraps: boolean;
  enableKernalSerialTraps: boolean;
  enableKernalIoTraps: boolean;
  // Spec 723.4a: useMicrocodedCpu removed — microcoded is the only product CPU.
  useCycleLockstep: boolean;
  traceIec: boolean;
  traceDrive: boolean;
}

export interface SessionModeReport {
  mode: SessionMode;
  traps: boolean;       // any of the three trap flags ON
  microcoded: boolean;
  lockstep: boolean;
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
        useCycleLockstep: false,
        traceIec: false,
        traceDrive: false,
      };
    case "debug-vice-compare":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useCycleLockstep: false,
        traceIec: true,
        traceDrive: true,
      };
    case "debug-lockstep":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useCycleLockstep: true,
        traceIec: false,
        traceDrive: false,
      };
    case "custom":
    default:
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useCycleLockstep: false,
        traceIec: false,
        traceDrive: false,
      };
  }
}

// Identify which mode best matches a flag set. Used to label sessions
// constructed via the legacy boolean path so `session.mode` always
// has a stable answer.
export function identifyMode(flags: SessionModeFlags): SessionMode {
  for (const candidate of ["true-drive", "debug-vice-compare", "debug-lockstep"] as SessionMode[]) {
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
    && a.useCycleLockstep === b.useCycleLockstep
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
    lockstep: flags.useCycleLockstep,
    channels,
  };
}
