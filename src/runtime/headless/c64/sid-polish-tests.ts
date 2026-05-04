// Sprint 109 (Specs 130-132) v1 — SID polish tests.

import { existsSync, readFileSync } from "node:fs";
import { Sid6581 } from "../peripherals/sid.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M7.1 — register stability across all 32 addresses ---

export function runRegisterStabilityTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const sid = new Sid6581();
  // Write monotonic pattern; read back where data sheet allows.
  for (let r = 0; r < 0x19; r++) sid.write(r, r * 7 & 0xff);
  // Read back: writable registers $00-$18 should round-trip.
  let mismatches = 0;
  for (let r = 0; r < 0x19; r++) {
    if (sid.read(r) !== ((r * 7) & 0xff)) mismatches++;
  }
  out.push(check("0..0x18 write/read round-trip (no read-clear)",
    mismatches === 0, `mismatches=${mismatches}`));
  // $1D-$1F open-bus stub (returns 0).
  out.push(check("$1D = 0 (open bus)", sid.read(0x1d) === 0));
  out.push(check("$1F = 0 (open bus)", sid.read(0x1f) === 0));
  return out;
}

// --- M7.2 — write trace ---

export function runWriteTraceTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const sid = new Sid6581();
  const events: { addr: number; value: number }[] = [];
  sid.writeTrace = (addr, value) => events.push({ addr, value });
  sid.write(0x04, 0x21);
  sid.write(0x18, 0x0f);
  sid.write(0x1d, 0xff); // open-bus / unwritable still records
  out.push(check("trace captures 3 writes", events.length === 3,
    `count=${events.length}`));
  out.push(check("trace[0] = ($04, $21)",
    events[0]!.addr === 0x04 && events[0]!.value === 0x21));
  out.push(check("trace[1] = ($18, $0f)",
    events[1]!.addr === 0x18 && events[1]!.value === 0x0f));

  // Removing trace stops further capture.
  sid.writeTrace = undefined;
  sid.write(0x04, 0x55);
  out.push(check("after removing writeTrace: no further events",
    events.length === 3));
  return out;
}

// --- M7.3 — no-audio boundary scan (lint-style) ---

export function runNoAudioBoundaryScanTest(): CheckResult[] {
  const out: CheckResult[] = [];
  // Simple substring scan over the active SID + integrated-session
  // source files. We just assert no audio-related identifiers leak
  // through.
  const fs = (() => {
    return { existsSync, readFileSync };
  })();
  const sources = [
    "src/runtime/headless/peripherals/sid.ts",
    "src/runtime/headless/integrated-session.ts",
    "src/runtime/headless/integrated-session-manager.ts",
  ];
  const banned = ["AudioContext", "WavWriter", "AudioOutput", "playSamples", "audioBuffer"];
  let leaks: string[] = [];
  for (const path of sources) {
    if (!fs.existsSync(path)) continue;
    const src = fs.readFileSync(path, "utf8");
    for (const term of banned) {
      // Skip the policy-stating comments themselves.
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.includes(term)) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        leaks.push(`${path}:${i + 1}: ${trimmed.slice(0, 120)}`);
      }
    }
  }
  out.push(check("no audio identifiers in active runtime code",
    leaks.length === 0, leaks.join(" | ").slice(0, 300)));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllSidPolishTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M7.1 register stability",  runner: runRegisterStabilityTest },
    { name: "M7.2 write trace",         runner: runWriteTraceTest },
    { name: "M7.3 no-audio boundary",   runner: runNoAudioBoundaryScanTest },
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
