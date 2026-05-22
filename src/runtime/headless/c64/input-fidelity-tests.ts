// Spec 107 (M2.5) v1 — input fidelity tests.
//
// Covers joystick port 1 + 2 wiring, paddle storage, RESTORE NMI,
// and scenario-player scheduling math.

import { startIntegratedSession } from "../integrated-session-manager.js";
import { ScenarioPlayer } from "../input/scenario-player.js";

const FIXTURE = "samples/synthetic/1byte.g64";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M2.5a — joystick 1 + 2 distinct, neutral default ---

export function runJoystickPortsTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  out.push(check("joy1 default neutral", !session.joystick1.up && !session.joystick1.fire));
  out.push(check("joy2 default neutral", !session.joystick2.up && !session.joystick2.fire));

  session.setJoystick1({ up: true, fire: true });
  out.push(check("joy1 set: up=true fire=true",
    session.joystick1.up === true && session.joystick1.fire === true));
  out.push(check("joy2 unaffected",
    session.joystick2.up === false));

  session.setJoystick2({ left: true });
  out.push(check("joy2 set: left=true",
    session.joystick2.left === true));
  out.push(check("joy1 still independent",
    session.joystick1.up === true));

  return out;
}

// --- M2.5c — paddle storage ---

export function runPaddleTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  out.push(check("paddles[] initialised to 4 slots",
    session.paddles.length === 4));
  // Spec 429: unconnected POT lines default to $80 (VICE-match), not 0.
  out.push(check("paddles default $80 (no paddle, VICE-match)",
    session.paddles[0] === 0x80 && session.paddles[3] === 0x80));

  session.setPaddle(0, 0xff);
  session.setPaddle(1, 0x80);
  session.setPaddle(2, 0x40);
  session.setPaddle(3, 0x10);
  out.push(check("setPaddle 0..3 round-trip",
    session.paddles[0] === 0xff
    && session.paddles[1] === 0x80
    && session.paddles[2] === 0x40
    && session.paddles[3] === 0x10));

  // Value masked to 8 bits.
  session.setPaddle(0, 0x1ff);
  out.push(check("paddle value masked to 8 bits",
    session.paddles[0] === 0xff));

  return out;
}

// --- M2.5b — RESTORE NMI sets CIA2 IFR FLAG bit + asserts NMI ---

export function runRestoreNmiTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });

  out.push(check("CIA2 IFR FLAG bit clear initially",
    (session.cia2.icrFlags & 0x10) === 0));
  out.push(check("CIA2 IRQ line not asserted initially",
    session.cia2.irqAsserted() === false));

  session.triggerRestoreNmi();
  out.push(check("after triggerRestoreNmi: FLAG bit set",
    (session.cia2.icrFlags & 0x10) !== 0));
  out.push(check("after triggerRestoreNmi: mask FLAG bit set",
    (session.cia2.icrMask & 0x10) !== 0));
  out.push(check("after triggerRestoreNmi: CIA2 IRQ asserted",
    session.cia2.irqAsserted() === true));

  return out;
}

// --- M2.5d — scenario player schedule ---

export function runScenarioPlayerTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  const player = new ScenarioPlayer({
    steps: [
      { atCycle: 1000,  kind: "joy1", state: { up: true } },
      { atFrame: 2,     kind: "paddle", idx: 0, value: 0x42 }, // 2 * 19656 = 39312
      { atCycle: 50000, kind: "joy2", state: { fire: true } },
      { atCycle: 100,   kind: "restore" }, // out-of-order — should sort first
    ],
  });
  out.push(check("4 steps queued", player.remaining() === 4));

  // Tick at cycle 0: nothing due.
  let fired = player.tick(session, 0);
  out.push(check("at cyc 0: 0 fired", fired === 0));

  // Tick at cycle 200: restore (cyc 100) fires.
  fired = player.tick(session, 200);
  out.push(check("at cyc 200: restore fired", fired === 1 && (session.cia2.icrFlags & 0x10) !== 0));

  // Tick at cycle 1500: joy1 (cyc 1000).
  fired = player.tick(session, 1500);
  out.push(check("at cyc 1500: joy1 fired", fired === 1 && session.joystick1.up === true));

  // Tick at cycle 60000: joy2 + paddle both due.
  fired = player.tick(session, 60000);
  out.push(check("at cyc 60000: joy2 + paddle fired", fired === 2
    && session.joystick2.fire === true
    && session.paddles[0] === 0x42));

  out.push(check("queue empty", player.remaining() === 0));

  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllInputFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.5a joystick ports 1+2", runner: runJoystickPortsTest },
    { name: "M2.5c paddle storage",      runner: runPaddleTest },
    { name: "M2.5b RESTORE NMI",         runner: runRestoreNmiTest },
    { name: "M2.5d scenario player",     runner: runScenarioPlayerTest },
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
