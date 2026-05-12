// Spec 113 (M3.5) — G64 GCR shifter fidelity tests.
//
// Pin motor gating, density override, half-track behavior, write-
// protect line, cross-zone sync detection. Pure unit fixtures —
// minimal fake G64 source, no full session.

import { TrackBuffer, HeadPosition } from "./head-position.js";
import { encodeSectorGCR } from "../../../disk/gcr-encode.js";
import { makeGcrVia2Pb } from "./via2-gcr.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// Minimal fake G64 source: feed any track query a hand-built GCR stream.
// Just enough for TrackBuffer to lazy-load via getRawTrackBytes(track).
class FakeG64Source {
  private readonly tracks = new Map<number, Uint8Array>();
  setTrack(track: number, bytes: Uint8Array): void { this.tracks.set(track, bytes); }
  getRawTrackBytes(track: number): Uint8Array | null {
    return this.tracks.get(track) ?? null;
  }
}

function makeBuf(): { tb: TrackBuffer; src: FakeG64Source } {
  const src = new FakeG64Source();
  const tb = new TrackBuffer(src as unknown as { getRawTrackBytes: (t: number) => Uint8Array | null } as never);
  return { tb, src };
}

// --- M3.5a — motor gating ---

export function runMotorGateTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { tb, src } = makeBuf();
  // Build a synthetic track with a single sector (lots of $ff syncs).
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;
  src.setTrack(18, encodeSectorGCR(18, 0, 0x53, 0x31, data, 8));

  // Motor off → no byte-ready.
  let byteReadyCount = 0;
  tb.onByteReady = () => { byteReadyCount++; };
  tb.setMotorOn(false);
  for (let i = 0; i < 5000; i++) tb.tickShifter(1, 18);
  out.push(check("motor off: byte-ready never fires", byteReadyCount === 0, `count=${byteReadyCount}`));

  // Motor on → bytes flow.
  tb.setMotorOn(true);
  for (let i = 0; i < 5000; i++) tb.tickShifter(1, 18);
  out.push(check("motor on: byte-ready fires", byteReadyCount > 0, `count=${byteReadyCount}`));

  return out;
}

// --- M3.5b — density override ---

export function runDensityOverrideTest(): CheckResult[] {
  const out: CheckResult[] = [];
  // Static cycle counts per zone:
  out.push(check("zone 0 (track 31-35) = 32 cyc/byte", TrackBuffer.cyclesPerByteForZone(0) === 32));
  out.push(check("zone 1 (track 25-30) = 28 cyc/byte", TrackBuffer.cyclesPerByteForZone(1) === 28));
  out.push(check("zone 2 (track 18-24) = 26 cyc/byte", TrackBuffer.cyclesPerByteForZone(2) === 26));
  out.push(check("zone 3 (track  1-17) = 24 cyc/byte", TrackBuffer.cyclesPerByteForZone(3) === 24));
  out.push(check("track-derived zone 18 == zone 2",     TrackBuffer.cyclesPerByteForTrack(18) === TrackBuffer.cyclesPerByteForZone(2)));
  out.push(check("track-derived zone 31 == zone 0",     TrackBuffer.cyclesPerByteForTrack(31) === TrackBuffer.cyclesPerByteForZone(0)));

  // Behavioral: with override forcing zone 0 (slower) we get fewer
  // bytes per N cycles vs. track-derived zone 2.
  const { tb, src } = makeBuf();
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i & 0xff;
  src.setTrack(18, encodeSectorGCR(18, 0, 0x53, 0x31, data, 8));

  let bytesAtTrackDefault = 0;
  tb.onByteReady = () => { bytesAtTrackDefault++; };
  for (let i = 0; i < 8000; i++) tb.tickShifter(1, 18);

  const tb2 = new TrackBuffer(src as unknown as { getRawTrackBytes: (t: number) => Uint8Array | null } as never);
  let bytesAtForcedZone0 = 0;
  tb2.onByteReady = () => { bytesAtForcedZone0++; };
  tb2.setDensityOverride(0); // force zone 0 = 32 cyc/byte
  for (let i = 0; i < 8000; i++) tb2.tickShifter(1, 18);

  out.push(check("forced zone 0 produces fewer bytes than track-default zone 2",
    bytesAtForcedZone0 < bytesAtTrackDefault,
    `zone0=${bytesAtForcedZone0} vs default=${bytesAtTrackDefault}`));

  return out;
}

// --- M3.5c — half-track read returns garbage / no sync ---

export function runHalfTrackReadTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { tb, src } = makeBuf();
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = 0xff; // all ones (would otherwise be all-sync)
  src.setTrack(18, encodeSectorGCR(18, 0, 0x53, 0x31, data, 8));

  tb.setHalfTrackMode(true);
  let bytes = 0;
  let syncSeen = false;
  tb.onByteReady = () => {
    bytes++;
    if (tb.syncDetected()) syncSeen = true;
  };
  for (let i = 0; i < 4000; i++) tb.tickShifter(1, 18);
  out.push(check("half-track: no SYNC ever detected", !syncSeen));
  out.push(check("half-track: bytes still latch", bytes > 0, `bytes=${bytes}`));

  // Transition out of half-track mode → SYNC eventually re-appears
  // because real GCR stream has 5×$ff SYNC runs. Allow a full track
  // scan to find one.
  tb.setHalfTrackMode(false);
  let syncReturnedAt = -1;
  for (let i = 0; i < 100_000 && syncReturnedAt < 0; i++) {
    tb.tickShifter(1, 18);
    if (tb.syncDetected()) syncReturnedAt = i;
  }
  out.push(check("integer track resumes valid SYNC", syncReturnedAt >= 0, `at iter=${syncReturnedAt}`));

  return out;
}

// --- M3.5d — write-protect line via VIA2 PB ---

export function runWriteProtectTest(): CheckResult[] {
  // Read-only check: PB_WPS bit reflects writeProtected option.
  const out: CheckResult[] = [];
  // Re-import constants here to avoid drag from via2-gcr; check value
  // via direct bit math.
  const PB_WPS = 1 << 4;

  const { tb } = makeBuf();
  const headPos = new HeadPosition({ startTrack: 18 });

  const pbBackendUnprot = makeGcrVia2Pb({ trackBuffer: tb, headPosition: headPos, writeProtected: false });
  out.push(check("unprotected: PB_WPS bit set (line high)", (pbBackendUnprot.readPins() & PB_WPS) !== 0));

  const pbBackendProt = makeGcrVia2Pb({ trackBuffer: tb, headPosition: headPos, writeProtected: true });
  out.push(check("protected: PB_WPS bit clear (line low)", (pbBackendProt.readPins() & PB_WPS) === 0));

  return out;
}

// --- M3.5e — cross-zone sync detection ---

export function runCrossZoneSyncTest(): CheckResult[] {
  const out: CheckResult[] = [];
  // Build sectors on tracks 17 (zone 3), 18 (zone 2), 24 (zone 2), 25 (zone 1),
  // 30 (zone 1), 31 (zone 0). Assert SYNC fires on each.
  const tracks = [17, 18, 24, 25, 30, 31];
  for (const t of tracks) {
    const { tb, src } = makeBuf();
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i & 0xff;
    src.setTrack(t, encodeSectorGCR(t, 0, 0x53, 0x31, data, 8));
    let syncSeen = false;
    for (let i = 0; i < 8000 && !syncSeen; i++) {
      tb.tickShifter(1, t);
      if (tb.syncDetected()) syncSeen = true;
    }
    out.push(check(`SYNC detected on track ${t}`, syncSeen));
  }
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllG64FidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M3.5a motor gating",        runner: runMotorGateTest },
    { name: "M3.5b density override",    runner: runDensityOverrideTest },
    { name: "M3.5c half-track read",     runner: runHalfTrackReadTest },
    { name: "M3.5d write-protect line",  runner: runWriteProtectTest },
    { name: "M3.5e cross-zone sync",     runner: runCrossZoneSyncTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
