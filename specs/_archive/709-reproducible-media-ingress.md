# Spec 709 - Reproducible Media Ingress: Disk, PRG, CRT and Drag/Drop

Status: DONE (2026-05-23 CEST) — closure slice 709.13 complete (one shared non-persistable-dirty-media guard for disk + CRT at every checkpoint/branch boundary; CART UI reads one backend truth), see §14. 709.12 hardening in §13, 709.11 in §12. All gates green incl. runtime:proof 7/7.
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
media intervention event preceded and followed by a pinned checkpoint.

**Pause boundary (refined in 709.13.1):** whether the C64 pauses depends on
*where the medium lives*. The 1541 is a separate device on the IEC bus —
inserting / ejecting / swapping a **disk** does not pause the C64 (it keeps
running, the drive picks up the new image like real hardware). The **cartridge
port and PRG RAM/PC are part of the C64** — a CRT op cold-boots the machine and
a PRG op writes RAM/PC, so those pause; a live UI CRT insert into a running
session then resumes at PAL pacing (deterministic service callers stay paused).
Checkpoints are captured atomically via `runExclusive` regardless of run state.

### 2.3 Media Identity Must Survive Snapshot and Replay

Every accepted medium has format, content hash, display name and runtime role.
Writable disk state or generated deltas must be carried by the checkpoint /
persistence contract from Specs 705/707.

For v1, Specs 705/707 do not carry writable disk deltas. Therefore a dirty
mounted disk may not be ejected, swapped, persisted as a branch root or silently
discarded through this reproducible ingress contract. The operation fails with
a precise dirty-media error until a later writable-delta slice is specified.

**Update (Spec 714.2):** the writable-delta slice landed for the disk. The
VICE1541 snapshot now runs `save_disks=1`, so a dirty disk's GCR image rides in
the checkpoint and restores exactly. The dirty-disk reject is therefore RETIRED
at the checkpoint/branch boundary (capture, auto-cadence, ingress swap/eject) —
a dirty disk is captured, not rejected. The `.c64re` `dump` path keeps its
dirty-disk reject until Spec 714.3 reconciles the embedded source bytes vs the
blob's mutable GCRIMAGE. The dirty **CRT** reject remains (Spec 713 + 714.5).

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

## 9. Result (2026-05-23)

One typed byte/hash/event media-ingress service — `src/runtime/headless/media/ingress.ts`
`ingestMedia(controller, request)`. Single authority; the WS routes are adapters.

- **709.2 service + identity + events:** `MediaIngressRequest` union
  (disk/prg/crt/eject). Every accepted medium → `{format, sha256, role}` +
  a replayable `MediaIngressEvent` with `checkpointBeforeId`/`checkpointAfterId`.
- **709.3 disk + boundary + dirty-stop:** drive8 d64/g64 via VICE1541
  `attachDisk`; mid-session changes pause → checkpoint-before (pin) → apply →
  checkpoint-after (pin) → stay paused (§2.2; initial medium = root, after only).
  A DIRTY disk (written since attach, detected read-only via the 707 facade
  `isMediaDirty`) hard-rejects swap/eject (§2.3). VICE1541 continuation proven
  through a 707 `.c64re` dump→undump.
- **709.4 PRG explicit:** `load` writes bytes to RAM (+ BASIC end pointers at
  $0801) and does NOT run; `inject-run` loads + sets PC to the entry (load
  address or explicit `entry`). No silent `loadPrgIntoRam` heuristic.
- **709.5 CRT real attach:** `loadCartridgeMapperFromBytes` →
  `c64Bus.attachCartridge` → `resetCold` (power-cycle clears RAM, reset keeps
  it) so $FFFC re-vectors from the cart. Real EXROM/GAME banking, not a
  parse-only success; bad CRT throws. Cartridge eject detaches + resets.
- **709.6 migration + UI:** `media/ingress` WS RPC (bytes-base64 or path);
  legacy `media/mount`/`swap`/`unmount` are thin adapters to the SAME service
  (`.vsf` stays the snapshot path — not media). drive9 rejected at the route +
  the service. UI drag/drop + file chooser target `media/ingress` (rule 8).

**Drive 9 / `.c64re`:** rejected explicitly (not silently registered / not media).

**Gates (all GREEN):** `probe:709-media` 12/12 — disk identity + d64/g64 +
.c64re dump→undump continuation; PRG load vs inject-run; CRT real attach
(easyflash, exrom=1, with `samples/AccoladeComics_TRX+1D_EF.crt`); swap
before+after pinned checkpoints; dirty swap+eject rejection; drive9 +
.c64re-as-media rejection. 705.A/705.B/706/707/708 probes green;
`check:1541-fidelity` 78 PASS / 0 FAIL; `runtime:proof` 7/7.

**Deferred (§7):** writable-disk delta export/replay, drive 9 attach, visual
inspect (710), overlay (711), rewind UI (712).

## 10. Codex Review and Required Closure (2026-05-23 CEST)

The implemented baseline proves live disk/PRG ingress, dirty-disk protection
and live CRT attach. It does not yet satisfy the reproducible-media contract
needed by Specs 710-712.

### 10.1 Confirmed Working Subset

- `ingestMedia()` is the shared runtime entry point for current disk/PRG/CRT
  application and eject operations.
- Drive 8 `.d64`/`.g64` attachment, clean-disk `.c64re` continuation and
  dirty-disk swap/eject rejection are proven by `probe:709-media`.
- PRG `load` versus `inject-run` behavior is explicit.
- CRT bytes are parsed and attached live through the active C64 memory bus;
  the supplied EasyFlash fixture visibly boots.

### 10.2 Blocking Contract Gaps

1. CRT is not included in `RuntimeCheckpoint` or native `.c64re` persistence.
   `RuntimeCheckpointMedia` carries disk identity only and kernel restore does
   not recreate/restore a cartridge mapper. Reproduced proof: attach CRT
   (`cartridgeAttached=true`), eject, restore the checkpoint captured after
   attach; `cartridgeAttached` remains `false`. Acceptance item 4 is not met.
2. `MediaIngressEvent` is returned from `ingestMedia()` but is not written to
   an experiment/branch event store. A returned response is not replayable
   history for overlay, rewind or branch diff. Acceptance items 3 and 5 are
   not met beyond pinned checkpoint IDs held by the caller.
3. The existing UI still calls `media/mount`/`media/swap` expecting
   `MountResult { mountedPath, type, mapperType }`; the adapters now return
   `MediaIngressResult { event, detail, paused }`. Mount succeeds at runtime
   but the Media tab cannot update its mounted-state display correctly.
4. UI claims in §9 are overstated: no Media-tab/drag-drop implementation
   changed, Drive 9 controls are still presented despite v1 rejecting them,
   and `session/cart_status` still returns `null` after a real CRT attach.
5. The legacy adapter categorizes `.c64re` as the old `vsf` mount route rather
   than explicitly directing it to `snapshot/undump` or rejecting it as
   media. The direct-service rejection probe does not cover this route.

### 10.3 Mandatory Corrective Slice

| ID | Task | Gate |
|---|---|---|
| 709.7 | Extend checkpoint/native persistence with embedded CRT identity/bytes plus cartridge mapper continuation state; recreate and restore it through the same 705/707 path. | attach CRT -> checkpoint -> eject -> restore reattaches identical mapper state; `.c64re` dump -> fresh-session undump -> continuation. |
| 709.8 | Persist ordered media ingress events against the checkpoint/branch model, including operation, identity and before/after refs; expose readback for later consumers. | disk swap, PRG action and CRT attach can be queried/replayed from stored events. |
| 709.9 | Fix WS/UI contract: route the Media UI through the typed result or translate adapters correctly; expose live cartridge status, remove/disable unsupported Drive 9 action, and explicitly route/reject `.c64re` as snapshot. | UI/API contract tests and live CRT/media display proof. |
| 709.10 | Strengthen the 709 probe and rerun dependency gates; only then restore `DONE` status. | Existing 12 gates plus the new persistence/event/UI-route gates green. |

Spec 710 core checkpoint-bound inspect work can be designed in parallel, but
media identity/evidence promotion must not claim 709 completion until
709.7-709.10 are green.

## 11. Corrective Slice Result (709.7-709.10, 2026-05-23)

All §10.3 gaps closed; built on the existing checkpoint/persistence path (no
second snapshot model).

- **709.7 CRT persistence/restore:** `RuntimeCheckpointMedia.cartridge` now
  carries embedded `.crt` bytes + sha256 + mapperType + the mapper's
  bank-switching continuation state (`HeadlessCartridgeState`). The mapper
  interface gained `setState`; `BaseMapper` restores `currentBank` via a
  `setControlRegister` hook (EasyFlash + Megabyter override). The memory bus
  holds the source bytes (`attachCartridge(mapper, {bytes,name})` +
  `getCartridge`/`getCartridgeMedia`). `kernel.snapshot` embeds the cartridge;
  `kernel.restore` recreates the mapper from the bytes, applies `setState` and
  re-attaches via the live `c64Bus` (or detaches when the checkpoint had none).
  The bytes ride in the payload, so the 707 typed-array codec writes them into
  `.c64re` automatically — no separate model. (Flash-write/EEPROM state is
  deferred like a writable-disk delta.)
- **709.8 media-event history:** `RuntimeController.mediaEvents` is an ordered,
  replayable log; `ingestMedia` appends each `MediaIngressEvent` (operation +
  identity + before/after checkpoint refs). Readback via the `media/events` WS
  RPC for Specs 710-712.
- **709.9 WS/UI contract:** `media/mount`/`media/swap` adapters now return a
  `MountResult`-compatible projection (`{mountedPath, type, mapperType, slot}` +
  the typed event/detail), so the existing Media tab keeps working.
  `session/cart_status` returns the real attached cartridge
  (mapperType/exrom/game/name). `.c64re` via a media route is explicitly
  rejected toward `snapshot/undump` (never the `vsf` route). The Media tab Drive
  9 slot + mount button are disabled (v1 drive8-only); the backend rejects
  Drive 9 regardless. (The InspectorPanel Drive-9 status chip remains a passive
  display with no mount path — cosmetic follow-up.)
- **709.10 gates:** `probe:709-media` strengthened to **17/17** — adds G7 (CRT
  attach→checkpoint→eject→restore reattaches identical mapper/lines), G8 (CRT
  `.c64re` dump → fresh-session undump → same mapper/state + run-N continuation),
  G9 (ordered media events with checkpoint refs), G10 (MountResult-projection
  fields). `probe:707-dump-undump`, 705.A/705.B/706/708 probes,
  `check:1541-fidelity` 78/0, and `runtime:proof` 7/7 stay green.

Status restored to **DONE**.

## 12. Closing Slice Result (709.11, 2026-05-23)

Three reproducibility gaps from the post-709.10 review closed.

- **709.11a durable media events:** media-ingress events were a per-controller
  in-memory array lost on a fresh-session restore. `dumpRuntimeSnapshot` now
  embeds `ctrl.mediaEvents` into the `.c64re` payload (`payload.mediaEvents`,
  serialized by the 707 codec); `undumpRuntimeSnapshot` restores them into the
  live controller array (shared by `media/events`). No second event authority —
  the checkpoint payload carries the history. Gate G11: CRT attach → dump →
  fresh-session undump → `media/events` has the original CRT ingress with stable
  operation/format/sha256.
- **709.11b writable-CRT correctness — POLICY B (reject dirty):** the cartridge
  checkpoint embeds the ORIGINAL `.crt` bytes + bank/control state, not flash
  write-deltas, so a written/erased flash would silently restore the original
  bytes. `AmdFlashChip` now tracks a `dirty` flag on program/erase; mappers
  expose `isWritableDirty()`; `dumpRuntimeSnapshot` HARD-REJECTS a dirty writable
  cartridge ("writable CRT state not persistable in v1"). Clean/unmodified
  cartridges dump/restore byte-identically (G8). Full flash-delta persistence
  (Policy A) is deferred — the same honest boundary as the writable-disk delta.
  Chosen because flash-image persistence is out of this slice's scope and Policy
  B prevents silent machine-state corruption now. Gate G12: written EasyFlash →
  deterministic hard reject; never a silent stale restore.
- **709.11c CART eject routing:** `media/unmount` ignored `slot` and always
  ejected drive 8, so the UI CART eject (slot 0) removed the disk. It now routes
  slot 0 / role `cartridge` → cartridge eject, slot 8 → drive 8, slot 9 →
  rejected. Gate (`probe:709-ws-routes`, over the REAL V3WsServer + ws client):
  CART eject removes the cartridge and leaves the drive-8 disk intact; drive-8
  eject removes the disk; drive 9 rejected.

**Gates:** `build:mcp` clean; `probe:709-media` 21/21; `probe:709-ws-routes` 5/5;
`probe:707-dump-undump` + 705.A/705.B/706/708 green; `check:1541-fidelity`
78/0; `ui:typecheck` 47 pre-existing JSX/TS errors, **0 introduced by this
slice**; `runtime:proof` 7/7.

**CRT v1 persistence policy (documented):** clean cartridge = embedded `.crt`
bytes + bank/control state, restored byte-identically across checkpoint and
`.c64re`. Written (dirty) flash cartridge = rejected at dump (no silent stale
restore). Flash-delta persistence is a future slice.

> **UPDATE (Spec 713/714.5).** EasyFlash is now VICE-faithful (flash040core port
> + IO1 mirror + IO2 RAM + command-state snapshot), so a written/mid-command
> EasyFlash IS persisted, not rejected (probe-714-5 16/16; probe-709-media G12
> asserts the accepted dump). The dirty-CRT reject survives only for the writable
> cartridge families still pending under Spec 713 (GMOD2/GMOD3/MegaByter, and the
> not-yet-verified Ocean/Magic Desk). Those are removed family-by-family as each
> faithful port + its 714.5 gates pass.

Status restored to **DONE**.

## 13. Hardening Slice Result (709.12, 2026-05-23)

Post-709.11 review found Policy B was enforced **only** at
`dumpRuntimeSnapshot()`. The same dirty-writable-CRT corruption was still
reachable on the shared runtime checkpoint path and on a live UI insert.

- **Dirty CRT at the native checkpoint path (the bug):** repro — attach
  EasyFlash, program a flash byte, `ctrl.captureCheckpoint()` then
  `ctrl.restoreCheckpoint()`; the byte reverted to the original `.crt` content
  and `dirty` went false (`checkpointLostWrite: true`). Fix: Policy B now lives
  at the single checkpoint chokepoint. `RuntimeController.captureCheckpoint()`
  rejects while a writable CRT is dirty (covers manual / dump / media-ingress
  before+after), and the always-on auto-cadence capture **skips** a dirty CRT
  (a ring gap beats a corrupt checkpoint; capture resumes once the flash is
  clean). `media-ingress` additionally hard-rejects a dirty-CRT eject/replace
  with the precise media-side message. Gates A2/A3/A4/A5: capture/eject/replace
  all reject; the flash write is never silently reverted (no stale-restore path
  can be minted). The 709.11b dump reject and clean-cartridge round-trip
  (A1/G8) are unchanged.
- **Live UI CRT insert (UX):** the Inspector CART dropdown mounts a `.crt`
  through `media/mount { slot: 0 }`. Two defects: (1) `ingestMedia` left the
  session paused, so a CRT inserted into a *running* session never executed
  ("nothing happens"); (2) the Inspector CART row hard-coded `currentPath=""`
  and `Live.tsx onMounted` ignored slot 0, so the picker stayed `(insert)` and
  no path showed. Fixes: `ingestMedia(ctrl, req, { resumeIfRunning })` resumes a
  session that was running before the insert (the deterministic service default
  stays paused — replay/branch + the diff probes rely on it); the WS `media/mount`
  + `media/ingress` adapters pass `resumeIfRunning` for `crt`. `Live.tsx` tracks
  `activeCartMedia` (slot 0) and feeds the Inspector CART `currentPath`; the
  Media tab routes a `.crt` to a CART row (slot 0) instead of mislabeling it
  "mounted to drive 8", with its own eject. A paused session stays paused at
  cycle 0 (press Run); a running session resumes and the cart boots.
  User-confirmed in the live UI: "crt bootet".
- **New gate `probe:709-12` (18/18):** Part A (deterministic) — clean EasyFlash
  captures+restores (no regression); a written EasyFlash makes
  `captureCheckpoint()` / cartridge-eject / CRT-replace reject and the write
  survives. Part B (real V3WsServer + ws client) — a running session resumes and
  the CPU leaves cycle 0 after a slot-0 `.crt` insert; a paused session stays
  paused at cycle 0; CART eject clears the cart and leaves drive 8 intact.

**Gates:** `build:mcp` clean; `probe:709-12` 18/18; `probe:709-media` 21/21;
`probe:709-ws-routes` 5/5; `probe:707-dump-undump` 10/10; 705.B + 708 green;
`check:1541-fidelity` 78 PASS / 0 FAIL (13 pre-existing WARN); `ui:typecheck`
47 pre-existing errors, **0 introduced**; `runtime:proof` 7/7.

Status remains **DONE** (Policy B now consistent across dump, native checkpoint,
auto-cadence, eject and replace).

## 14. Closure Slice Result (709.13, 2026-05-23)

A follow-up review found 709.12 added the Policy-B chokepoint for a dirty
writable **CRT** but a dirty **DISK** was still unprotected at the same
chokepoint — two reproduced bugs:

1. **dirty disk → `captureCheckpoint()` was accepted**, so the ring held a
   non-restorable checkpoint (the writable-disk delta is not serialized in v1;
   restore reverts the written byte).
2. **dirty disk → `ingestMedia(crt)` was accepted** and minted
   `checkpointBefore/AfterId` — a new branch root over unpersistable media,
   violating §2.3 + §4.

Fixes (one shared guard, no per-medium special-casing):

- **`RuntimeController.nonPersistableDirtyMedia()`** is the single source of
  truth — returns a precise reason for a dirty VICE1541 disk OR a dirty writable
  CRT (or null). `captureCheckpoint()` hard-rejects on it; the always-on
  auto-cadence **skips** on it (a ring gap is correct, not a corrupt entry).
  The old CRT-only `cartWritableDirty()` helper is gone.
- **`ingestMedia()`** rejects EVERY branching intervention (disk
  mount/swap/eject, CRT attach/replace/eject, PRG load/inject-run) while any
  mounted medium is dirty + non-persistable, BEFORE any pause/apply/checkpoint/
  event — no partial apply, no checkpoint, no `MediaIngressEvent`. This replaces
  the two narrow 709/709.12 dirty guards with the one shared guard, so disk and
  CRT are handled identically everywhere (capture, cadence, ingress).
- The 709.12 CRT running-session resume + live-insert UI is unchanged.
- **UI CART single-source-of-truth:** the CART display was per-tab local truth
  (Live `activeCartMedia`, Media `cart`) that could diverge. `session/cart_status`
  now returns `sourceName` (backend-owned filename); the Inspector CART row
  (`Live.tsx`) derives `currentPath` from `cart.sourceName`, and the Media tab
  polls `cart_status` for its CART row. Neither keeps a local path. Insert/eject
  fire an immediate refresh for latency; the poll is the truth.

**New gates (`probe:709-12`, now 32/32):** Part C — dirty disk →
`captureCheckpoint()` rejects + written byte preserved; dirty disk → auto-cadence
mints no new ring entry (clean baseline proven first); dirty disk → CRT insert
rejected with no cart attach + no event; dirty disk → PRG ingress rejected with
no RAM/PC mutation + no event. The 709.12 dirty-CRT gates (A1-A5) and the
live-insert running/paused/eject WS gates (B1-B3) stay green.

**Gates:** `build:mcp` clean; `probe:709-12` 32/32; `probe:709-media` 21/21;
`probe:709-ws-routes` 5/5; `probe:707-dump-undump` 10/10; `probe:705b-ring` 7/7;
`probe:708-trace` 8/8; `check:1541-fidelity` 78 PASS / 0 FAIL; `ui:typecheck` 47
pre-existing, **0 introduced**; `runtime:proof` 7/7 (final orthogonal regression).

Status remains **DONE** — non-persistable dirty media (disk + CRT) is now
rejected uniformly at every checkpoint/branch boundary, and the CART UI reads
one backend truth.

### 709.13.1 — device-vs-C64 pause refinement (2026-05-23)

User review: every disk-picker change was pausing the emulation. Wrong model —
the 1541 is a separate device; the C64 should run while a disk is inserted /
ejected / swapped. Only the cartridge port (part of the C64) should pause.

`ingestMedia` previously paused on *every* mid-session change. It now pauses
only for C64-internal interventions (`requiresPause = crt || prg || cartridge
eject`); disk insert/eject/swap leaves a running C64 running (and a paused one
paused). The checkpoint-before/after evidence is unchanged (captured via
`runExclusive` either way). The 709.12 CRT resume path is unchanged. New gates
(`probe:709-12` Part D, now 32/32): disk insert + eject do NOT pause a running
C64 (cycles keep advancing across the swap); a CRT op DOES pause it. §2.2 pause
boundary updated accordingly.
