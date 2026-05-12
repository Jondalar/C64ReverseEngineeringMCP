# Headless 1541 drive emulation

Implements R28 / Spec 062 — full L3 drive emulation as part of the
headless C64 runtime. Cycle-accurate dual-clock 6510 (C64) + 6502
(drive) tied via an open-collector IEC bus model. Custom drive
loaders that bypass KERNAL LOAD/SAVE (i.e. virtually every C64 title
1985+) execute correctly without VICE.

## What's modeled

- **Drive 6502** (`src/runtime/headless/drive/drive-cpu.ts`) —
  re-instantiated `Cpu6510` running its own bus.
- **Drive RAM** ($0000-$07FF, 2KB).
- **Drive DOS ROM** ($C000-$FFFF, 16KB) — bundled via
  `scripts/install-1541-rom.sh` to `resources/roms/dos1541-...bin`.
  Override at `C64RE_1541_ROM_PATH`. Repo gitignores `*.bin` to keep
  Commodore IP out of source.
- **VIA1 ($1800-$1BFF)** — full 6522 (T1/T2 timers, IFR/IER, CA1
  edge detection, shift register, DDR-aware port reads/writes).
- **VIA2 ($1C00-$1FFF)** — full 6522 + GCR coupling: PA = $1C01
  read/write head, PB = head step (gray-code), motor, LED, WPS,
  density, SYNC.
- **IEC bus** (`src/runtime/headless/iec/iec-bus.ts`) — open-collector
  wired-AND across CIA2 PA bits 3-7 (C64) and VIA1 PB bits 1/3/4
  (drive). 1541 hardware ATN-ACK auto-pull modeled. ATN edge
  triggers VIA1 CA1 → IRQ vector via the drive's ROM ATN handler.
- **CIA2 stub** (`src/runtime/headless/iec/cia2-stub.ts`) — covers
  only $DD00 PRA + $DD02 DDRA. Other CIA2 functions (timers, TOD,
  user port) deferred to Spec 063 Phase B.
- **Cycle accuracy** — fractional accumulator: `driveCyclesPerC64Cycle
  = 1MHz / 985.248kHz` (PAL) or `/ 1.022727MHz` (NTSC).
- **GCR I/O** — re-uses `src/disk/gcr.ts` for byte-stream encoding;
  TrackBuffer + HeadPosition wrap a G64Parser. Writes mutate an
  in-memory buffer; explicit persist creates `<image>_session.g64`.

## What's NOT modeled (use VICE)

- VIC video — no framebuffer, no raster IRQ register read.
  Headless detects $D011/$D012 polling loops and emits a warning
  suggesting `vice_session_start`. (Spec 063 Phase A adds VIC.)
- SID audio (Spec 063 Phase D).
- CIA1 keyboard / joystick input (Spec 063 Phase C).
- Bit-exact GCR sync detection — Sprint 62 ships a byte-aligned
  approximation (≥3 consecutive 0xFF bytes); bit-exact deferred to
  follow-up if drive-code regression surfaces.
- Drive bit-bang fastloaders that depend on VIA2 PB7 SYNC line
  bit-precise timing may run but with reduced fidelity.

## MCP tools (Sprint 63)

- `headless_drive_session_start(disk_path, start_track?, device_id?, pal?, write_protected?)` —
  open a 1541 drive emulation session backed by a G64. Returns a
  `session_id` for the other tools.
- `headless_drive_status(session_id)` — CPU registers, head position,
  VIA IFR/IER/IRQ, track-buffer modification flag.
- `headless_iec_bus_state(session_id)` — pin-level state of the IEC
  bus (line wired-AND result + each driver's contribution).
- `headless_drive_persist_writes(session_id, output_path?)` — write
  modified GCR tracks to `<image>_session.g64` (or override path).

Drive sessions stand independently of the existing `headless_session_*`
C64 trace pipeline; integration into the unified session-manager is a
follow-up sprint.

## License posture

- **Drive ROM** — Commodore IP. Bundled per Spec 062 Q1.α (same
  precedent as VICE / Gideon 1541ultimate). Repo gitignores `*.bin`;
  user runs `scripts/install-1541-rom.sh` once. Alternative: build
  from mist64/dos1541 (cc65 source, byte-identical output).
- **Emulator code** — clean-room implementation informed by VICE +
  Gideon source for algorithmic understanding (T1/T2 underflow timing,
  CA1 edge detection, IEC handshake state machine). No code lifted.
  Project remains MIT.

## Acceptance + smoke tests

- `scripts/sprint60-smoke.mjs` — drive CPU + RAM/ROM + VIA register skeleton
- `scripts/sprint61-smoke.mjs` — IEC bus + full 6522 (timers, IRQ, CA1)
- `scripts/sprint62-smoke.mjs` — GCR drive-side I/O + write back + persist
- `scripts/sprint63-smoke.mjs` — drive session manager + sample harness

Sample-title acceptance (skips if `samples/` is empty):
- Maniac Mansion (Lucasfilm SCUMM loader)
- Impossible Mission II (Epyx Vorpal/FastLoad)
- Last Ninja Remix (System 3 multi-side)

Murder full-boot acceptance is the primary R28 criterion; landing
that requires the existing C64 KERNAL ROM integration in
session-manager (deferred to a follow-up sprint).
