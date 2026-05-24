# Spec 707 - Native Snapshot Persistence and Monitor dump/undump

Status: DONE (2026-05-23 CEST) — see §9. All gates green incl. runtime:proof 7/7.
Depends: Specs 623, 701, 705.A, 705.B, 706
Owner: runtime / monitor / workspace persistence

## 1. Purpose

Persist the native `RuntimeCheckpoint` proven by Spec 705.A and expose it
through monitor/API `dump` and `undump`.

This is the durable boundary for later trace evidence, media experiments,
visual inspection, intervention branches and rewind. It is not a VICE VSF
implementation.

## 2. Binding Decisions

### 2.1 Native C64RE Format Is Canonical

The native save-state format is owned by C64RE and stores the active runtime
checkpoint contract:

- C64 CPU, RAM and banking;
- active literal VIC state and frozen-frame continuation state;
- CIA/IEC and runtime alarm schedule;
- VICE1541 opaque, VICE-shaped checkpoint payload;
- reSID synthesis state;
- mounted-media identity and mutable media state needed for continuation;
- runtime-controller boundary and compatible metadata.

VICE VSF may later be an explicitly labelled import/export boundary. It is
never silently substituted for `.c64re` persistence.

### 2.2 Persistence Consumes 705.B, It Does Not Rebuild It

Spec 705.B owns the automatic in-memory ring and pin/promote lifecycle. Spec
707 serializes a pinned or synchronously captured checkpoint and restores it.
It must not create a second checkpoint model.

### 2.3 Dump/Undump Are Deterministic Runtime Operations

`dump` obtains an instruction-boundary checkpoint through the backend runtime
controller. If the session is running, the controller pauses safely, captures,
then resumes only if command policy explicitly requests it.

`undump` pauses the running session, restores the checkpoint, invalidates stale
presentation/audio transport according to Spec 706, and leaves the restored
machine paused for inspection by default.

## 3. File Contract

First implementation may use a binary container or structured manifest plus
binary payloads, but it must define and test:

```ts
interface NativeSnapshotManifest {
  kind: "c64re-runtime-snapshot";
  version: number;
  createdAt: string;
  machine: { model: "c64-pal" | "c64-ntsc"; runtimeVersion: string };
  checkpoint: { encoding: string; payloadRef: string; cycle: number; pc: number };
  media: SnapshotMediaRef[];
  provenance?: { experimentId?: string; checkpointId?: string; note?: string };
}

interface SnapshotMediaRef {
  role: "drive8" | "drive9" | "cartridge" | "injected-prg";
  format: string;
  sha256: string;
  sourceName?: string;
  embeddedPayloadRef?: string;
  writableDeltaRef?: string;
}
```

Before format freeze, decide whether mounted media bytes are embedded by
default or represented by hash plus writable delta. Restore must reject missing
or mismatched external media rather than continuing with a different disk.

Required format properties:

- versioned and rejectably incompatible;
- deterministic restore payload;
- integrity checked for payloads and referenced media;
- no absolute host paths as the only media identity;
- portable inside a C64RE project root.

## 4. Monitor and API Surface

Spec 623's monitor reservation becomes executable here:

```text
dump "<path>"
undump "<path>"
```

Required behavior:

- paths resolve under the project/session persistence policy;
- output reports resolved path, cycle, PC, machine model and mounted media;
- `dump` is not repeated by bare RETURN;
- `undump` stops live execution and publishes restored paused/debug state;
- toolbar and monitor state remain synchronized through Spec 701.

Expose the same operation over backend API so UI controls never implement
separate serialization logic.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 707.1 | Read the completed 705.B checkpoint/ref surface and define the persisted container/version/integrity contract. | 705.B |
| 707.2 | Implement native snapshot writer/reader around the single `RuntimeCheckpoint` payload. | 707.1 |
| 707.3 | Resolve media embedding/hash/delta policy and enforce restore validation. | 707.1 |
| 707.4 | Wire backend snapshot commands and Spec 623 monitor `dump`/`undump`. | 707.2 |
| 707.5 | Add project-root storage policy, summaries and incompatibility errors. | 707.3 |
| 707.6 | Add deterministic roundtrip and real-media/audio restore gates. | 707.4 |

## 6. Acceptance

1. Dump BASIC `READY.`, disturb/reset, `undump`, then run `N` cycles: state and
   continuation match the original checkpoint.
2. Dump a real-media VICE1541 session with reSID active; restore reproduces
   CPU/VIC/drive/IEC/reSID continuation under the Spec 705/706 contracts.
3. A snapshot referencing changed or unavailable external media fails clearly,
   unless it contains sufficient embedded content to restore independently.
4. Monitor `dump`/`undump` use the same backend implementation as any UI/API
   controls and leave no stale audio or frame transport.
5. Version or integrity failure is rejected, not partially restored.

## 7. Non-Goals

- VICE VSF parity or VSF as the internal format.
- Rewind navigation or checkpoint-ring UI (Spec 712).
- Declarative tracing (Spec 708).
- Visual inspection or patch branching (Specs 710/711).

## 8. References

- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/706-resid-audio-latency-governor.md`
- `specs/623-vice-monitor-debugger.md` section 7

## 9. Result (2026-05-23)

Implemented on the existing 705.A RuntimeCheckpoint + 705.B ring/restore — no
second snapshot model.

**Format (`.c64re`, canonical, §3):** `src/runtime/headless/kernel/native-snapshot.ts`.
Container = `MAGIC "C64RESNP"` + `u8 formatVersion` + `sha256(gzBody)` + gzipped
JSON `{ manifest, checkpoint, mediaPayloads }`. Checkpoint = the RuntimeCheckpoint
payload via a typed-array codec (`$ta`+base64) — RAM / VIC FB / opaque drive
`Uint8Array` / reSID state round-trip 1:1. Versioned + rejectable; sha256
integrity over body + per-embedded-media. No VSF internally.

**Media policy (§3, user-bound):** v1 EMBEDS the mounted source bytes + sha256
identity → self-contained, portable restore. The embedded source is the
non-authoritative identity/baseline; the mutable content rides in the checkpoint.

> **UPDATED (Spec 714 — mutable DISK is now persisted).** The "dirty disk aborts
> dump" policy is RETIRED for the disk: the VICE1541 snapshot runs `save_disks=1`
> and the mutated disk image is captured as `driveDiskImage` (Spec 714.2/714.3),
> so a dump after a disk write restores the WRITTEN content in a fresh session;
> it is content-addressed/deduped in the 705.B ring (714.4). Dirty detection
> (`GCR_dirty_track != 0 OR live-gcr-hash != attach-baseline`,
> `vice1541-facade.ts`) is retained for status, not as a dump gate.
>
> **Writable CARTRIDGE — EasyFlash IS persisted (Spec 713/714.5):** the EasyFlash
> port is now VICE-faithful (flash040core state machine + IO1 mirror + IO2 RAM +
> command-state snapshot), so its flash rides in `cartFlash` (content-addressed
> in the ring) and a written/mid-command EasyFlash dumps + restores faithfully.
> The dirty-cartridge dump reject survives only for the writable families still
> pending under Spec 713 (GMOD2/GMOD3/MegaByter, not-yet-verified Ocean/Magic
> Desk) — removed per family as each faithful port + its 714.5 gates pass.

**dump/undump (§4):** `src/runtime/headless/kernel/snapshot-persistence.ts` — the
single backend shared by the Spec 623 monitor `dump "<path>"` / `undump "<path>"`
commands AND the `snapshot/dump` · `snapshot/undump` WS API. Paths resolve under
`C64RE_PROJECT_DIR`. dump captures via the 705.B controller (instruction
boundary); undump validates → re-attaches embedded media → restores via the 705.B
path (706.8 audio transport flush runs), leaving the machine PAUSED with restored
debug state published. Bare RETURN never repeats dump (one-shot, no cursor).

**Port-fidelity fix found + applied (rule 6, reported first):** `drive_snapshot_read_module`
re-points the head via `drive_set_half_track` (port `drive_snapshot.ts:957`, VICE
`drive-snapshot.c`), but the facade had stubbed that hook to a no-op — latent for
in-session ring restore (head already in place), wrong for cross-session undump.
Wired the bridge hook to the real function (`vice1541-facade.ts`). VICE-faithful;
no pure-port change.

**Gates (all GREEN):** `probe:707-dump-undump` 10/10 — G1 BASIC roundtrip identity
+ run-N continuation; G2 real-media (motm.g64) + reSID undump continuation; G3
self-contained undump into a FRESH session (head/RAM/drive byte-exact); G4
integrity-flip rejected; G5 incompatible-version rejected; G6 dirty-disk dump
abort. 705.A (core/drive/reSID) + 705.B ring + 706 (latency/restore) probes green;
`check:1541-fidelity` 78 PASS / 0 FAIL; `runtime:proof` 7/7.

**Deferred (Non-Goals §7):** VSF import/export, rewind UI, writable-media delta,
external (non-embedded) media resolution.
