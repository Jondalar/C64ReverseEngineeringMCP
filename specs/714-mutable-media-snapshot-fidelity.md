# Spec 714 - Mutable Media Snapshot Fidelity: Disk, Cartridge and Rewind State

**Status:** IN PROGRESS (2026-05-23 CEST) — 714.1 (RFL) + 714.2 (same-session mutable disk checkpoint) DONE, see §11. 714.3 (.c64re), 714.4 (bounded ring), 714.5 (writable cartridge after Spec 713), 714.6 (downstream) pending.  
**Depends on:** Specs 705.A/B, 706, 707 implementation surfaces; VICE1541 fidelity doctrine in Specs 612/620  
**Coordinates with:** Spec 709 for media ingress/events; Spec 713 for VICE-faithful writable cartridge hardware  
**Blocks:** Durable Spec 710 evidence promotion, Spec 711 intervention branches, Spec 712 rewind/replay; truthful writable-media `.c64re` persistence  
**Authority:** VICE snapshot behavior and its mutable-media modules are the behavioral ground truth.

## 1. Correction To The Plan

The active runtime now has native machine checkpoints, a checkpoint ring and
`.c64re` dump/undump. However, writable media was incorrectly treated as a
deferred edge case:

- Spec 705 required mounted media identity **and write state** for deterministic
  continuation and rewind.
- Spec 707 implemented a native container around `RuntimeCheckpoint`, but the
  active VICE1541 snapshot was invoked with `save_disks=0`; it therefore embeds
  original clean source media while rejecting dirty disk persistence.
- Spec 709 then needed rejection policy for writable cartridge state and, during
  review, exposed the same invalidity for dirty disk checkpoints and branches.

This is not an acceptable final architecture. A snapshot/checkpoint system that
cannot retain the result of `SAVE`, disk writes, flash programming or EEPROM/SPI
state cannot be the foundation for inspection, code-overlay branching or rewind.

**Binding correction:** VICE-shaped mutable-media state is part of the runtime
checkpoint. Dirty-media rejection is permitted only as a temporary corruption
barrier while this spec is being implemented. It is not a completed feature and
must be removed once the relevant mutable-media path is faithful.

## 2. Required Final Contract

At any instruction-boundary checkpoint:

```text
machine state + mounted-media identity + mutable-media bytes/state
    -> restore
    -> exactly the same executable continuation
```

This contract applies equally to:

- an automatic in-memory checkpoint in the 705.B ring;
- a pinned checkpoint;
- `.c64re` `dump` / `undump`, including restore into a fresh session;
- future rewind/replay and branch comparisons.

Specifically:

1. After a program writes sectors to D64/G64/P64 media, a checkpoint taken after
   that write restores the written media bytes and drive continuation.
2. After a writable cartridge changes flash, EEPROM, SPI flash or mapped RAM,
   a checkpoint taken after that change restores the changed device state.
3. A media operation event may form a branch root only when its before/after
   checkpoints include the complete mutable-media state at those points.
4. The native `.c64re` container is canonical for C64RE persistence; VICE VSF
   remains an optional future interchange format. The internal machine/media
   semantics must nevertheless match VICE.

## 3. VICE Reference Behavior

### 3.1 Disk Images In VICE Snapshots

VICE already models this correctly:

- `vice/src/c64/c64-snapshot.c` passes `save_disks` into
  `drive_snapshot_write_module(s, save_disks, save_roms)`.
- `vice/src/drive/drive-snapshot.c` always snapshots drive runtime state and,
  when `save_disks != 0`, additionally writes the attached disk image through
  its GCR/P64/common-image snapshot modules.
- VICE snapshot UI exposes saving disk images; the SDL setting defaults
  `save_disks` to enabled.

The current C64RE path deliberately diverges:

- `src/runtime/headless/drive1541/vice1541-facade.ts` calls
  `drive_snapshot_write_module(s, 0, 0)`.

That `0` is the immediate reason a checkpoint cannot restore post-attach disk
writes. It must not remain the final behavior.

### 3.2 Writable Cartridge State In VICE

Writable cartridge state belongs to each cartridge's snapshot module, not to
an ad hoc media guard. Spec 713 owns the faithful active cartridge ports and
their VICE state surfaces:

- EasyFlash flash and IO RAM;
- GMOD2 flash and EEPROM;
- GMOD3 SPI flash;
- MegaByter flash;
- any writable mapped state present in supported VICE cartridge modules.

Spec 714 owns making that state part of checkpoint, `.c64re` persistence and
ring/rewind semantics once each mapper is VICE-faithful.

## 4. Current Red State

### 4.1 Disk Snapshot Payload Is Incomplete

Current checkpoints retain drive CPU/VIA/head/rotation state but not modified
disk-image bytes. A direct reproduction proves the invalid checkpoint:

1. mount writable `motm.g64`;
2. alter a live GCR track byte, making the medium dirty;
3. capture a runtime checkpoint;
4. alter the byte again;
5. restore the checkpoint;
6. the byte remains at the second value instead of returning to its checkpoint
   value.

Therefore an accepted dirty-disk checkpoint is not deterministic continuation.

### 4.2 Media Branching Can Retain Invalid Roots

Current ingress guards reject dirty disk replacement/eject, but a dirty disk can
still be present while another operation, such as CRT insert or PRG ingress,
captures before/after branch checkpoints. Those checkpoint IDs represent
non-restorable media state.

### 4.3 Writable CRT Rejection Is Temporary Only

The recently added writable-CRT reject prevents silent restore corruption while
flash deltas are absent. It is a valid temporary barrier, but it is not a valid
resolution for EasyFlash/GMOD/MegaByter runtime support.

## 5. Ownership Boundaries

| Concern | Owner | Requirement |
| --- | --- | --- |
| Drive CPU/VIA/head/rotation snapshot | Existing 705/VICE1541 port | Preserve VICE module-stream behavior. |
| Mutable disk image snapshot | Spec 714 | Port/activate VICE `save_disks` image modules and restore semantics. |
| `.c64re` container and integrity | Spec 707 surface, extended by 714 | Store one authoritative mutable-media continuation; no clean-source-only restore after writes. |
| Media attach/eject/swap/event API | Spec 709 | Consume complete checkpoint semantics; remove temporary dirty rejection when 714 state is available. |
| Cartridge mapper behavior and writable devices | Spec 713 | Port VICE hardware behavior and device snapshot modules. |
| Cartridge persistence/ring semantics | Spec 714 after 713 mapper slices | Capture and restore writable cartridge contents in all checkpoint forms. |
| Inspect/overlay/rewind UI | Specs 710-712 | Must consume truthful checkpoint state; not compensate for missing media state. |

## 6. Architecture Decisions

### 6.1 One Authoritative Media State

A checkpoint must not restore a drive/cartridge runtime state from one source
and mutable media bytes from a stale second source.

For each medium, the implementation must establish one canonical continuation
payload:

- For VICE1541 disk media, prefer the actual VICE-shaped drive snapshot module
  stream with disk image modules enabled, because it already defines the
  drive/media restore ordering and format semantics.
- `.c64re` may carry media identity, display names and integrity metadata around
  that payload, but must not overwrite restored mutable disk content with the
  original mounted bytes afterward.
- For cartridges, use mapper/device snapshot state produced by the VICE-shaped
  active port from Spec 713, not a parallel “dirty delta” shadow disconnected
  from mapper behavior.

Any duplicated baseline bytes retained for provenance or deduplication must be
clearly non-authoritative at restore once a mutable payload exists.

### 6.2 Correctness Before Compression

The first fidelity gate may use a full mutable-media payload to prove exact
restore. The always-on ring cannot permanently multiply full large images at its
existing cadence without a bounded memory policy.

The production ring must therefore retain identical semantics with storage
sharing:

- immutable/content-addressed baseline bytes stored once per mounted identity;
- mutable checkpoint versions stored as deduplicated pages, extents or a
  deterministic versioned delta;
- pinned checkpoints keep every referenced media version alive;
- eviction reclaims unreferenced payload versions;
- materializing a checkpoint yields exactly the bytes/state that a full VICE
  snapshot at that point would restore.

Storage optimization must never alter emulated state or become a behavioral
shortcut.

### 6.3 Temporary Barrier Removal

While Spec 714 is incomplete, dirty-media guards may prevent invalid snapshots.
As each mutable path becomes complete:

- remove dirty-disk checkpoint/dump/media-event rejection after disk gates pass;
- remove dirty writable-cartridge rejection only for mapper families whose Spec
  713 hardware and Spec 714 persistence gates pass;
- do not retain rejection as a substitute for faithful support.

## 7. Implementation Slices

### 714.0 - Lock The Red Proof And Temporary Safety Boundary

Purpose: prevent more false `DONE` claims while the real fix is built.

- Record the direct dirty-disk checkpoint/restore failure.
- Record dirty-disk plus unrelated media-intervention branch failure.
- If necessary for an interim build, apply one shared temporary
  “mutable media not yet persistable” barrier to explicit and automatic
  checkpoint creation and to branch-forming media operations.
- Mark the barrier as temporary and superseded by 714.2/714.5; it must not be
  used as the completion criterion.

### 714.1 - RFL Inventory Of VICE Mutable Disk Snapshot Path

Read and map before code edits:

- `vice/src/c64/c64-snapshot.c`;
- `vice/src/drive/drive-snapshot.c`;
- the GCR/P64/common-image snapshot module writers/readers it invokes;
- any VICE writeback/catch-up step required before snapshot and after restore;
- corresponding existing TS ports and hooks.

Output internally:

- which VICE disk snapshot functions are already ported;
- which functions/hooks are missing, stubbed or not active;
- restore ordering required for fresh-session `.c64re` restore;
- how the separately embedded clean media payload in Spec 707 must be retired,
  demoted to identity/baseline, or coordinated without becoming a second
  authority.

### 714.2 - VICE1541 Mutable Disk Checkpoint Fidelity

- Activate or complete the VICE-shaped disk-image module path for the active
  1541 runtime, equivalent to `save_disks=1`.
- Support the active disk media formats required by the runtime: D64 and G64;
  include P64 if currently mountable or explicitly reject it until ported.
- Preserve drive CPU/VIA/head/rotation behavior already proven under Spec 705.
- Restore mutable disk state exactly in the same session and in a fresh session.
- Remove the temporary dirty-disk checkpoint rejection once these gates are
  green.

### 714.3 - `.c64re` Mutable Disk Persistence

- Extend native dump/undump so a dumped session after disk writes is portable and
  restores the written disk content.
- Eliminate the current “dirty disk abort” as the normal behavior after the
  mutable disk payload is integrated.
- Keep format versioning and integrity validation explicit. If the container
  representation changes incompatibly, increment/reject version rather than
  guessing.
- Preserve media identity and ingress event history without reattaching stale
  source bytes over restored mutable bytes.

### 714.4 - Ring Payload Store And Bounded Rewind

- Introduce a bounded media-version store for automatic checkpoints, shared by
  ring entries rather than copied naively per entry.
- Capture continues across in-program disk saves.
- Restore can jump between at least three different disk-write versions and
  reproduce each state exactly.
- Pin/unpin/eviction correctly retains/releases media payload versions.
- Restore remains instruction-boundary deterministic and preserves audio
  transport re-sync behavior.

### 714.5 - Writable Cartridge Persistence After Spec 713

For each supported writable cartridge family after its VICE mapper port is
complete:

- capture full mutable device state in RuntimeCheckpoint;
- persist it through `.c64re`;
- retain it in the bounded ring;
- restore it into a fresh session with correct banking/mode state;
- remove the family-specific dirty reject after its gates pass.

EasyFlash is first priority because it is already mounted in the UI and has
demonstrated visible failure. GMOD2, GMOD3 and MegaByter follow their Spec 713
completion.

### 714.6 - Downstream Contract Update

- Update Specs 707 and 709 to replace temporary dirty-reject language with
  implemented mutable-media behavior.
- Update Specs 710-712 so durable evidence, intervention branches and rewind
  require 714-complete mutable media when a writable medium is present.
- Keep inspect work possible for sessions with no writable-media dependence, but
  never label evidence durable/replayable when its medium state is incomplete.

## 8. Mandatory Gates

### 8.1 Dirty Disk Same-Session Checkpoint

For D64 and G64:

1. mount a known image;
2. create a real drive-written or minimally controlled changed sector/track
   state;
3. capture checkpoint A;
4. write a distinguishable second state;
5. restore A;
6. assert exact mutable image bytes, drive continuation state and forward
   continuation match the control from A.

No reject is acceptable after 714.2 is complete.

### 8.2 Dirty Disk `.c64re` Fresh-Session Restore

For D64 and G64:

1. execute a disk write;
2. `dump` `.c64re`;
3. destroy/start a fresh session;
4. `undump`;
5. assert written disk bytes and subsequent read/load behavior match the source
   session.

### 8.3 Ring Across Saves

- Run with automatic checkpoint capture enabled.
- Create three distinct saved disk states across time.
- Restore a checkpoint belonging to each state.
- Assert each version is reconstructed correctly.
- Assert ring memory remains bounded and pin/evict behavior cannot discard
  referenced media payloads.

### 8.4 Cross-Media Branch Validity

- With a disk already modified, insert/eject CRT or load/inject PRG.
- After 714 disk integration, before/after event checkpoints must be accepted and
  must restore the modified disk content correctly.
- Before integration, the temporary safety gate must reject the operation without
  event/checkpoint mutation.

### 8.5 Writable Cartridge State

After each Spec 713 writable mapper slice:

- program/erase/write cartridge storage through its emulated hardware protocol;
- checkpoint and restore same-session;
- `.c64re` dump/undump into a fresh session;
- ring restore across distinct write versions;
- assert mapped reads, mapper mode/register state and continuation match.

### 8.6 Regressions

Required after each integration milestone:

- `npm run build:mcp`
- `npm run check:1541-fidelity`
- existing Spec 705 checkpoint/core/drive/reSID probes
- Spec 706 audio restore-resync probe
- Spec 707 dump/undump probes, expanded for dirty media
- Spec 709 media/WS probes, expanded for branch validity
- runtime proof gates affected by mounted media behavior
- after Spec 713 integration, cartridge mapper differential gates

## 9. Done Definition

Spec 714 is DONE only when:

1. a valid checkpoint may be captured after a disk save and restores that saved
   disk state exactly;
2. `.c64re` persists and restores modified disk media into a fresh session;
3. the automatic checkpoint ring continues across disk writes with bounded,
   exact media-version storage;
4. writable cartridge families supported by the active runtime persist their
   mutable state after their Spec 713 ports land;
5. dirty guards are removed for completed media families and remain only as
   explicit rejection for genuinely unsupported writable media;
6. downstream evidence/overlay/rewind features consume full mutable-media
   checkpoint state rather than assuming clean source media.

Until then, 709 may be considered usable for clean-media ingress and live UI
mounting only. It is not a complete reproducible-media foundation for writable
sessions.

## 10. Source And Runtime References

VICE authorities:

- `vice/src/c64/c64-snapshot.c`
- `vice/src/drive/drive-snapshot.c`
- `vice/src/arch/sdl/menu_snapshot.c`
- VICE disk-image snapshot helpers reached from `drive_snapshot_write_module`
- VICE cartridge snapshot modules referenced by Spec 713

C64RE current surfaces:

- `src/runtime/headless/drive1541/vice1541-facade.ts`
- `src/runtime/headless/vice1541/drive_snapshot.ts`
- `src/runtime/headless/kernel/runtime-checkpoint.ts`
- `src/runtime/headless/kernel/runtime-checkpoint-ring.ts`
- `src/runtime/headless/kernel/native-snapshot.ts`
- `src/runtime/headless/kernel/snapshot-persistence.ts`
- `src/runtime/headless/debug/runtime-controller.ts`
- `src/runtime/headless/media/ingress.ts`
- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/709-reproducible-media-ingress.md`
- `specs/713-vice-cartridge-fidelity.md`

## 11. Result — 714.1 + 714.2 (2026-05-23)

### 714.1 RFL inventory (VICE mutable-disk snapshot path)

Read `vice/src/drive/drive-snapshot.c` against the TS port
`src/runtime/headless/vice1541/drive_snapshot.ts`:

- `drive_snapshot_write_module` save_disks block (VICE 308-336) is a faithful 1:1
  port (TS 555-579); `drive_snapshot_read_module` invokes
  `read_image/read_gcrimage/read_p64image` (VICE 564-566 → TS 902-904).
- The **GCRIMAGE module is already fully ported**: write (TS 1171-1213 = VICE
  870-903) and read (TS 1221-1320 = VICE 905-987), with version checks and
  per-half-track `SMW_DW`/`SMW_BA` / `SMR_DW`/`SMR_BA`. The disk write source is
  the live `drive.gcr` buffer (the write head deposits there), so no separate
  GCR writeback is needed before snapshot.
- P64 image write is a PORT-STUB throw (Spec 612 §10), unreachable on the G64/D64
  GCR path.
- Conclusion: the only divergence was the facade calling
  `drive_snapshot_write_module(s, 0, 0)` — `save_disks=0`. No new port required.

### 714.2 same-session mutable disk checkpoint fidelity

- `vice1541-facade.ts snapshot()` now calls `drive_snapshot_write_module(s, 1, 0)`
  (`save_disks=1`, `save_roms=0`). The GCR image rides in the `drive1541`
  checkpoint blob; `restore()` reads it back via the already-wired
  `read_gcrimage_module`. A checkpoint taken after a disk write restores the
  WRITTEN bytes, not the clean source.
- **709.13 dirty-disk barrier retired:** `RuntimeController.nonPersistableDirtyMedia()`
  no longer reports a dirty disk (it is now persistable). Only the dirty writable
  CRT remains non-persistable (until Spec 713 + 714.5). `captureCheckpoint`,
  the auto-cadence and `ingestMedia` therefore accept a dirty disk and capture
  it. The former `probe-709-12` Part C (dirty-disk reject) is removed; the
  dirty-CRT reject (Part A) stays.
- **Scope boundary:** the `.c64re` `dump` path keeps its own dirty-disk reject
  for now — fresh-session mutable-disk persistence is 714.3 (it must first
  reconcile the `gatherMedia` embedded source bytes vs the blob's mutable
  GCRIMAGE per §6.1). The always-on ring now stores the full GCR image per
  checkpoint; the bounded content-addressed media-version store is 714.4
  ("correctness before compression", §6.2).

**Gate `probe:714` (12/12):** 8.1 same-session for G64 AND D64 — dirty disk
captureCheckpoint accepted; write V1 → capture A → write V2 → restore A → byte
== V1 (the §4.1 repro, now green); drive continuation (drive_pc/head) +
forward-run RAM hash reproduce from the checkpoint. 8.4 — dirty disk + CRT
insert accepted with before/after checkpoints; the before-checkpoint restores
the modified disk content.

**Regressions:** `build:mcp` clean; `probe:714` 12/12; `probe:707-dump-undump`
10/10 (clean-media .c64re unaffected by save_disks=1); `probe:709-12` (Part C
removed, A/D/B green); `probe:709-media` 21/21; `probe:709-ws-routes` 5/5;
`probe:705b-ring` 7/7; `probe:706-restore-resync` green; `probe:708-trace` 8/8;
`check:1541-fidelity` 78/0; `runtime:proof` 7/7.

714.1 + 714.2 DONE. Next: 714.3 (.c64re fresh-session mutable disk).
