# Spec 231 — Deterministic replay & rerun

**Sprint:** 124
**Status:** PROPOSED 2026-05-08
**Depends on:** 134 (snapshot/resume), 205 (trace contract), 215 (byte-exact reset)
**Master:** 230

## Goal

Same scenario from same starting state produces byte-identical
output every run: trace.jsonl byte-equal, RAM end-state byte-equal,
screenshot pixel-equal. Without this, no other V2 primitive is
meaningful — agents cannot reason about runs that drift.

## Scope

### In scope

- Reset state byte-exact (Spec 215 already done; verify hold).
- Snapshot save/restore round-trips byte-exact (Spec 134 already
  done; verify hold across all chip states).
- Cycle-stable RNG: any non-determinism source (cpu-port falloff
  random jitter from Spec 219-c4, ram-pattern random_chance) seeded
  from snapshot state, not wall clock.
- Schedule a `Scenario` artifact: `{startSnapshot, inputEvents,
  cycleBudget, expectedHash}` and replay it twice.

### Out of scope

- VICE comparison (covered by 236).
- Wall-clock-bound features (audio playback timing) — V3.

## Surface

```ts
// src/runtime/headless/replay/scenario.ts (new)
export interface ScenarioInputEvent {
  atCycle: number;
  kind: "keyboard" | "joystick1" | "joystick2";
  payload: unknown;
}
export interface Scenario {
  id: string;
  startSnapshot: unknown;
  inputs: ScenarioInputEvent[];
  cycleBudget: number;
  diskPath?: string;
  mode: "fast-trap" | "real-kernal" | "true-drive";
}
export interface ReplayResult {
  endSnapshotHash: string;     // sha256 of canonical snapshot
  ramHash: string;             // sha256 of c64Bus.ram
  screenshotHash: string;      // sha256 of renderToPng output
  traceHash: string;           // sha256 of trace.jsonl bytes
  cyclesRan: number;
}
export function runScenario(s: Scenario): ReplayResult;
```

## Random-source audit

Audit script `scripts/audit-replay-determinism.mjs` greps for
`Math.random` / `Date.now` / `process.hrtime` in
`src/runtime/headless/**` outside an allowlist (= snapshot meta
only). Failures = potential drift.

Replace any random that affects emulator state with snapshot-seeded
PRNG (xorshift seeded from snapshot's `prng_seed` field).

## Acceptance

- `npm run test:replay` runs scenarios `c64-ready`, `motm-dir-load`,
  `mm-s1-boot` twice each. All four hashes byte-equal.
- `audit:replay-determinism` finds 0 violations or all annotated.
- Replay round-trip across snapshot → run → snapshot byte-equal.
- E2E ladder still 6/6 PASS.

## Open questions

- Wall-clock budget in test profiles (`walltimeMs`) is determinism-
  hostile. Resolution: it's an upper bound, not part of scenario
  state; agent should not snapshot mid-walltime-budget runs.
