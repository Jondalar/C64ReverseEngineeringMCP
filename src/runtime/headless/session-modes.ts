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
//   fast-trap          |  ON   |  legacy    |  off     |  none
//   real-kernal        |  off  |  legacy    |  off     |  none
//   true-drive         |  off  |  microcd.  |  off     |  none
//   debug-vice-compare |  off  |  microcd.  |  off     |  iec+drive
//   debug-lockstep     |  off  |  microcd.  |  on      |  none
//   custom             | (caller-provided booleans honored)

export type SessionMode =
  | "fast-trap"
  | "real-kernal"
  | "true-drive"
  | "debug-vice-compare"
  | "debug-lockstep"
  | "debug-push-only"
  | "debug-hybrid"
  | "custom";

export interface SessionModeFlags {
  enableKernalFileIoTraps: boolean;
  enableKernalSerialTraps: boolean;
  enableKernalIoTraps: boolean;
  useMicrocodedCpu: boolean;
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
  const base = presetFlags(mode ?? "fast-trap");
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
    case "fast-trap":
      return {
        enableKernalFileIoTraps: true,
        enableKernalSerialTraps: true,
        enableKernalIoTraps: true,
        useMicrocodedCpu: false,
        useCycleLockstep: false,
        traceIec: false,
        traceDrive: false,
      };
    case "real-kernal":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: false,
        useCycleLockstep: false,
        traceIec: false,
        traceDrive: false,
      };
    case "true-drive":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: true,
        useCycleLockstep: false,
        traceIec: false,
        traceDrive: false,
      };
    case "debug-vice-compare":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: true,
        useCycleLockstep: false,
        traceIec: true,
        traceDrive: true,
      };
    case "debug-lockstep":
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: true,
        useCycleLockstep: true,
        traceIec: false,
        traceDrive: false,
      };
    case "debug-push-only":
      // Spec 207: push-only sync probe (event-catchup w/o catch-up
      // on bus access). Used for IEC pulse-edge timing audits.
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: true,
        useCycleLockstep: false,
        traceIec: true,
        traceDrive: false,
      };
    case "debug-hybrid":
      // Spec 207 / Spec 218: hybrid drive-sync (cycle-step on $DD00
      // in userland PC range; legacy whole-instruction elsewhere).
      // Originally landed for motm BIT $4278 polarity (commit 3d10fee).
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: true,
        useCycleLockstep: false,
        traceIec: true,
        traceDrive: true,
      };
    case "custom":
    default:
      return {
        enableKernalFileIoTraps: false,
        enableKernalSerialTraps: false,
        enableKernalIoTraps: false,
        useMicrocodedCpu: false,
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
  for (const candidate of ["fast-trap", "real-kernal", "true-drive", "debug-vice-compare", "debug-lockstep", "debug-push-only", "debug-hybrid"] as SessionMode[]) {
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
    && a.useMicrocodedCpu === b.useMicrocodedCpu
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
    microcoded: flags.useMicrocodedCpu,
    lockstep: flags.useCycleLockstep,
    channels,
  };
}
