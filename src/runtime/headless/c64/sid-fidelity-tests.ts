// Spec 108 (M2.6) v1 — SID software-visible behavior tests.
//
// Covers: register write/read round-trip, ADSR envelope readback at
// $D41C (env3), oscillator readback at $D41B (LFSR noise mode), and
// POT readback at $D419/$D41A wired from session.paddles[].
// Audio synthesis explicitly out of scope.

import { startIntegratedSession } from "../integrated-session-manager.js";
import { Sid6581 } from "../peripherals/sid.js";

const FIXTURE = "samples/synthetic/1byte.g64";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M2.6 — register write round-trip ---

export function runRegisterWriteTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const sid = new Sid6581();
  // Voice 1 freq lo/hi.
  sid.write(0x00, 0x34);
  sid.write(0x01, 0x12);
  // PW lo + ctrl.
  sid.write(0x02, 0x55);
  sid.write(0x04, 0x41); // pulse + GATE
  out.push(check("$D400 freq lo round-trip", sid.read(0x00) === 0x34));
  out.push(check("$D401 freq hi round-trip", sid.read(0x01) === 0x12));
  out.push(check("$D402 PW lo round-trip",   sid.read(0x02) === 0x55));
  out.push(check("$D404 voice ctrl round-trip", sid.read(0x04) === 0x41));
  // $D41D-$D41F open-bus.
  out.push(check("$D41D reads 0 (open bus stub)", sid.read(0x1D) === 0));
  out.push(check("$D41F reads 0 (open bus stub)", sid.read(0x1F) === 0));
  return out;
}

// --- M2.6b — ADSR envelope readback ---

export function runEnvelopeReadbackTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const sid = new Sid6581();
  // Voice 3 ($D40E-$D414): freq + ctrl + ADSR.
  // Set ADSR fast attack: AD = $00 (attack=2ms, decay=6ms),
  // SR = $f0 (sustain=15, release=fast).
  sid.write(0x12, 0x10); // pulse selected
  sid.write(0x13, 0x00); // attack=0 decay=0
  sid.write(0x14, 0xf0); // sustain=15 release=0
  // GATE on.
  sid.write(0x12, 0x11);
  out.push(check("env3 starts at 0", sid.read(0x1C) === 0));
  // Tick: attack rate 0 = 2ms (1024 cycles per step on PAL).
  sid.tick(2_000);
  const env1 = sid.read(0x1C);
  out.push(check("env3 climbs after tick", env1 > 0, `env3=${env1}`));

  // Sustain: clear gate triggers release.
  sid.write(0x12, 0x10);
  // After release tick, env decays.
  sid.tick(2_000_000);
  const env2 = sid.read(0x1C);
  out.push(check("env3 in idle / very low after release",
    env2 < 16, `env3=${env2}`));
  return out;
}

// --- M2.6c — POT readback wired to paddles ---

export function runPotReadbackTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  const sid = session.sid;
  // Default paddles = 0.
  out.push(check("$D419 POT A default 0 (paddle 0 default)",
    sid.read(0x19) === 0));
  out.push(check("$D41A POT B default 0 (paddle 2 default)",
    sid.read(0x1A) === 0));

  session.setPaddle(0, 0xab);
  session.setPaddle(2, 0xcd);
  out.push(check("$D419 POT A = paddle[0] after setPaddle 0=$ab",
    sid.read(0x19) === 0xab));
  out.push(check("$D41A POT B = paddle[2] after setPaddle 2=$cd",
    sid.read(0x1A) === 0xcd));

  return out;
}

// --- M2.6 — osc3 readback (LFSR-driven noise) ---

export function runOsc3ReadbackTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const sid = new Sid6581();
  const v0 = sid.read(0x1B);
  sid.tick(1000);
  const v1 = sid.read(0x1B);
  sid.tick(1000);
  const v2 = sid.read(0x1B);
  // Reads should change as LFSR shifts (with high probability over
  // 1000 cycles).
  out.push(check("osc3 readback changes over time",
    !(v0 === v1 && v1 === v2),
    `v0=${v0} v1=${v1} v2=${v2}`));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllSidFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.6 register write/read",   runner: runRegisterWriteTest },
    { name: "M2.6b ADSR envelope readback", runner: runEnvelopeReadbackTest },
    { name: "M2.6c POT → paddle bridge",   runner: runPotReadbackTest },
    { name: "M2.6 osc3 LFSR readback",    runner: runOsc3ReadbackTest },
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
