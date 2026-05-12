// Sprint 106 (Specs 117-121) v1 — visual runtime fixture suite.
//
// Covers framebuffer descriptor (Spec 117), screen-state JSON shape
// (Spec 119), input-macro extension (Spec 120), and visual-acceptance
// hash compare (Spec 121).

import { startIntegratedSession } from "../integrated-session-manager.js";
import { captureScreenState, screenStateHash } from "./screen-state.js";
import { ScenarioPlayer } from "../input/scenario-player.js";
import { assertVisualState } from "../regress/visual-acceptance.js";

const FIXTURE = "samples/synthetic/1byte.g64";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M4.1 — framebuffer descriptor ---

export function runFramebufferDescriptorTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  session.resetCold("pal-default");
  session.runFor(800_000);
  const desc = session.renderDescriptor();
  out.push(check("descriptor.width = 504", desc.width === 504));
  out.push(check("descriptor.height = 312", desc.height === 312));
  out.push(check("descriptor.mode in valid set",
    ["text", "bitmap", "multicolor", "ecm"].includes(desc.mode),
    `mode=${desc.mode}`));
  out.push(check("descriptor.ranges has screen + color",
    desc.ranges.screen >= 0 && desc.ranges.color === 0xd800));
  out.push(check("descriptor.ranges.bank in 0..3 (in $0..$C000)",
    desc.ranges.bank === 0 || desc.ranges.bank === 0x4000 || desc.ranges.bank === 0x8000 || desc.ranges.bank === 0xC000));
  return out;
}

// --- M4.3 — screen-state shape ---

export function runScreenStateTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  session.resetCold("pal-default");
  session.runFor(1_500_000); // until BASIC ready
  const state = captureScreenState(session);
  out.push(check("textGrid 25 rows", state.textGrid.length === 25));
  out.push(check("textGrid each row 40 chars", state.textGrid.every((r) => r.length === 40)));
  out.push(check("colorGrid 25 × 40", state.colorGrid.length === 25 && state.colorGrid[0]!.length === 40));
  out.push(check("sprites = 8 entries", state.sprites.length === 8));
  out.push(check("vicMode in valid set",
    ["text", "multicolor-text", "ecm-text", "bitmap", "multicolor-bitmap"].includes(state.vicMode)));
  // BASIC ready screen contains "READY." somewhere.
  const flat = state.textGrid.join(" ");
  out.push(check("text contains READY",
    flat.includes("READY") || flat.includes("ready"),
    `flat=${flat.slice(0, 200)}`));
  // Hash deterministic.
  const h1 = screenStateHash(state);
  const h2 = screenStateHash(state);
  out.push(check("hash deterministic", h1 === h2));
  return out;
}

// --- M4.4 — input macro: joystickScript ---

export function runInputMacroTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  session.resetCold("pal-default");
  const player = new ScenarioPlayer({
    steps: [
      {
        atCycle: 0, kind: "joystickScript", port: 2,
        sequence: [
          { state: { up: true },   durationFrames: 1 },
          { state: { up: false, fire: true }, durationFrames: 1 },
          { state: { fire: false }, durationFrames: 1 },
        ],
      },
    ],
  });
  out.push(check("joy2 default neutral", session.joystick2.fire === false));
  player.tick(session, 1);
  // After whole script: last entry sets fire=false.
  out.push(check("after joystickScript: joy2 fire = false (last in sequence)",
    session.joystick2.fire === false));
  return out;
}

// --- M4.5 — visual-acceptance hash compare ---

export function runVisualAcceptanceTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { session } = startIntegratedSession({ diskPath: FIXTURE, mode: "true-drive" });
  session.resetCold("pal-default");
  session.runFor(1_500_000);
  const state = captureScreenState(session);
  const baselineHash = screenStateHash(state);

  // Self-comparison: identical state should pass.
  const r1 = assertVisualState(session, {
    game: "synthetic",
    phase: "ready",
    stateHash: baselineHash,
    textSnippet: "READY",
  });
  out.push(check("self-compare: pass", r1.pass, r1.reason));
  out.push(check("self-compare: observedHash matches expected", r1.observedHash === r1.expectedHash));

  // Mismatched hash but text-snippet present: soft-pass.
  const r2 = assertVisualState(session, {
    game: "synthetic",
    phase: "ready",
    stateHash: "deadbeef",
    textSnippet: "READY",
  });
  out.push(check("hash-mismatch + snippet match: soft-pass",
    r2.pass === true && r2.textSnippetMatched === true,
    r2.reason));

  // Hard fail: hash + snippet both mismatch.
  const r3 = assertVisualState(session, {
    game: "synthetic",
    phase: "ready",
    stateHash: "00000000",
    textSnippet: "NEVERAPPEARSEVER",
  });
  out.push(check("hash+snippet mismatch: fail", r3.pass === false));

  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllVisualRuntimeTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M4.1 framebuffer descriptor", runner: runFramebufferDescriptorTest },
    { name: "M4.3 screen-state",            runner: runScreenStateTest },
    { name: "M4.4 input macro",             runner: runInputMacroTest },
    { name: "M4.5 visual acceptance",       runner: runVisualAcceptanceTest },
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
