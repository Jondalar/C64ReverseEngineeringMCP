# Multi-Drive Architecture (Spec 115 / M3.7) — v1

## v1 scope

API shape only. Sessions can declare 1-2 drives via the `drives`
array; runtime instantiates only the device-8 (primary) entry. The
device-9 entry is validated and exposed via
`session.multiDriveDeferred[]` so callers can detect the configuration
without a runtime crash. Second-drive runtime wiring is tracked under
M3.7 v2 follow-up — see "Open follow-ups" below.

`npm run smoke:multi-drive` — 20/20 pass.

## API

```ts
import { startIntegratedSession } from "src/runtime/headless/integrated-session-manager.js";

// Single-drive (legacy, still supported):
startIntegratedSession({ diskPath: "game.g64", mode: "true-drive" });

// Multi-drive shape:
startIntegratedSession({
  diskPath: "/unused-overridden",   // any non-empty placeholder; drives[] takes precedence
  drives: [
    { id: 8, disk: "game.g64" },
    { id: 9, disk: "data.d64" },    // VALIDATED but not yet active in v1
  ],
  mode: "true-drive",
});
```

When `drives[]` is set:

- The runtime picks the **device-8 entry** as primary (or the first
  entry if device 8 isn't listed).
- Per-drive `startTrack` / `writeProtected` overrides fold into the
  primary slot.
- All non-primary entries land in `session.multiDriveDeferred[]`.

## Validation rules (M3.7d)

`validateDrives(drives: DriveConfig[])` enforces:

- at least 1 drive, at most `MULTI_DRIVE_MAX = 2`
- each `id ∈ MULTI_DRIVE_VALID_IDS = [8, 9]`
- no duplicate ids
- non-empty disk path

Invalid configs throw at session start with a clear message
fragment (`max 2`, `id must be 8 or 9`, `duplicate`, `disk path missing`).

## v1 deviations / not yet wired

- **Device 9 runtime**: declared but not instantiated. KERNAL `LOAD ...,9`
  will fall through to device-not-present until M3.7 v2 lands.
- **Per-drive ROM banks**: only device 8's ROM is loaded. Drive 9
  v2 will need its own DriveCpu + DriveBus + IEC routing.
- **IEC bus multi-device routing (M3.7b)**: deferred. Current bus
  treats the addressed-device match as device 8 only.
- **Hot-swap during running session**: out of scope.
- **Drives 10/11**: explicitly out of scope per spec.

## Open follow-ups (v2)

- Instantiate a second `DriveCpu` per `drives[1]` entry.
- Extend `IecBus` to track multiple drive instances; route
  `LISTEN $20+dev` and `TALK $40+dev` to the matching jumper-id.
- Synthetic 2-drive fixture in `samples/synthetic/multi-drive/`.
- Update `IntegratedSession.status()` to report all attached drives.

## Files

- `src/runtime/headless/integrated-session.ts` —
  `DriveConfig`, `validateDrives`, `MULTI_DRIVE_MAX`,
  `MULTI_DRIVE_VALID_IDS`, `multiDriveDeferred[]`.
- `src/runtime/headless/drive/multi-drive-tests.ts` — 20 fixture checks.
- `scripts/smoke-multi-drive.mjs` + `npm run smoke:multi-drive`.
