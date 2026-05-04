# Drive Write Support (Spec 114 / M3.6) — v1

## v1 scope

**TrackBuffer write + side-file persist.** Spec 114 v1 ships and
locks down the byte-level write path through `TrackBuffer.writeByte`
and the existing `session-persist.ts` round-trip:

- writes mutate per-track GCR buffers in place
- modified tracks tracked in `TrackBuffer.modifiedTracks()`
- `persistTrackBuffer` writes `<image>_session.g64` next to the
  original image; original bytes never mutate
- side-file is fully re-parseable as a new G64

**Tests**: `npm run smoke:write-support` — 13/13 pass.

## What is NOT in v1

- **SAVE through real KERNAL ROM + real drive ROM**: BASIC `SAVE`
  drives the C64 KERNAL talker side and the drive listener side
  through the IEC bit-bang protocol. The drive ROM then executes its
  WRITE sector job which clocks GCR bits out via the VIA2 write-side
  BYTE-READY path. The bit-level write loop is not yet emulated;
  drive ROM SAVE write loop will hang or write garbage. Use the
  KERNAL trap suite (`mode: "fast-trap"`) for SAVE round-trip in
  workflows.
- **Scratch / rename**: drive ROM DOS command channel parsing for
  S0:NAME / R0:NEW=OLD. Both rely on BAM + directory walk via real
  drive code; deferred until SAVE is functional.
- **NEW (format)**, **VALIDATE**: explicit out-of-scope per spec.

## API surface

```ts
import { persistTrackBuffer, defaultSessionG64Path } from "./session-persist.js";

// Default path: next to original, suffix _session
const path = defaultSessionG64Path("/path/to/disk.g64");
// → "/path/to/disk_session.g64"

const result = persistTrackBuffer(parser, trackBuffer, "/path/to/disk.g64");
// result = { outputPath, modifiedTracks: [18, 24, ...], bytesWritten }
// or      { skipped: "no-modifications", ... } when no writes happened
```

MCP tool exposing this: `headless_drive_persist_writes`.

## Sub-stories status

- **M3.6a — write-side BYTE-READY**: deferred to v2. Drive ROM write
  loop currently can't complete a SAVE under `true-drive` mode.
- **M3.6b — TrackBuffer write**: shipped. byte-cursor-level writes
  set `modifiedTracks`, persist round-trips correctly.
- **M3.6c — write-back side-file**: shipped. `_session.g64` suffix
  default, explicit `output_path` override supported.
- **M3.6d — SAVE round-trip via real drive ROM**: deferred. Use
  `mode: "fast-trap"` for SAVE workflows.
- **M3.6e — scratch + rename**: deferred to v2.
- **M3.6f — documentation**: this file.

## v2 follow-ups

- Implement write-side BYTE-READY in `TrackBuffer.tickShifter`
  with a write-mode flag. Drive ROM clocks bits OUT via VIA2 PA
  output during sector write commands.
- Wire VIA2 PA `onOutputChanged` (DDR=$ff) to push bits into the
  shifter at the current head position rather than a separate
  byte-cursor.
- Add a SAVE-then-LOAD round-trip fixture under `mode: "true-drive"`
  to the regress matrix once write loop completes.
- DOS command-channel parser: drive ROM at $D7B4 / $D886 handles
  S/R commands once write path works.

## Files

- `src/runtime/headless/drive/head-position.ts` — `TrackBuffer.writeByte`,
  `modifiedTracks()`, `isModified()` (existing).
- `src/runtime/headless/drive/session-persist.ts` — `persistTrackBuffer`,
  `defaultSessionG64Path` (existing).
- `src/runtime/headless/drive/save-load-tests.ts` — Spec 114 v1 fixtures.
- `scripts/smoke-write-support.mjs` + `npm run smoke:write-support`.
- `src/server-tools/headless.ts:1173` — `headless_drive_persist_writes`
  MCP tool wraps the persist API.
