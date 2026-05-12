# Input Fidelity Notes (Spec 107 / M2.5) — v1

## v1 status

| Sub-story | Status     | Where                                                          |
|-----------|------------|----------------------------------------------------------------|
| M2.5a Joystick port 1 + 2 | **Covered** | `cia1.ts` PB now ANDs joystick1 mask into keyboard rows; PA stays joystick2 |
| M2.5b RESTORE NMI         | **Covered** | `session.triggerRestoreNmi()` sets CIA2 ICR FLAG bit + mask → asserts CIA2 IRQ line |
| M2.5c Paddle storage      | **Covered** | `session.paddles[4]` + `setPaddle(idx, value)`; SID POT readback bridge in Spec 108 |
| M2.5d Scenario player     | **Covered** | `ScenarioPlayer` with cycle/frame scheduling, JSON-shape steps; YAML loader deferred |
| M2.5e Documentation       | **This file** | — |

`npm run smoke:input-fidelity` — 21/21 pass.
`npm run regress` — 5/5 still green.

## API

```ts
// Joystick port 2 (most common — paddle-style games)
session.setJoystick2({ up: true, fire: true });

// Joystick port 1 (typically two-player games)
session.setJoystick1({ left: true });

// Paddle 0..3 (POT readback wired through SID)
session.setPaddle(0, 0xff);   // fully clockwise
session.setPaddle(2, 0x80);   // mid-position

// RESTORE-key NMI
session.triggerRestoreNmi();
```

## Joystick wiring (M2.5a)

CIA1 PA bit assignment:
- PA0..4 = joystick port 2 (active-low)

CIA1 PB bit assignment:
- PB0..4 = joystick port 1 (active-low) ANDed with keyboard rows

Sprint 93.1 already wired PA → joystick2. Spec 107 v1 adds joystick1
on PB through the keyboard backend, so a keyboard row read returns
`kbRows & joystickActiveLowMask(joy1)`. This matches real HW where
joystick port 1 directly pulls PB pins low when actuated.

## RESTORE NMI (M2.5b)

Real HW: RESTORE key drives CIA2 PB6 (FLAG) low edge → CIA2 ICR FLAG
bit set → CIA2 IRQ line → C64 NMI. Our model: `triggerRestoreNmi`
sets `cia2.icrFlags |= 0x10` + `cia2.icrMask |= 0x10` and the
existing `IntegratedSession.checkC64Interrupts` path picks up the
edge on next CPU instruction boundary.

Software-detect path: KERNAL NMI handler at $FE43 saves regs +
JMP through ($0318) NMI vector. Custom NMI handlers can sense
RESTORE by reading $DD0D (CIA2 ICR) and checking bit 4 (FLAG).

## Scenario player (M2.5d)

JSON-shape input scenarios:

```ts
import { ScenarioPlayer } from "src/runtime/headless/input/scenario-player.ts";

const player = new ScenarioPlayer({
  steps: [
    { atFrame: 60,    kind: "type",    text: "RUN\r" },
    { atCycle: 1_000_000, kind: "joy2", state: { fire: true } },
    { atFrame: 120,   kind: "paddle",  idx: 0, value: 0xff },
    { atFrame: 200,   kind: "restore" },
  ],
});

// In your run loop:
for (let i = 0; i < N; i++) {
  session.runFor(1);
  player.tick(session, session.c64Cpu.cycles);
}
```

Sort happens at construction (steps replay in absolute-cycle order
regardless of input order). Frame scheduling defaults to PAL
(`cyclesPerFrame: 19656`); pass `cyclesPerFrame: 17030` for NTSC.

YAML loader deferred — Spec 124 (M5.4 scenario DSL) extends the
shape with full deserialization without breaking JSON consumers.

## Documented gaps

- **Per-cycle joystick resolution**: API is per-call instantaneous;
  there is no scheduler hook to set joystick state at a specific
  cycle within an instruction. Fine for game-pace input; not
  suitable for raster-IRQ-precise input macros.
- **Key debounce**: keyboard matrix reflects the last `setKey`
  call. Real HW has ~10ms scan + key-bounce filtering in KERNAL.
- **Paddle pulse-mode 256 → ramp timing**: real SID measures POT
  via timed cap charge → 9-bit ramp (~512 cycles per step). Our
  POT readback is direct value; no ramp timing emulation. Software
  that reads POT mid-charge sees instant value instead of partial
  ramp. Acceptable for poll-rate paddle drivers; not for
  measure-the-discharge tricks.
- **CIA2 PB6 (RESTORE-key) edge detection**: we set FLAG bit
  directly. Real HW only fires NMI on the falling edge; level-
  triggered + non-edge writes don't fire. Our model fires
  immediately on `triggerRestoreNmi()` call.

## Files

- `src/runtime/headless/peripherals/cia1.ts` — joystick1 wired into PB.
- `src/runtime/headless/integrated-session.ts` — `joystick1`,
  `paddles[]`, `setJoystick1`, `setPaddle`, `triggerRestoreNmi`.
- `src/runtime/headless/input/scenario-player.ts` — `ScenarioPlayer`.
- `src/runtime/headless/c64/input-fidelity-tests.ts` — 4 suites,
  21 fixture checks.
- `scripts/smoke-input-fidelity.mjs` + `npm run smoke:input-fidelity`.
