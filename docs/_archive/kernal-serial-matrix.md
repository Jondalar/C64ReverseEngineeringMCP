# KERNAL Serial Byte Matrix (Spec 111 / M3.3)

## v1 scope

Tests the CBM IEC bit-bang protocol contract at **protocol-state level**:
no real KERNAL ROM execution, no real drive CPU. A
`SyntheticIecDevice` observes IEC line transitions and responds per
CBM convention; a host-side bit-bang harness emits LISTEN / TALK /
SECOND / CIOUT / UNLSN / UNTLK frames byte-by-byte. Both sides are
asserted at the end of each fixture.

This satisfies the spec's M3.3a (synthetic device responder) +
M3.3b (matrix runner) + M3.3d (documentation). M3.3c (YAML scenario
format) is deferred to follow-up — Spec 107 (M2.5) defines the YAML
format and is unblocked once that lands; until then matrix entries
remain inline TS.

## Frame conventions

CBM IEC convention enforced by `ProtocolHarness`:

- **ATN** asserted (line LOW) ↔ command frame (LISTEN/TALK/SECOND/etc).
- Each byte is sent **LSB-first**, 8 bits.
- Per bit: host releases CLK, sets DATA per bit (1 = pulled), then
  pulls CLK to clock the bit. Listener samples DATA on CLK falling edge.
- After the 8th bit, host releases DATA so listener can pull DATA for
  the **frame ack**.
- ATN release ends the command frame.

## Command bytes recognised by `SyntheticIecDevice`

| byte         | meaning                            | side effect |
|--------------|------------------------------------|-------------|
| `$20 + dev`  | LISTEN device                      | role=listener if dev==self |
| `$3F`        | UNLISTEN                           | role=idle, drop secondary |
| `$40 + dev`  | TALK device                        | role=talker if dev==self |
| `$5F`        | UNTALK                             | role=idle |
| `$60 + sa`   | SECOND (open channel)              | record selectedSecondary |
| `$E0 + sa`   | TKSA (talker secondary)            | record selectedSecondary |

## Fixtures (8 / 22 checks)

| ID | Scenario                                  | Asserts |
|----|-------------------------------------------|---------|
| F1 | LISTEN dev 8 (matches synth)              | role→listener, selectedDevice=8, framesAcked=1, post-ATN ack |
| F2 | LISTEN dev 9 (mismatch)                   | role idle, DATA released, selectedDevice undef |
| F3 | TALK dev 8                                | role→talker, framesAcked=1 |
| F4 | LISTEN + SECOND $61 + CIOUT \$55 \$AA + UNLSN | bytesReceived = [\$55, \$AA], role idle after UNLSN, framesAcked=3 |
| F5 | device-not-present (synth disabled)        | DATA never pulled, role idle, bus DATA released at frame end |
| F6 | UNTALK releases talker                     | role→idle after \$5F |
| F7 | UNLSN-vs-talker v1 deviation              | UNLSN releases talker too (v1 simplification — pinned) |
| F8 | LSB-first byte order check                | LISTEN \$28 parsed correctly proves bit-order convention |

`npm run smoke:serial-matrix` — 22/22 pass.

## v1 deviations (pinned)

1. **UNLSN releases talker (F7)** — real CBM bus has UNLSN affecting
   only listeners; talkers continue until UNTLK. v1 synth releases
   on either UNLSN or UNTLK. This is documented as a known
   simplification; future v2 should split the two.
2. **Either-edge ATN response** — synth pulls DATA on ATN falling
   edge regardless of address. This is correct (all devices ack ATN
   per spec), then non-addressed devices release after the command
   frame parses.
3. **No EOI bit-level signaling** — `signalEoiOnLast` flag exists in
   `SyntheticIecDeviceOptions` but the talker-byte-out path is not
   exercised in v1 fixtures (host-side talker harness deferred).

## v2 follow-ups

- KERNAL-mode matrix: rebuild `IntegratedSession` plumbing to swap
  the real `DriveCpu` for a `SyntheticIecDevice` so the real KERNAL
  ROM exercises LISTEN / TALK / ACPTR / CIOUT against the synth.
  Will broaden to ~30 fixtures across timeout, retry, EOI handshake,
  multi-byte transfer.
- Talker-mode bit-bang: harness for ACPTR-style byte-receive (host
  reads from synth talker). Requires bit-level timing model for the
  EOI gap (>256us pause before final bit).
- YAML scenario format integration once Spec 107 (M2.5) lands.
- Fix the UNLSN-vs-talker deviation (F7).

## Files

- `src/runtime/headless/test-helpers/synthetic-iec-device.ts`
- `src/runtime/headless/c64/serial-matrix-tests.ts`
- `scripts/smoke-serial-matrix.mjs`
- `package.json` script: `smoke:serial-matrix`
