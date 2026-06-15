# Spec 765 — Zero-Alloc Checkpoint Ring + re-thought Scrub

Status: IMPLEMENTED (2026-06-15) — the "Mittelweg" (§6 OQ1) on branch
`bug-049-audio-perf` (commits 8c52acd flat ring + 055dec4 scrub re-intro).
Supersedes the storage model of Spec 705.B (not its capability). Anchor:
`docs/runtime-live-arc42.md` §5/§6.1.

**Decision (§6 OQ1, user-ratified):** the *Mittelweg* — a flat `ArrayBuffer`
slab holds only the DOMINANT big buffers (RAM 64 KiB + the two literal-port
framebuffers ~317 KiB), copied per-slot via `.set()`, the entry holding slab
subarray VIEWS. The small scalar chip state stays a per-slot JS object so
`kernel.restore()` is UNCHANGED → no byte-codec rewrite → zero new fidelity-gate
risk (no Spec 620 C→TS surface). Full-flat (pack subsystem state too) is the
escalation if the Mittelweg ever proves insufficient — it buys ~nothing GC-wise
(the small state never churned) and is where the gate risk would live.

**Gates passed:** probe-705b 7/7, probe-707 10/10, probe-single-path 25/25,
e2e-761 11/11. Remaining acceptance bar (§5 perf): user ear — daemon holds ~50
fps with auto-capture ON + audio underrun-free for 60 s on the live UI.

## 1. Why

BUG-049 (audio "kratzen") root cause, measured 2026-06-15:

- The **emulation is realtime-capable** (~14–15 ms/frame). The audio path is
  fine (recorded daemon stream = flawless). The stutter was the daemon running
  **slightly under 50 fps** → audio under-delivered (one PCM chunk per emulated
  frame) → browser worklet ring underran.
- Three contributors, in order found:
  1. **busTrace always-on** (Spec 753): `cpu.emit()` allocated a `BusEvent` +
     dispatched PER memory access (~1M/s) because the daemon enabled the C64
     bus-trace unconditionally at session start. **FIXED** — busTrace is now
     gated on a live `bus_access` trace (trace-run start/stop), zero-cost idle.
  2. **present-path per-frame allocation** (~206 KiB/frame): `renderLiteralPortIndexed`
     indices + the pushFrame payload + the broadcastFrame wire buffer. **FIXED**
     — pooled (reused across frames).
  3. **checkpoint-ring auto-capture** (Spec 705.B): every ~0.5 s, `kernel.snapshot()`
     `.slice()`s ~400 KB (64 KB RAM + 2× ~158 KB VIC framebuffers) into a **graph
     of nested objects** retained in the ring (128 MiB). **The snapshot COMPUTE
     is cheap (~0.15 ms)** — the cost is GC: retaining/growing a large old-gen
     object graph at 400 KB/0.5 s → periodic **major-GC pauses** → fps dips →
     residual kratzen.

Interim (shipped on this branch): cadence 0.5→1 s, ring budget 128→32 MiB —
reduced but did not eliminate (3). So (3)'s auto-capture is **PARKED**
(`CHECKPOINT_AUTOCAPTURE` default off) and the **scrub UI was removed from the
Live tab**, pending this spec.

## 2. Goal

Re-introduce always-on rewind (scrub) with a checkpoint ring that is
**zero-alloc on the hot capture path** and **cheap for the GC to retain**, so it
costs ~0 fps. Keep capture/restore byte-exact (Spec 705 fidelity).

## 3. Design

### 3.1 Storage — flat pre-allocated ring (the core change)

- Pre-allocate ONE big `ArrayBuffer` (configurable, e.g. 32–64 MiB) ONCE at
  session start. Slots are fixed-size regions at offsets; capture writes the
  next slot **round-robin** (slot 0..N-1, then 0 again — overwrite oldest).
- **Capture = serialize the snapshot into the slot as a flat binary blob**
  (raw `set()` of the big buffers + packed scalar fields). No per-capture JS
  object/typed-array allocation → **zero GC churn**.
- **A single flat `ArrayBuffer` is ONE GC object** — V8 does not scan its bytes
  for references. So the retained ring (tens of MiB) costs the major GC ~nothing,
  unlike the current ~hundreds of nested snapshot objects.
- This mirrors **Spec 726.B** (binary trace log = authority, zero-alloc sink) —
  apply the same pattern to checkpoints.

### 3.2 Restore / read — parse-on-freeze

- Restore + scrub + monitor-inspect already pause the loop (`runExclusive`). So
  parsing a slot back into machine state is **runtime-uncritical** (emulation is
  frozen — no realtime budget). Capture is dumb-fast; all the "smart" work
  (parse, extract, decode) happens only when the user scrubs/inspects.

### 3.3 Codec

- A **fast flat codec** (NOT the Spec 707 gz/JSON `.c64re` codec — that is for
  disk persistence and is far too slow for the hot path). Layout: a fixed header
  (scalars: cpu regs, cycle, frame, flags…) + length-prefixed sections for the
  variable parts (drive blob, cart/flash, media) + the fixed big buffers (RAM,
  framebuffers) at known offsets.
- Reuse the existing per-subsystem snapshot/restore (`cia.snapshot()`,
  `drive1541.snapshot()` opaque blob, `vicii_snapshot_*`) as the section
  contents — just pack them into the flat slot instead of a JS object.

### 3.4 Slot sizing + variable parts

- Fixed parts (RAM 64 KB + 2 framebuffers ~317 KB) are constant → fixed offsets.
- Variable parts (drive blob, cart/flash, media) → length-prefixed; slot size =
  max expected. The Spec 714.4 content-addressed disk/cart dedup pool stays
  (large media stored once, slot holds a hash ref).
- N = budget / slot-size. Pinned slots are exempt from round-robin overwrite
  (skip to the next free slot; the pin model from 705.B carries over).

### 3.5 Scrub UI re-intro

- Re-add the Live-tab scrub seekbar AFTER the ring lands. The 1 s
  `checkpoint/list` poll is replaced by a push (`debug/ring_extended` or a
  bounded poll) so the UI doesn't drive per-second RPC. Granularity + depth from
  §3.1 (e.g. 1 s × N).

## 4. Non-Goals

- Not changing the Spec 707 `.c64re` disk-persistence format (separate, slow,
  fine as-is).
- Not changing audio/transport (Spec 703/706 stand — confirmed fine).
- Not re-enabling the per-frame auto-capture until the flat ring is in (the
  parked `CHECKPOINT_AUTOCAPTURE` flag is the bridge).

## 5. Gates (fidelity-critical — Spec 705)

- `probe-705b-ring` 7/7 — capture→restore reproduces the byte-exact machine
  signature + forward-continuation matches control.
- `probe-707` (dump/undump) green — the native `.c64re` path still round-trips.
- `probe-single-path` green.
- The **7-game screenshot gate** — restore must not perturb the renderer/drive.
- **Perf gate**: with auto-capture ON at the target cadence, the daemon holds
  ~50 fps (measure via `scripts/ws-av-tap.mjs` frame rate) and audio is
  underrun-free for 60 s (user ear). This is the acceptance bar BUG-049 set.

## 6. Open questions

- ~~Flat `ArrayBuffer` slots vs a pre-warmed pool of reusable typed-array sets.~~
  **RESOLVED — the Mittelweg (see Status):** flat slab for the big buffers, small
  scalar state stays a per-slot JS object. Restore unchanged, lowest gate risk.
  Full-flat is the escalation only if needed.
- Cadence + depth defaults: shipped at **1 s cadence**, **32 MiB slab ≈ 86
  slots ≈ 86 s** rewind. Revisit if deeper history is wanted.
- Whether both `literalPortFb` (mid-frame accumulator) and `literalPortFbStable`
  are needed every slot, or one can be reconstructed on restore (halves the
  framebuffer cost).

## 7. References

- `bugs/BUG-049-*.md` — the full diagnosis (busTrace / present / checkpoint).
- `docs/runtime-live-arc42.md` — daemon↔client live architecture.
- Spec 705.B — the ring capability this re-storages.
- Spec 726.B — the zero-alloc binary-log pattern to mirror.
- Spec 707 — the (slow, disk) `.c64re` codec — explicitly NOT reused on the hot path.
