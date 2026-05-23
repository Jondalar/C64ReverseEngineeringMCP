# Spec 709 - Reproducible Media Ingress: Disk, PRG, CRT and Drag/Drop

Status: DRAFT (2026-05-23 CEST)
Depends: Specs 701, 705, 707
Consumed by: Specs 710-712
Owner: runtime / UI / media

## 1. Purpose

Give the live runtime one reproducible media-ingress contract for disks, PRGs
and cartridges. UI drag/drop, monitor commands and APIs must invoke the same
backend operations and produce replayable experiment events.

This is required before visual evidence, code overlay branches and rewind can
identify how the machine reached a state.

## 2. Binding Decisions

### 2.1 Backend Owns Media Operations

The UI does not interpret or mount media directly. It sends an ingress request;
the backend identifies the type, applies the operation at a deterministic
boundary, records it and returns the resulting runtime/media state.

### 2.2 Initial Media Defines an Experiment Root

Starting a session with disk, cartridge or injected PRG defines the initial
experiment root. A later mount/eject/swap in a running session is a recorded
media intervention event preceded by an immediate checkpoint.

### 2.3 Media Identity Must Survive Snapshot and Replay

Every accepted medium has format, content hash, display name and runtime role.
Writable disk state or generated deltas must be carried by the checkpoint /
persistence contract from Specs 705/707.

## 3. Supported Operations

First required set:

```ts
type MediaIngressRequest =
  | { kind: "disk"; role: "drive8" | "drive9"; bytes: Uint8Array; name: string }
  | { kind: "prg"; bytes: Uint8Array; name: string; mode: "load" | "inject-run" }
  | { kind: "crt"; bytes: Uint8Array; name: string; resetPolicy: "reset" | "power-cycle" }
  | { kind: "eject"; role: "drive8" | "drive9" | "cartridge" };
```

Required initial formats:

- disk: the formats already supported by the active VICE1541 path, including
  `.d64` and `.g64`;
- PRG: load/inject behavior must be explicit, never guessed silently;
- CRT: real cartridge mapping/reset policy, not PRG extraction disguised as
  cartridge support.

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

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 709.1 | Inventory active disk/PRG/CRT backend support and remove UI-only assumptions from the plan. | none |
| 709.2 | Implement typed media-ingress service, hashing and event representation. | 707 |
| 709.3 | Route disk mount/eject/swap through the service and prove VICE1541 continuation. | 709.2 |
| 709.4 | Implement explicit PRG load/inject-run semantics and monitor/API commands. | 709.2 |
| 709.5 | Implement CRT attach/eject/reset contract against the active cartridge runtime. | 709.1-2 |
| 709.6 | Wire UI file chooser/drag-drop to the same service; add replay gates. | 709.3-5 |

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

## 7. Non-Goals

- Fastloader or cartridge emulation fixes unrelated to ingress.
- Visual inspect UI (Spec 710).
- Overlay patches to media contents (Spec 711).
- Rewind navigation UI (Spec 712).

## 8. References

- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/413-1541-phase-g-image-formats.md`
