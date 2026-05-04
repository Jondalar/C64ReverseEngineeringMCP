// Spec 101 (M1.4) — Structured state snapshots.
//
// Single canonical JSON snapshot of a session's software-visible state.
// Round-trippable: snapshot → restore → snapshot returns an equal
// payload. Subsystems with private state expose enough surface for
// snapshot+restore via a small adapter; this file owns that adapter.
//
// schema_version: 1. See docs/snapshot-schema.md.

import type { IntegratedSession } from "./integrated-session.js";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface SnapshotIncludeOpts {
  // Default snapshot keeps RAM + key registers but omits derived
  // caches. Opt-in include sections expand.
  include?: ("ram" | "tracks")[];
}

export interface CpuSnapshot {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface DriveSnapshotInner {
  cpu: CpuSnapshot;
  ram: string;            // base64 (always included; small at 2KB)
  via1: ViaSnapshot;
  via2: ViaSnapshot;
  head: { track: number };
}

export interface ViaSnapshot {
  ora: number;
  orb: number;
  ddra: number;
  ddrb: number;
  t1Counter: number;
  t1Latch: number;
  t2Counter: number;
  acr: number;
  pcr: number;
  ifr: number;
  ier: number;
  sr: number;
}

export interface SessionSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  mode: string;
  cycles: { c64: number; drive: number; instructions: number };
  cpu: CpuSnapshot;
  ram?: string;            // base64 64KB; only when "ram" included
  iec: {
    c64Atn: boolean; c64Clk: boolean; c64Data: boolean;
    drvClk: boolean; drvData: boolean; drvAtnAck: boolean;
  };
  drive: DriveSnapshotInner;
  keyboard: { matrixCols: number[] };
  joystick2: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean };
}

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function snapshotVia(via: {
  ora: number; orb: number; ddra: number; ddrb: number;
  t1Counter: number; t1Latch: number; t2Counter: number;
  acr: number; pcr: number; ifr: number; ier: number; sr: number;
}): ViaSnapshot {
  return {
    ora: via.ora, orb: via.orb, ddra: via.ddra, ddrb: via.ddrb,
    t1Counter: via.t1Counter, t1Latch: via.t1Latch, t2Counter: via.t2Counter,
    acr: via.acr, pcr: via.pcr, ifr: via.ifr, ier: via.ier, sr: via.sr,
  };
}

function snapshotCpu(cpu: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number }): CpuSnapshot {
  return { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, flags: cpu.flags, cycles: cpu.cycles };
}

export function snapshot(session: IntegratedSession, opts: SnapshotIncludeOpts = {}): SessionSnapshot {
  const include = new Set(opts.include ?? []);
  const iecState = session.iecBus.snapshot();
  const drive = session.drive;
  const drvBus = drive.bus;
  const kb = session.keyboard as unknown as { matrixCols?: number[] };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: session.mode,
    cycles: {
      c64: session.c64Cpu.cycles,
      drive: drive.cpu.cycles,
      instructions: session.status().c64.instructions,
    },
    cpu: snapshotCpu(session.c64Cpu),
    ram: include.has("ram") ? bytesToB64(session.c64Bus.ram) : undefined,
    iec: {
      c64Atn: iecState.c64.atnReleased,
      c64Clk: iecState.c64.clkReleased,
      c64Data: iecState.c64.dataReleased,
      drvClk: iecState.drive.clkReleased,
      drvData: iecState.drive.dataReleased,
      drvAtnAck: iecState.drive.atnAckReleased,
    },
    drive: {
      cpu: snapshotCpu(drive.cpu),
      ram: bytesToB64(drvBus.ram),
      via1: snapshotVia(drvBus.via1 as never),
      via2: snapshotVia(drvBus.via2 as never),
      head: { track: session.headPosition.currentTrack },
    },
    keyboard: { matrixCols: kb.matrixCols ? [...kb.matrixCols] : [] },
    joystick2: {
      up: session.joystick2.up,
      down: session.joystick2.down,
      left: session.joystick2.left,
      right: session.joystick2.right,
      fire: session.joystick2.fire,
    },
  };
}

function restoreVia(via: {
  ora: number; orb: number; ddra: number; ddrb: number;
  t1Counter: number; t1Latch: number; t2Counter: number;
  acr: number; pcr: number; ifr: number; ier: number; sr: number;
}, snap: ViaSnapshot): void {
  via.ora = snap.ora; via.orb = snap.orb;
  via.ddra = snap.ddra; via.ddrb = snap.ddrb;
  via.t1Counter = snap.t1Counter; via.t1Latch = snap.t1Latch;
  via.t2Counter = snap.t2Counter;
  via.acr = snap.acr; via.pcr = snap.pcr;
  via.ifr = snap.ifr; via.ier = snap.ier; via.sr = snap.sr;
}

function restoreCpu(cpu: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number }, snap: CpuSnapshot): void {
  cpu.pc = snap.pc; cpu.a = snap.a; cpu.x = snap.x; cpu.y = snap.y;
  cpu.sp = snap.sp; cpu.flags = snap.flags; cpu.cycles = snap.cycles;
}

export function restore(session: IntegratedSession, snap: SessionSnapshot): void {
  if (snap.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`snapshot schemaVersion mismatch: got ${snap.schemaVersion}, expected ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (snap.ram) {
    const bytes = b64ToBytes(snap.ram);
    session.c64Bus.ram.set(bytes.subarray(0, session.c64Bus.ram.length));
  }
  restoreCpu(session.c64Cpu, snap.cpu);
  // IEC line state: restore by direct assignment via internal flags.
  const iec = session.iecBus as unknown as Record<string, boolean>;
  iec.c64AtnReleased = snap.iec.c64Atn;
  iec.c64ClkReleased = snap.iec.c64Clk;
  iec.c64DataReleased = snap.iec.c64Data;
  iec.driveClkReleased = snap.iec.drvClk;
  iec.driveDataReleased = snap.iec.drvData;
  iec.driveAtnAckReleased = snap.iec.drvAtnAck;
  // Drive.
  const drive = session.drive;
  const drvBytes = b64ToBytes(snap.drive.ram);
  drive.bus.ram.set(drvBytes.subarray(0, drive.bus.ram.length));
  restoreCpu(drive.cpu, snap.drive.cpu);
  restoreVia(drive.bus.via1 as never, snap.drive.via1);
  restoreVia(drive.bus.via2 as never, snap.drive.via2);
  session.headPosition.reset(snap.drive.head.track);
  // Keyboard + joystick.
  const kb = session.keyboard as unknown as { matrixCols?: number[] };
  if (kb.matrixCols && snap.keyboard.matrixCols.length === kb.matrixCols.length) {
    for (let i = 0; i < kb.matrixCols.length; i++) kb.matrixCols[i] = snap.keyboard.matrixCols[i]!;
  }
  session.joystick2.up = snap.joystick2.up;
  session.joystick2.down = snap.joystick2.down;
  session.joystick2.left = snap.joystick2.left;
  session.joystick2.right = snap.joystick2.right;
  session.joystick2.fire = snap.joystick2.fire;
}

// Stable JSON for equality comparison (sorted keys, no undefined).
export function snapshotToString(snap: SessionSnapshot): string {
  return JSON.stringify(snap, Object.keys(snap).sort());
}
