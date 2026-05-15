// Spec 450 — integrated-session scenario helper.
//
// Wraps IntegratedSession boot + autostart + post-state capture
// for Layer B/C scenarios (B5 format.prg, B6 diskid, B7 iecdelay,
// C8/C9/C10 SAVE/LOAD).
//
// Usage pattern:
//   const out = await runIntegratedScenario({
//     diskPath: "samples/synthetic/blank.d64",
//     bootCycles: 5_000_000,
//     command: 'LOAD"FORMAT",8\r',
//     postCommandCycles: 60_000_000,
//     postRunCommand: "RUN\r",
//     postRunCycles: 200_000_000,
//     postStatePath: "/tmp/spec-450/.../post-state.g64",
//   });
//   // out.postStatePath is the dumped G64 image after workflow.
//
// Output is always G64 (drive operates in GCR domain). For D64-
// input scenarios, the kernel converts on mount; the persisted
// G64 captures the post-state regardless of input format.

import { startIntegratedSession } from "../../../src/runtime/headless/integrated-session-manager.ts";
import { persistTrackBuffer } from "../../../src/runtime/headless/drive/session-persist.ts";

export interface IntegratedScenarioOpts {
  /** Path to .d64 or .g64 disk image to mount. */
  diskPath: string;
  /** Cycles to spin after resetCold for KERNAL ROM boot (~5_000_000 typical). */
  bootCycles: number;
  /** Optional PRG file path to load directly into RAM after boot. */
  loadPrgPath?: string;
  /** Optional BASIC command string to type after boot (e.g. 'LOAD"FORMAT",8\r'). */
  command?: string;
  /** Cycles to spin after `command` (e.g. wait for LOAD to complete). */
  postCommandCycles?: number;
  /** Optional second BASIC command (e.g. "RUN\r"). */
  postRunCommand?: string;
  /** Cycles to spin after `postRunCommand` — workflow-specific. */
  postRunCycles?: number;
  /** Where to dump the persisted post-state G64. */
  postStatePath: string;
  /** Mount image read-only (drives WPS pin low). */
  writeProtected?: boolean;
  /** Defaults to "true-drive" + microcoded CPU + literal-port VIC. */
  mode?: string;
}

export interface IntegratedScenarioResult {
  postStatePath: string;
  /** Tracks that the drive modified during the workflow. */
  modifiedTracks: number[];
  /** Bytes written to postStatePath (G64 file size). */
  bytesWritten: number;
  /** True if persistTrackBuffer reported no modifications. */
  noModifications: boolean;
}

export async function runIntegratedScenario(
  opts: IntegratedScenarioOpts,
): Promise<IntegratedScenarioResult> {
  const { session } = startIntegratedSession({
    diskPath: opts.diskPath,
    mode: (opts.mode ?? "true-drive") as never,
    useMicrocodedCpu: true,
    writeProtected: opts.writeProtected,
    vicRenderer: "literal-port",
  } as never);

  session.resetCold("pal-default");
  session.runFor(opts.bootCycles, { cycleBudget: opts.bootCycles });

  if (opts.loadPrgPath) {
    session.loadPrgIntoRam(opts.loadPrgPath);
  }

  if (opts.command) {
    session.typeText(opts.command);
    const c = opts.postCommandCycles ?? 30_000_000;
    session.runFor(c, { cycleBudget: c });
  }
  if (opts.postRunCommand) {
    session.typeText(opts.postRunCommand);
    const c = opts.postRunCycles ?? 60_000_000;
    session.runFor(c, { cycleBudget: c });
  }

  // Spec 450.x — flush the drive's pending dirty-track marker
  // before persist. onStep already flushes when the head moves;
  // this catches the final track the drive wrote to without
  // stepping away (the common SAVE / FORMAT terminal state).
  session.drive.flushDirtyCurrentTrack();

  const persist = persistTrackBuffer(
    session.parser, session.trackBuffer,
    opts.diskPath, opts.postStatePath,
  );

  return {
    postStatePath: persist.outputPath,
    modifiedTracks: persist.modifiedTracks,
    bytesWritten: persist.bytesWritten,
    noModifications: persist.skipped === "no-modifications",
  };
}
