# Snapshot Schema (Spec 101 / M1.4)

`session.snapshot()` returns a single canonical JSON document covering
the software-visible state of an `IntegratedSession`. Round-trippable:
`session.restore(snapshot)` produces a session for which a subsequent
`snapshot()` call returns an equal payload.

`schema_version: 1` — bumping requires a corresponding bump in
`SNAPSHOT_SCHEMA_VERSION` and a changelog entry below.

## Shape (v1)

```jsonc
{
  "schemaVersion": 1,
  "mode": "true-drive",          // SessionMode (Spec 098)
  "cycles": {
    "c64": 100000,
    "drive": 101477,
    "instructions": 23456
  },
  "cpu": {                       // C64 6510
    "pc": 0xE5CD, "a": 0x00, "x": 0xFF, "y": 0x00,
    "sp": 0xF7, "flags": 0x24, "cycles": 100000
  },
  "ram": "<base64>",             // 64KB; only when include=["ram"]
  "iec": {
    "c64Atn": true,  "c64Clk": true,  "c64Data": true,
    "drvClk": true,  "drvData": true, "drvAtnAck": true
  },
  "drive": {
    "cpu": { /* CpuSnapshot */ },
    "ram": "<base64>",            // 2KB drive RAM (always included)
    "via1": { /* ViaSnapshot */ },
    "via2": { /* ViaSnapshot */ },
    "head": { "track": 18 }
  },
  "keyboard": { "matrixCols": [255, 255, 255, 255, 255, 255, 255, 255] },
  "joystick2": {
    "up": false, "down": false, "left": false, "right": false, "fire": false
  }
}
```

## ViaSnapshot

```jsonc
{
  "ora": 0x00, "orb": 0x00, "ddra": 0x00, "ddrb": 0x00,
  "t1Counter": 0xFFFF, "t1Latch": 0x0000, "t2Counter": 0x0000,
  "acr": 0x00, "pcr": 0x00, "ifr": 0x00, "ier": 0x00, "sr": 0x00
}
```

## Round-trip contract

`snapshotToString(snap)` produces a stable string (sorted keys,
no `undefined`). The MD5 of `snapshotToString(snap)` MUST equal
`snapshotToString(snapshot(restore(session, snap)))` modulo what
the caller chose to include.

## Include sections

`snapshot(session, { include: ["ram", "tracks"] })`:
- `ram`: emit base64 of full 64KB C64 RAM. Default omits ROM-shadow
  noise; opt-in for full diff cases.
- `tracks` (planned): emit per-track GCR buffers from the drive.
  Currently TODO; bump schema_version when implemented.

## Boundary contract

Snapshot is always taken **at instruction boundary** (no mid-cycle
microcoded state). Restore likewise places execution at instruction
boundary; the next instruction starts fresh from the restored PC.

## Out of scope (v1)

- VIC pixel pipeline mid-cycle (raster + sprite shifters). Restore
  re-initializes raster from the cycle counter; first frame after
  restore may have a 1-line glitch.
- SID voice phase / envelope generators. Restored as zero; first
  audio frame after restore starts silent and ramps up.
- Persistent disk snapshots (Milestone 8 territory).
- VICE VSF compatibility.

## Changelog

- v1 (2026-05-04): initial. CPU + RAM + IEC + drive + keyboard +
  joystick. Round-trip smoke green at `npm run smoke:snapshot`.
