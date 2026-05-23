# Spec 705 - Interactive Runtime Evidence, Intervention and Replay Contract

Status: REFINEMENT (2026-05-23 CEST) — slices **705.A DONE** (§4.9) + **705.B DONE** (§4.10)
Created: 2026-05-23 CEST
Depends: Specs 600/601, 616-618, 623, 701-704
Owner: runtime / debugger / v3 UI / project-knowledge

## 1. Purpose

Define the shared architecture for interactive reverse-engineering work on the
live C64RE runtime:

```text
run -> observe -> pause/rewind -> inspect -> intervene -> replay -> compare
```

Monitor, paused-screen inspection, native snapshots, declarative tracing,
code/data overlays, media changes, and rewind must not become unrelated feature
paths. They operate on the same runtime-state and evidence model.

This is a requirements and architecture spec. It does not itself implement a
new UI, snapshot engine, trace store, CRT mounting, patch engine, or rewind UI.

## 2. Current Foundation

The starting point for this spec is `master` at `651bced`:

- VICE1541 is the active drive path; legacy drive source retirement is merged
  under Spec 704.
- KERNAL LOAD/SAVE and `$DD00` loader foundations are covered by Specs
  616-618.
- Spec 701 owns the autonomous backend runtime loop, run/pause state, and live
  frame transport.
- Spec 623 provides the monitor/debugger surface and already reserves native
  `dump`/`undump` plus DuckDB trace-control commands.
- Spec 702 defines paused VIC inspect as a structured evidence surface.
- Spec 703 provides live reSID audio.

## 3. Binding Decisions

### 3.1 Experiment Is the Primary Product Object

An `Experiment` is the stable conceptual unit for interactive work:

```ts
interface RuntimeExperiment {
  id: string;
  startCheckpointId: string;
  mediaState: RuntimeMediaState;
  inputEvents: RuntimeInputEvent[];
  interventions: RuntimeIntervention[];
  traceDefinitionIds: string[];
  evidenceRefs: RuntimeEvidenceRef[];
  resultCheckpointIds: string[];
}
```

The live session is the running presentation of an experiment. Monitor,
inspect, patching, replay, and rewind operate on this same object model.

A normal unexamined live run does not need to be written permanently to the
project. An experiment becomes persistent when the user or an agent pins,
exports, branches, annotates, or otherwise retains evidence from it.

### 3.2 Snapshot-First Architecture

The foundational runtime object is a complete restorable `RuntimeCheckpoint`.
It must contain all state needed to resume deterministic execution of the
active machine path:

- C64 CPU and memory/banking state;
- VIC-II state and the visible frozen frame identity;
- CIA1/CIA2 and IEC state;
- SID/reSID state required for correct continued runtime behavior;
- VICE1541 CPU/VIA/rotation/media/head state;
- mounted disk, cartridge, and injected-program identity where present;
- input state;
- runtime controller state needed for a safe pause/resume boundary;
- references to trace/intervention history, where present.

VICE snapshot formats may be supported as import/export boundaries. They are
not the canonical internal representation for C64RE checkpoints.

### 3.3 Always-On Bounded Checkpoint Ring

Every running live session maintains an automatic, bounded, in-memory
checkpoint ring.

Purpose:

- the user may discover an interesting visible result only after its cause;
- pause/inspect can rewind into the recent past without prior preparation;
- later patch/replay work can branch from a retained prior state;
- ordinary play does not continuously persist project artifacts.

Conceptual surface:

```ts
interface RuntimeCheckpointRing {
  capacityPolicy: "time" | "count" | "bytes";
  checkpoints: RuntimeCheckpointRef[];
  pin(checkpointId: string): PersistedCheckpointRef;
  restore(checkpointId: string): void;
}
```

The retention policy, capture interval, compression strategy, and memory budget
remain open for refinement and measurement.

### 3.4 Pin / Promote Creates Persistent Work

The automatic ring is transient. Durable project state is created through
explicit operations such as:

- pin a checkpoint;
- `dump` a native runtime snapshot;
- create an inspect/knowledge artifact;
- start or retain an evidence trace;
- apply a code/data/media intervention branch;
- promote a branch to a named experiment.

### 3.5 Deterministic Forward Replay Requires Events Between Checkpoints

Restoring a checkpoint is insufficient for replay unless all external changes
after that checkpoint can be reapplied in order. The experiment model must
represent:

- keyboard and joystick input;
- disk mount/swap/eject;
- CRT insert/eject and any required reset/power-cycle;
- PRG injection/load operations;
- RAM/register/code-overlay interventions;
- explicit trace markers and trace-definition activation state where relevant.

## 4. Mandatory Spike Before Feature Implementation

Before building Inspect, Code Overlay, or Rewind on this architecture, run a
short snapshot/restore proof-of-concept against the active runtime.

### 4.1 Purpose

Prove that a native checkpoint can restore both immediate visible/internal
state and deterministic continuation. A checkpoint that restores a screenshot
but cannot continue identically is not usable for rewind.

### 4.2 Spike A - BASIC / READY

Procedure:

1. Start a clean PAL session and reach BASIC `READY.`.
2. Capture a native runtime checkpoint.
3. Advance the machine and/or reset so state visibly changes.
4. Restore the checkpoint.
5. Assert immediate restored state identity.
6. Run a fixed `N` cycles from the restored checkpoint.
7. Compare with a control continuation from the original checkpoint.

Minimum immediate identity:

- C64 CPU registers, PC, cycle;
- RAM and banking;
- VIC state and frame pixels;
- CIA state;
- SID software-visible state and required reSID continuation state;
- runtime controller paused/running boundary.

### 4.3 Spike B - Real Media + Active VICE1541 + reSID

Procedure:

1. Mount real disk media and execute to a stable loaded/title state using the
   active VICE1541 path.
2. Confirm reSID is active in the same session.
3. Capture a native runtime checkpoint.
4. Advance and/or reset so C64, drive, media-visible state, and audio timeline
   no longer match.
5. Restore the checkpoint.
6. Assert immediate restored identity.
7. Run a fixed `N` cycles and compare with a control continuation.

Minimum additional identity:

- VICE1541 CPU/VIA/rotation/head/media state needed for continuation;
- mounted media identity and write state;
- IEC line state;
- reSID continuation determinism at least at the runtime/PCM output boundary.

### 4.4 Spike Gate

The spike is accepted only if both cases prove:

```text
checkpoint -> disturb/reset -> restore == original checkpoint
checkpoint -> run N == restore(checkpoint) -> run N
```

No Rewind or Code Overlay implementation starts before this gate is green.

### 4.5 Preflight Baseline - RED (2026-05-23 CEST)

The executable preflight is:

```bash
npm run probe:705-checkpoint
```

It mounts `samples/POLARBEAR.d64` on the active `drive1541="vice"` path and
checks whether a native checkpoint spike can even be attempted without
inventing missing state.

Current blockers found before any rewind implementation:

- `HeadlessMachineKernel.snapshot()` returns `payload: null`.
- `Vice1541Facade.snapshot()` returns an empty `Uint8Array`; the VICE1541
  snapshot host hooks are not wired to a persistent module stream.
- `saveSessionVsf()` therefore emits an empty `DRIVECPU` module; VSF is not a
  valid active-drive checkpoint today.
- Live reSID rendering is owned by `SidAudioRecorder`, a sidecar outside the
  current session checkpoint surface; PCM continuation state cannot currently
  be restored as part of the runtime.

Existing older snapshot smokes are not authority for this spike:

- `scripts/smoke-snapshot.mjs` is RED on the current active runtime.
- `scripts/smoke-session-vsf.mjs` still reads retired legacy drive fields.
- `scripts/smoke-405-snapshot-roundtrip.mjs` can prove framebuffer replay for
  its partial module subset, but it fails the active VICE drive module
  inventory and does not establish deterministic disk continuation.

The next implementation slice is therefore checkpoint ownership and restore
plumbing for the active runtime state, beginning with VICE1541 and kernel
payload coverage. The automatic ring remains blocked until the spike gate is
green.

Implementation order for `705.A`:

1. Wire an in-memory snapshot-module stream into
   `drive1541/vice1541-facade.ts`, so its existing calls can execute the
   already ported `drive_snapshot_write_module()` and
   `drive_snapshot_read_module()` paths.
2. Complete the currently throwing `viacore_snapshot_write_module()` and
   `viacore_snapshot_read_module()` implementations used by VIA1/VIA2 drive
   state; do not serialize a reduced substitute around them.
3. Feed the resulting opaque active-drive blob into a native
   `RuntimeCheckpoint` payload and make immediate restore measurable.
4. Add C64-side state ownership omitted from the old partial VSF path,
   including literal-frame/VIC continuation and the live reSID sidecar.
5. Turn the preflight green, then implement the BASIC/READY and real-media
   continuation comparisons from sections 4.2 and 4.3.

### 4.6 Drive Subsystem Progress + DRIVE8 Classification (2026-05-23 CEST)

Steps 1+2 done. The active VICE1541 drive checkpoint now carries real
DRIVECPU0 + 1541VIA1D0 + VIA2D0 modules:

- step 2.3 (commit `90540f7`): `viacore_snapshot_write/read_module` ported
  verbatim (viacore.c:1946-2192) + new `iecieee.ts` VIA2 dispatch +
  `machine_drive_snapshot_write/read` ordered iec(VIA1)→iecieee(VIA2) per
  c64drive.c:155. `probe:705-drive-roundtrip` proves: DRIVECPU restores
  byte-identical; each VIA differs only at the CABSTATE byte (VICE's own
  write/read bit-layout asymmetry, viacore.c:1983/2159 — ported verbatim);
  restore is a stable fixed point (b1==b2).

- step 2.4 — DRIVE8 normalization RFL, classified **CASE A (VICE-canonical,
  not a TS port bug)**. The 16 DRIVE8 body bytes that change on the first
  restore are all rotation/GCR/head fields (GCR_head_offset, GCR_read,
  speed_zone, snap_accum, snap_rotation_last_clk, snap_bit_counter,
  snap_last_read/write_data, snap_ue7_dcba, byte_ready_active). Root cause:
  an idle 1541 (BASIC READY job loop) never runs the GCR-read BVC poll, so
  VICE advances rotation only in `LOCAL_SET_OVERFLOW(0)` (6510core.c:158) and
  3 byte-ready opcodes (2527/2815/2934). Idle ⇒ rotation **defers** —
  `rotation_last_clk` lags the drive clock (measured: 6 vs 60904, motor on,
  accum 0). On restore, `viacore_snapshot_read_module`'s `undump_pcr` tail
  (viacore.c:2179, verbatim) → via2d `update_pcr` → `rotation_rotate_disk`
  catches up the `(drive_clk − rotation_last_clk)` delta and re-derives those
  fields. VICE performs the identical catch-up. Verified faithful and NOT the
  cause: `drive_set_half_track` (only GCR_track_start_ptr / scaled
  GCR_head_offset / track size), `rotation_table_get`/`set` (1:1).

  Consequence (per the case-A rule): the drive checkpoint gate is **live-state
  identity + stable fixed point + confined-diff**, NOT A==B serialized bytes.
  `probe:705-drive-roundtrip` asserts every DRIVE8 b0→b1 diff lies inside the
  rotation-resync field set (any foreign byte fails), and that
  `rotation_last_clk` catches up to ≈ the drive clock. No TS "fix" and no
  symptom-normalization. The full `restore→run N == original→run N`
  continuation equivalence needs the C64-side checkpoint to drive the drive
  deterministically and is deferred to the kernel-payload step.

### 4.7 Native RuntimeCheckpoint Core+VIC+Drive Restore (Step 3, 2026-05-23 CEST)

Step 3 DONE (no audio). `HeadlessMachineKernel.snapshot()/restore()` now produce
a native C64RE `RuntimeCheckpoint` (`kernel/runtime-checkpoint.ts`) that
deterministically restores the active machine path:

- C64 CPU at an instruction boundary (Cpu65xxVice mid-instruction `inst` is
  private but null at a boundary — documented contract); RAM + CPU-port latches
  ($00/$01, `setCpuPort` re-runs PLA banking); CIA1/CIA2 (their own
  snapshot/restore); SID software-visible registers (`sid.snapshot`, NO PCM);
  IEC (full `IecBus.core` shadow); `cpuIntStatus`; keyboard live keys / joystick
  / paddles; mounted-media identity.
- Active **literal VIC** (the production `literal-port` path, NOT `VicIIVice`):
  RFL port of `viciisc/vicii-snapshot.c` in `vic/literal/vicii-snapshot.ts` over
  `LIT_TYPES.vicii` + the existing `vicii_get/set_draw_cycle_state`; restore
  re-asserts the VIC IRQ line. The VICE `raster_t` has no TS struct, so the
  visible-continuation seam maps to the IntegratedSession presentation fields
  (`literalPortFb` accumulator + `literalPortFbStable` freeze image +
  `litLastRasterLine` + `lastLitBaLow`), captured in the container.
- VICE1541 drive: the opaque, VICE-shaped snapshot-module byte blob
  (steps 2.3/2.4), stored verbatim.
- **Alarm schedule (maincpu context):** captured + re-armed
  (`alarmContextCaptureSchedule/RestoreSchedule`). This was the continuation
  blocker — CIA `restore()` reloads timer fields but does not re-arm its 5
  alarms, so the maincpu alarm schedule (CIA1/CIA2 timer/TOD/SDR/idle) had to be
  captured and re-armed by name; without it run-N drifted ~3 cycles. The drive's
  VIA alarms live on the drive context and are re-armed by the drive blob.

Gates: `build:mcp` clean; `check:1541-fidelity` 78/0; `probe:705-checkpoint`
kernel payload + literal-VIC + drive GREEN (reSID still RED/PENDING);
`probe:705-core-roundtrip` 13/13 GREEN — BASIC/READY, real-media+VICE1541, and a
mid-frame VIC checkpoint each prove immediate restore identity AND run-N
continuation determinism (CPU + raster + RAM hash + completed-frame hash + drive
+ IEC), strictly sequential from one checkpoint (the literal VIC is a global
singleton — no parallel-session oracle).

PENDING (step 4): reSID PCM continuation-state ownership (the `SidAudioRecorder`
sidecar). The DRIVE8 first-restore rotation re-sync remains VICE-canonical
(§4.6). No ring buffer / dump-undump / UI here.

### 4.8 reSID Synthesis-State Checkpoint (Step 4, 2026-05-23 CEST)

Step 4 DONE. The reSID audio engine now restores its FULL VICE-shaped SYNTHESIS
state, not just SID registers:

- WASM shim (`sid/wasm/resid_shim.cc`): `resid_state_size/read_state/write_state`
  expose reSID's own `SID::State` (= the content VICE serializes via
  `sid-snapshot.c` `sid_snapshot_write/read_resid_module` + `resid.cc`
  `resid_state_read/write`): sid_register[0x20], bus_value/ttl, write_pipeline/
  address, voice_mask, accumulator[3], shift_register[3]/reset/pipeline,
  pulse_output[3], floating_output_ttl[3], rate/exponential/envelope counters +
  periods, envelope_state[3], hold_zero[3], envelope_pipeline[3]. read_state
  zeroes the struct first so inter-field padding is deterministic.
- `ResidWasm.captureResidState/restoreResidState` (no register replay — the
  prior register-replay restore would have clobbered the restored interna) +
  `cycleAccumulator`. `SidAudioRecorder.snapshot/restore` carry that slice and,
  on restore, FLUSH the live PCM ring (`AudioRingBuffer.clear()`).
- Ownership: the recorder registers with the session
  (`registerAudioCheckpoint`); the native RuntimeCheckpoint OPTIONALLY carries
  the audio slice (`RuntimeCheckpoint.audio`) when a recorder is active, and
  works without audio otherwise. The PCM ring / WS / worklet FIFO are NOT in the
  checkpoint (transport — flushed + re-buffered; Spec 706 §9 owns the transport
  re-sync).

Contract (binding): reSID synthesis state = machine state (checkpointed);
buffered pre-restore PCM = transport state (dropped on restore, re-buffered from
the restored synthesis state). Per VICE's own `sound_snapshot_prepare/finish`
separation, raw resampled PCM is NOT byte-identical across restore — the
resampler sub-sample timing phase + FIR warmup are transport-level (not in
`SID::State`). The proven boundary: IMMEDIATE restore → reSID synthesis state
byte-identical; continuation → same output waveform (far-tail ≤ ~30 LSB of
32768) + synthesis state matching within a ≤2-cycle pipeline-counter tolerance
(reSID-inherent sub-state, not a port bug).

Gates: `build:resid-wasm` (rebuilt + committed `resid.mjs`/`resid.wasm`);
`build:mcp` clean; `check:1541-fidelity` 78/0; `probe:705-checkpoint` 8/8 GREEN
(reSID synthesis + machine audio slice now GREEN — no PENDING left);
`probe:705-resid-roundtrip` (NEW) 7/7 GREEN; `probe:705-core-roundtrip` +
`probe:705-drive-roundtrip` still GREEN; reSID/audio smokes pass (9/9 + SMOKE
PASS).

With step 4, the native checkpoint spike (705.A §4.1-4.4) is complete: BASIC,
real-media, mid-frame, and audio continuation all proven. Spec 706 §9/706.8
owns the live-transport restore re-sync (flush WS/worklet + fresh prebuffer).

### 4.9 705.A DONE — Accepted Contract + Closing Gates (2026-05-23 CEST)

The native checkpoint spike (705.A, §4.1-4.4 + steps 1-4) is **DONE and
accepted** under this contract:

- `RuntimeCheckpoint` restores the full machine state, including the
  VICE-shaped reSID `SID::State`.
- Pre-restore PCM in the recorder / WS / AudioWorklet is transport/presentation
  state and is **discarded** on restore.
- Interactive restore/rewind guarantees correct machine + synthesis
  continuation and freshly re-synchronised audio output.
- It does **not** guarantee sample-bit-identical continuation of
  already-buffered PCM output, nor forensic offline audio export from a
  checkpoint. If checkpoint audio export is needed later, that is a separate
  contract (warm-up/re-render or an extended export state).

Closing gates on branch `claude/705-checkpoint-spike` HEAD (`d3fcf8e`):

| Gate | Result |
|---|---|
| `npm run build:mcp` | clean |
| `npm run build:resid-wasm` | committed `resid.mjs`/`resid.wasm` |
| `npm run check:1541-fidelity` | 78 PASS / 0 FAIL |
| `npm run probe:705-checkpoint` | GREEN 8/8 |
| `npm run probe:705-core-roundtrip` | GREEN 13/13 |
| `npm run probe:705-drive-roundtrip` | GREEN 8/8 |
| `npm run probe:705-resid-roundtrip` | GREEN 7/7 |
| `smoke-sid-resid-wasm` / `smoke-sid-resid` | PASS / 9-9 |
| `npm run runtime:proof` (7-game) | GREEN 7/7 (motm/mm/im2/scramble/polarbear/pawn/lnr match Spec 601) |

Steps: 1 in-memory VICE snapshot module stream; 2.1-2.2 TDE + controlled stop;
2.3 viacore VIA + iecieee VIA2; 2.4 DRIVE8 CASE A (VICE-canonical); 3 native
RuntimeCheckpoint core+literal-VIC+drive + maincpu alarm-schedule; 4 reSID
VICE-shaped synthesis state.

Follow-ons (separate, user-gated): Spec 706 §9/706.8 (live audio latency +
transport restore re-sync); 705.B (automatic checkpoint ring); 706+ persistence
/ dump-undump / rewind.

### 4.10 705.B DONE — Always-On Checkpoint Ring + Pin/Restore (2026-05-23 CEST)

The §3.3 automatic bounded checkpoint ring + §3.4 pin primitive are
**DONE**. In-memory / transient only — no persistence, dump/undump,
replay event-log (§3.5), or rewind UI (those are later slices).

Resolved open knobs (§3.3 said "open for refinement and measurement";
resolved by measurement + user decision 2026-05-23):

- **capacity policy = BYTES, budget 128 MiB**, evict OLDEST-first; pinned
  exempt. A real checkpoint ≈ 400 KB (vicPresentation framebuffer ~317 KB
  + 64 KB RAM dominate) → ~320 checkpoints.
- **capture interval = 25 frames (~0.5 s)**, driven by the controller loop
  at the completed-frame boundary (instruction-boundary safe, loop idle).
- **pin** is the only durability primitive in 705.B; promote-to-Experiment
  (§3.1) is deferred (needs the Experiment object model + persistence).

Implementation:

- `src/runtime/headless/kernel/runtime-checkpoint-ring.ts` —
  `RuntimeCheckpointRing` (capture/pin/unpin/get/list/restoreSnapshot/
  clear/stats) + `estimateCheckpointBytes`.
- `runtime-controller.ts` — owns the ring; auto-captures every 25 frames;
  `captureCheckpoint()` / `restoreCheckpoint()` via `runExclusive`. Restore
  drives `kernel.restore()` → the 705.A audio provider → the Spec 706.8
  transport flush.
- `v3-ws-server.ts` — `checkpoint/list|capture|pin|unpin|restore` RPCs.

Gate: `npm run probe:705b-ring` GREEN 7/7 — bytes eviction oldest-first,
pinned survives eviction, unpin reclaims, and a real ring
capture→restore→forward-continuation is byte-identical
(RAM/regs/raster/drive). 705.A + 706 probes + `runtime:proof` 7/7 stay
green (no regression from the in-loop capture).

## 5. Related Existing Specs

| Spec | Relationship to 705 |
|---|---|
| 623 | Monitor command surface consuming checkpoints, interventions, trace controls, and native dump/undump. |
| 702 | Paused VIC evidence UI consuming a stable checkpoint and creating evidence references. |
| 703 | SID/reSID runtime state that checkpoints and later inspect must account for. |
| 704 | Active-path cleanup and spec hygiene prerequisite. |
| Archived 231/243/251/268 | Historical replay, rewind, VSF, and snapshot-tree ideas; not implementation authority for the active runtime. |

## 6. Planned Follow-On Slices

Tentative only until refinement closes:

| Slice | Subject |
|---|---|
| 705.A | Native checkpoint schema and restore spike implementation. **DONE (§4.9).** |
| 705.B | Automatic checkpoint ring and pin/restore lifecycle. **DONE (§4.10)** — promote-to-Experiment deferred. |
| 706 | Native snapshot persistence plus monitor `dump`/`undump`. |
| 707 | Declarative trace definitions and TraceDB control. |
| 708 | Reproducible media ingress: disk, PRG, CRT, drag/drop. |
| 709 | Frozen VIC inspect integration on checkpoint/evidence model. |
| 710 | Code/data overlay and controlled intervention branches. |
| 711 | Rewind, replay, branch comparison, and any eventual UI surface. |

## 7. Open Refinement Questions

Resolve one at a time with the user:

1. Which state changes must force an immediate checkpoint outside the normal
   automatic capture cadence?
2. What is the first ring retention target: seconds of emulated time, count of
   checkpoints, or maximum host-memory budget?
3. What is the safe intervention boundary: instruction boundary only for the
   first implementation, with cycle-exact edits deferred?
4. Should media operations create new experiment roots or branch events?
5. Which trace-definition language is canonical: structured JSON schema,
   textual DSL, or both with one compiling into the other?
6. Which real-media title/state is the canonical Spike B acceptance fixture?
