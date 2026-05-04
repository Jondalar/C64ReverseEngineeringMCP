// Spec 116 (M3.8) — drive fidelity backlog tests + gap-coverage checks.
//
// Per spec exit criterion: each acceptance bullet is either covered by
// a test fixture (this file) or recorded in
// docs/drive-fidelity-backlog.md as an explicit gap with rationale.
// This file ships the tests; the doc lists remaining gaps.

import { HeadPosition, TrackBuffer } from "./head-position.js";
import { encodeSectorGCR } from "../../../disk/gcr-encode.js";
import { makeGcrVia2Pb, type Via2GcrCoupling } from "./via2-gcr.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M3.8b — track-zero stop ---

export function runTrackZeroStopTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const head = new HeadPosition({ startTrack: 1 });
  out.push(check("init: track 1 = halfTrack 2",
    head.currentHalfTrack === 2 && head.currentTrack === 1));

  // 100 stepOutward calls cannot move head below track 1.
  for (let i = 0; i < 100; i++) head.stepOutward();
  out.push(check("100x stepOutward: head still at track 1",
    head.currentHalfTrack === 2,
    `halfTrack=${head.currentHalfTrack}`));

  // Inward steps still work after hitting the stop.
  head.stepInward();
  out.push(check("stepInward after stop: track 1.5",
    head.currentHalfTrack === 3));

  return out;
}

// --- M3.8f — disk-change WP semantics ---

class FakeG64Source {
  private readonly tracks = new Map<number, Uint8Array>();
  setTrack(track: number, bytes: Uint8Array): void { this.tracks.set(track, bytes); }
  getRawTrackBytes(track: number): Uint8Array | null { return this.tracks.get(track) ?? null; }
}

export function runDiskChangeWpTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const PB_WPS = 1 << 4;

  const src = new FakeG64Source();
  src.setTrack(18, encodeSectorGCR(18, 0, 0x53, 0x31, new Uint8Array(256), 8));
  const tb = new TrackBuffer(src as unknown as { getRawTrackBytes: (t: number) => Uint8Array | null } as never);
  const head = new HeadPosition({ startTrack: 18 });

  // Mutable coupling so disk-change can flip WP in place — production
  // code holds a single coupling reference per drive instance.
  const coupling: Via2GcrCoupling = { trackBuffer: tb, headPosition: head, writeProtected: false };
  const pb = makeGcrVia2Pb(coupling);

  out.push(check("initial: WP line high (not protected)",
    (pb.readPins() & PB_WPS) !== 0));

  // Simulate disk swap to write-protected disk.
  coupling.writeProtected = true;
  out.push(check("post-swap to WP disk: WP line low",
    (pb.readPins() & PB_WPS) === 0));

  // Swap back to writable disk.
  coupling.writeProtected = false;
  out.push(check("post-swap to writable: WP line high",
    (pb.readPins() & PB_WPS) !== 0));

  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllDriveFidelityBacklogTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M3.8b track-zero stop",   runner: runTrackZeroStopTest },
    { name: "M3.8f disk-change WP",     runner: runDiskChangeWpTest },
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
