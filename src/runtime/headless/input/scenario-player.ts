// Spec 107 (M2.5) v1 — scenario player.
//
// Replays a list of input actions against an IntegratedSession at
// scheduled cycle/frame boundaries. v1 ships a JSON shape; YAML
// loader deferred to follow-up. M5.4 (Spec 124) extends without
// breaking changes.
//
// Action shape:
//   { atCycle?: number, atFrame?: number, kind, ... }
//   - kind=type:    text: string
//   - kind=key:     key: string ("PRESS"|"RELEASE"), name (matrix entry)
//   - kind=joy1 / joy2: state: Partial<JoystickState>
//   - kind=paddle:  idx, value
//   - kind=restore: (no extra fields — fires NMI)
//
// PAL frame = 19656 cycles, NTSC = 17030.

import type { IntegratedSession } from "../integrated-session.js";

export type ScenarioStep =
  | { atCycle?: number; atFrame?: number; kind: "type"; text: string }
  | { atCycle?: number; atFrame?: number; kind: "joy1"; state: { up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean } }
  | { atCycle?: number; atFrame?: number; kind: "joy2"; state: { up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean } }
  | { atCycle?: number; atFrame?: number; kind: "paddle"; idx: 0 | 1 | 2 | 3; value: number }
  | { atCycle?: number; atFrame?: number; kind: "restore" };

export interface ScenarioPlayerOptions {
  steps: ScenarioStep[];
  cyclesPerFrame?: number; // default 19656 (PAL)
}

export class ScenarioPlayer {
  private readonly steps: ScenarioStep[];
  private readonly cyclesPerFrame: number;
  private nextIdx = 0;

  constructor(opts: ScenarioPlayerOptions) {
    this.cyclesPerFrame = opts.cyclesPerFrame ?? 19656;
    // Sort by absolute cycle ascending.
    const withCycle = opts.steps.map((s) => ({
      ...s,
      _absCycle: s.atCycle ?? (s.atFrame !== undefined ? s.atFrame * this.cyclesPerFrame : 0),
    }));
    withCycle.sort((a, b) => a._absCycle - b._absCycle);
    this.steps = withCycle.map((s) => {
      const copy = { ...s };
      delete (copy as { _absCycle?: number })._absCycle;
      return copy;
    });
  }

  // Apply any scheduled steps that have come due as of `currentCycle`.
  // Returns count of steps fired.
  tick(session: IntegratedSession, currentCycle: number): number {
    let fired = 0;
    while (this.nextIdx < this.steps.length) {
      const s = this.steps[this.nextIdx]!;
      const dueAt = s.atCycle ?? (s.atFrame !== undefined ? s.atFrame * this.cyclesPerFrame : 0);
      if (currentCycle < dueAt) break;
      this.dispatch(session, s);
      this.nextIdx++;
      fired++;
    }
    return fired;
  }

  remaining(): number { return this.steps.length - this.nextIdx; }
  reset(): void { this.nextIdx = 0; }

  private dispatch(session: IntegratedSession, step: ScenarioStep): void {
    switch (step.kind) {
      case "type":
        session.typeText(step.text, 80_000, 80_000);
        break;
      case "joy1":
        session.setJoystick1(step.state);
        break;
      case "joy2":
        session.setJoystick2(step.state);
        break;
      case "paddle":
        session.setPaddle(step.idx, step.value);
        break;
      case "restore":
        session.triggerRestoreNmi();
        break;
    }
  }
}
