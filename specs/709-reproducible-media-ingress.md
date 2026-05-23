# Spec 709 - Reproducible Media Ingress: Disk, PRG, CRT and Drag/Drop

Status: IMPLEMENTATION-READY DRAFT (reviewed 2026-05-23 CEST)
Depends: Specs 701, 705, 707
Consumed by: Specs 710-712
Owner: runtime / UI / media

## 1. Purpose

Give the live runtime one reproducible media-ingress contract for disks, PRGs
and cartridges. UI drag/drop, monitor commands and APIs must invoke the same
backend operations and produce replayable experiment events.

This is required before visual evidence, code overlay branches and rewind can
identify how the machine reached a state.

### 1.1 Verified Foundation and Migration Boundary

The runtime already has a live media surface; this spec replaces and completes
that route rather than introducing a parallel ingress system:

- `src/runtime/headless/media/mount.ts` handles path-based disk and PRG
  operations today.
- `src/workspace-ui/v3-ws-server.ts` exposes `media/mount`, `media/unmount`
  and `media/swap`, serialized through `RuntimeController.runExclusive()`.
- Disk attach/detach reaches the active VICE1541 facade for drive 8.
- PRG currently injects through `session.loadPrgIntoRam(path)` without an
  explicit load-vs-inject contract.
- CRT is currently parsed/identified by the media module but is not attached
  to the active live session.
- Spec 707 embeds clean mounted disk bytes and rejects dirty writable media;
  it does not persist post-mount disk writes or deltas in v1.

All 709 work must migrate these existing entry points to one typed service.
Path-based legacy success responses must not remain beside byte/hash/event-based
ingress.

## 2. Binding Decisions

### 2.1 Backend Owns Media Operations

The UI does not interpret or mount media directly. It sends an ingress request;
the backend identifies the type, applies the operation at a deterministic
boundary, records it and returns the resulting runtime/media state. Existing
WS media routes become thin adapters to this service or are retired.

### 2.2 Initial Media Defines an Experiment Root

Starting a session with disk, cartridge or injected PRG defines the initial
experiment root. A later mount/eject/swap in a running session is a recorded
media intervention event preceded and followed by a pinned checkpoint. The
controller remains paused after the intervention until explicitly resumed.

### 2.3 Media Identity Must Survive Snapshot and Replay

Every accepted medium has format, content hash, display name and runtime role.
Writable disk state or generated deltas must be carried by the checkpoint /
persistence contract from Specs 705/707.

For v1, Specs 705/707 do not carry writable disk deltas. Therefore a dirty
mounted disk may not be ejected, swapped, persisted as a branch root or silently
discarded through this reproducible ingress contract. The operation fails with
a precise dirty-media error until a later writable-delta slice is specified.

## 3. Supported Operations

First required set:

```ts
type MediaIngressRequest =
  | { kind: "disk"; role: "drive8"; bytes: Uint8Array; name: string }
  | { kind: "prg"; bytes: Uint8Array; name: string; mode: "load" | "inject-run" }
  | { kind: "crt"; bytes: Uint8Array; name: string; resetPolicy: "reset" | "power-cycle" }
  | { kind: "eject"; role: "drive8" | "cartridge" };
```

Required initial formats:

- disk: the formats already supported by the active VICE1541 path, including
  `.d64` and `.g64`;
- PRG: load/inject behavior must be explicit, never guessed silently;
- CRT: real cartridge mapping/reset policy, not PRG extraction disguised as
  cartridge support.

Drive 9 is not wired through the current live media path and is deferred from
the first implementation. A drive 9 request must be rejected as unsupported,
not accepted without an active attach.

`.c64re` is not media ingress. It remains the Spec 707 snapshot `undump` path,
because it restores a full machine experiment rather than mounting content.

Drag/drop chooses a proposed operation from extension/header sniffing and shows
the resolved operation before any destructive reset/power-cycle behavior.

## 4. Event and Checkpoint Contract

Each operation emits a replayable event:

```ts
interface MediaIngressEvent {
  cycle: number;
  operation: MediaIngressRequest["kind"];
  role?: string;
  format?: string;
  sha256?: string;
  resetPolicy?: string;
  checkpointBeforeId?: string;
  checkpointAfterId?: string;
}
```

For mid-session media changes:

1. pause at a safe boundary;
2. capture/pin the before-state as required by 705.B;
3. apply ingress;
4. perform required reset/power-cycle policy;
5. capture the resulting branch root;
6. resume only by explicit user/runtime-controller action.

If the current medium is dirty and its state cannot be persisted by the active
snapshot format, step 1 terminates with an error and no detach, swap or branch
mutation occurs.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 709.1 | Lock the existing-surface inventory: `mount.ts`, current WS routes, drive8-only runtime, PRG implicit inject behavior, CRT parse-only behavior and 707 dirty-media boundary. | none |
| 709.2 | Implement one typed byte-based media-ingress service, content identity and event model; route/retire the existing path-based WS operations. | 707, 709.1 |
| 709.3 | Route drive8 `.d64`/`.g64` mount/eject/swap through checkpoint-before/after events; enforce the dirty-media hard stop; prove VICE1541 continuation. | 709.2 |
| 709.4 | Implement explicit PRG `load` and `inject-run` semantics, with monitor/API commands and replay evidence. Do not keep silent `loadPrgIntoRam` inference. | 709.2 |
| 709.5 | Wire real CRT live attach/eject and required reset/power-cycle semantics to the active session; reject a parse-only success result. | 709.1-2 |
| 709.6 | Wire UI file chooser/drag-drop to the same service, including visible destructive-reset confirmation; add replay gates. | 709.3-5 |

## 6. Acceptance

1. Mounting the same disk through API, monitor and drag/drop produces the same
   media identity and active drive state.
2. A `.d64` and `.g64` real-media session survive checkpoint persistence and
   restore with matching continuation.
3. PRG operation is visible as either load or inject-run and reproducible from
   the event log.
4. CRT attach uses real cartridge state and documented reset behavior; restore
   and replay reproduce the attached cartridge.
5. A mid-session disk swap creates checkpointed branch evidence rather than
   mutating history invisibly.
6. Dirty writable disk state prevents swap/eject/dump with a precise error;
   no unrecorded disk mutation is lost.
7. Unsupported drive 9 requests and `.c64re`-as-media requests fail explicitly.

## 7. Non-Goals

- Fastloader or cartridge emulation fixes unrelated to ingress.
- Visual inspect UI (Spec 710).
- Overlay patches to media contents (Spec 711).
- Rewind navigation UI (Spec 712).
- Writable-disk delta export/replay and drive 9 attachment in v1.

## 8. References

- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/413-1541-phase-g-image-formats.md`
- `src/runtime/headless/media/mount.ts`
- `src/workspace-ui/v3-ws-server.ts`
- `src/runtime/headless/kernel/snapshot-persistence.ts`
