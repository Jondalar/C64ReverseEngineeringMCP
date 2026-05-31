# Spec 742 — Media Ownership + VICE-Faithful Write-Through Refactor

**Status:** DONE for the shipped scope (2026-05-31) — the BUG-023 failure mode is
fixed and gated (central `mountDiskMedia`, VICE-faithful D64/G64 + EasyFlash CRT
host-file write-through; Slices 1+2 below; `smoke:742` 9/9, `smoke:023-*` +
`smoke:023-cart` green). The full `MediaRef`/`MediaLibrary` ownership model (§4–§5)
and the remaining writable cart families are **backlog** (see "Remaining" — the
cart families are blocked on Spec 713 mapper ports; the ownership model is a
forward-looking refactor, not a bug). Closed here so it is not left perpetually
ACTIVE; reopen as a dedicated spec when the ownership model is scheduled. Created
after BUG-023 exposed that media mounting/writeback was split across UI, MCP,
scenario, ingress, snapshot and drive paths.  
**Owner:** runtime media / project media / 1541 diskimage / UI live backend  
**Depends on:** Specs 709, 714, 723, 724, 730  
**Related bugs:** BUG-023, BUG-010, BUG-013, BUG-015  

## 1. Problem

The runtime has too many media entry paths and no single ownership model.

Current paths include:

- MCP/runtime tool mount (`runtime_media_mount`, `runtime_session_start`);
- workspace/live UI picker;
- browser drag & drop / media ingress;
- scenario runner;
- project inventory / project-init media;
- snapshot/.c64re dump and restore;
- 1541 drive image attach/detach/writeback.

They pass different subsets of:

```text
bytes
name
path
readOnly
kind
project identity
writeback policy
```

The result is predictable: one path is fixed while another bypasses it. BUG-023
showed the hard failure mode: VICE writes disk-image changes to the real host file
at the writeback commit point, while our port often only mutates `media.bytes`
in RAM or loses the path identity entirely.

## 2. Product Rule

There is one product media model.

```text
Project media file -> MediaRef -> MountedMedia -> DiskImageBackend -> Drive1541
```

UI, MCP, scenario, drag/drop, and project tools do not invent their own disk
attachment semantics. They call one central media service.

For writable path-backed media, the host file is the persistence authority.
`media.bytes` is a cache/mirror, not the durable disk.

## 3. Non-Goals

- No rewrite of the 1541 core.
- No G64 auto-conversion policy in this spec.
- No UI redesign.
- No second product UI.
- No VICE dependency in product flow.
- No broad gameplay automation as acceptance; gates target ownership and
  write-through semantics.

## 4. Target Class / Module Shape

Names can change during implementation, but the responsibility split must hold.

```text
Project
  owns project dir, input/, working media, artifacts, knowledge

MediaLibrary
  scans/imports project media
  creates writable working copies
  resolves user/UI/project selections to MediaRef

MediaRef
  id, name, kind, sourcePath?, workingPath?, readOnly, sha256
  no emulator state

MountedMedia
  MediaRef + mutable bytes/cache + backingPath? + dirty state
  knows if host write-through is allowed

DiskImageBackend
  D64/G64 image logic
  maps VICE diskimage write points to cache + host-file writes
  owns write-through, read-only refusal, atomicity policy

Drive1541
  emulated drive core
  consumes DiskImageBackend / mounted image only
  does not know UI/MCP/project-origin details

RuntimeSession
  owns C64 + Drive1541 + mounted media refs
  exposes mount/swap/eject/persist through one API

UI / MCP / Scenario
  call RuntimeSession/MediaLibrary only
  never attach raw disk bytes directly unless transient/import path says so
```

## 5. Required Types

### 5.1 `MediaRef`

```ts
type MediaKind = "d64" | "g64" | "prg" | "crt";

type MediaRef = {
  id: string;
  kind: MediaKind;
  name: string;
  sha256: string;
  sourcePath?: string;
  workingPath?: string;
  readOnly: boolean;
  origin: "project-input" | "project-working" | "imported-bytes" | "scenario";
};
```

Rules:

- Human-visible UI may show name/project-relative path, not require manual path
  entry.
- Runtime internals must preserve `workingPath` or `sourcePath` whenever the
  backend can write to that file.
- Bytes-only browser drops are transient until imported into a project working
  file.

### 5.2 `MountedMedia`

```ts
type MountedMedia = {
  ref: MediaRef;
  bytes: Uint8Array;
  backingPath?: string;
  writable: boolean;
  dirty: boolean;
  lastWriteThroughAt?: string;
};
```

Rules:

- `backingPath` is present for writable project media.
- `writable=false` means host file must not change.
- `dirty` is a runtime/cache state; it is not a substitute for host persistence.

### 5.3 `DiskImageBackend`

The diskimage backend is the only layer that performs D64/G64 host writes.

```ts
interface DiskImageBackend {
  readHalfTrack(...): unknown;
  writeHalfTrack(...): void;
  flushDirtyTrack(...): void;
  persist(): void;
}
```

`writeHalfTrack`/`flushDirtyTrack` are VICE side-effect boundaries. If VICE would
`fwrite`/`fpwrite` to the image file there, the TS port must write to the host
file there for path-backed writable media.

## 6. RFL Side-Effect Rule

For every VICE function that writes external state, the TS port must preserve the
same side-effect target.

It is not sufficient that:

- an in-memory mirror changes;
- a snapshot blob changes;
- a later unmount/swap flush exists;
- a test re-reads RAM instead of the host file.

Acceptance for VICE file writes:

- the host backing file changes at the same semantic commit point as VICE;
- a fresh `readFile` from the filesystem observes the change;
- byte diff and mtime prove persistence.

## 7. Entry-Path Unification

Every disk mount entry point must resolve to the same central attach path.

| Entry path | Required behavior |
|---|---|
| MCP `runtime_media_mount` | Resolve project/local path to `MediaRef`, preserve backing path, mount through central service. |
| `runtime_session_start(disk_path)` | Same as MCP mount; no special direct attach. |
| Live UI picker | Server-resolvable project path must be preserved; do not reduce to `bytes+name`. |
| Browser drag & drop | Import bytes into project media/working copy first, or mount as transient non-write-through. |
| Scenario runner | Resolve scenario media to `MediaRef`; no private attach semantics. |
| Project init/inventory | Put media into typed project locations and register `MediaRef`s. |
| Snapshot/.c64re | Capture mounted media after dirty GCR is flushed; still separate from host-file write-through. |

## 8. Writable Media Policy

For project working media:

- writes are allowed;
- host file write-through is automatic at the VICE diskimage write point;
- unmount/swap/persist may perform safety flushes but are not the primary commit.

For original/input media:

- default should be read-only unless project-init explicitly creates a working
  copy;
- write attempts must be clear in status/logs;
- no silent mutation of original files.

For bytes-only uploads:

- no fake host write-through;
- either import into project storage and then mount path-backed, or mark transient.

## 9. Required Implementation Slices

### 742.1 — Media entry-path inventory

Audit all mount/attach paths and produce a table:

```text
entry path | source file | carries bytes | carries path | central attach? | write-through possible?
```

Acceptance:

- every known UI/MCP/scenario/ingress/snapshot path is listed;
- stale `v3` naming is identified where it hides product responsibility.

### 742.2 — Central `MediaRef` / `MountedMedia` attach service

Create the shared attach API and migrate disk entry paths to it.

Acceptance:

- UI picker, MCP mount, session-start and scenario mount produce the same
  mounted-media shape;
- project/local paths survive as `backingPath`;
- bytes-only ingress is explicit transient/imported.

### 742.3 — VICE-faithful D64 write-through

At the D64 `write_half_track` / dirty-track writeback boundary:

- update `media.bytes`;
- write the changed byte range to `backingPath` immediately for writable
  path-backed media;
- never write when `readOnly=true`.

Acceptance:

- temp D64 mounted from path;
- real VIA/rotation write;
- trigger drive writeback;
- fresh filesystem `readFile` sees changed bytes before unmount/swap;
- mtime changes.

### 742.4 — VICE-faithful G64 write-through

Same rule for G64 raw track/table writes.

Acceptance:

- temp G64 mounted from path;
- raw GCR writeback changes host file at commit point;
- fresh filesystem read verifies raw bytes/table update.

### 742.5 — Project-init media layout

`project_init` and inventory sync must place/register media predictably:

```text
input/disk/*.d64|*.g64
input/cart/*.crt
input/prg/*.prg
input/tape/*.t64|*.tap   (if/when supported)
working/disk/*           (writable copies)
working/cart/*           (writable cart copies, when applicable)
```

Acceptance:

- external files can be imported without manual path juggling;
- UI/MCP shows project-relative media choices;
- writable runs operate on working copies unless user explicitly chooses otherwise.

### 742.6 — Safety and status surfaces

Expose media state consistently:

- mounted media id/name/project-relative path;
- read-only/writable;
- backing path present/missing;
- dirty/cache state;
- last write-through result/error.

Acceptance:

- UI Live status and MCP session status agree;
- no stale recommendation to start a separate product UI;
- missing write-through backing path is visible and actionable.

## 10. Gates

Add targeted gates. Do not rely on gameplay automation.

Required:

- `smoke:742-media-entrypoints`
  - all mount paths route through the central attach service.
- `smoke:742-d64-write-through`
  - host D64 changes immediately at drive writeback commit.
- `smoke:742-g64-write-through`
  - host G64 changes immediately at drive writeback commit.
- `smoke:742-readonly`
  - read-only path-backed media does not mutate host file and reports why.
- `smoke:742-ui-picker-path-backed`
  - live UI picker path survives to mounted media and write-through works.

Regression:

- `smoke:023`
- `smoke:023-via`
- `smoke:023-snapshot-flush`
- `probe-single-path`
- `build:mcp`

## 11. Done Criteria

Spec 742 is DONE when:

1. there is one central media attach path for disk media;
2. UI/MCP/scenario/session-start no longer attach disks with private semantics;
3. path-backed writable D64/G64 writes are persisted to host files at the VICE
   writeback commit point;
4. unmount/swap persistence is only a safety flush, not the primary commit;
5. tests prove host-file bytes and mtime, not just `media.bytes`;
6. docs/playbooks recommend one product UI/start command:

```bash
npm run workspace -- --project "<projectDir>"
```

and do not tell normal users/LLMs to run `v3:server`, `ui:v3:dev`, or `/v3.html`
as product workflow.

## 12. Open Questions

- **OQ1:** Exact write strategy for D64/G64 host writes: write-at-offset vs
  whole-image temp+rename. Default should be faithful commit timing with minimal
  safe write surface; do not hide writes until unmount.
- **OQ2:** Whether original `input/` media may ever be writable directly. Default
  answer: no, create/select working copy.
- **OQ3:** Whether `v3-ws-server.ts` should be renamed in this spec or only
  documented as the legacy-named live runtime backend. Product copy must not call
  it a second UI either way.

---

## Implementation — Slice 1 (shipped 2026-05-31)

First slice: collapse every disk-media attach onto ONE function and make
writable path-backed media write through to the host file. The full
`MediaRef`/`MediaLibrary`/`DiskImageBackend` ownership model (§4–§5) is the next
slice; this slice removes the immediate BUG-023 failure mode and the
multiple-attach-path divergence.

### Audit — disk attach entry paths (before Slice 1)

| Entry path | File | Carries bytes | Backing path | Writable | Central attach? | Write-through |
|---|---|---|---|---|---|---|
| UI picker / live backend | `v3-ws-server.ts` `buildIngressRequest` → ingress | yes | **dropped** `p.path` | yes | no | **no** |
| drag&drop / media ingress | `media/ingress.ts` disk case | yes (b64) | none (uploaded) | yes | no | no (correct: no file) |
| `runtime_media_mount` | `media/mount.ts` `mountMedia` | yes | yes | yes | no | yes (only path that had it) |
| `runtime_session_start(disk_path)` | → `mountMedia` | yes | yes | yes | no | yes |
| standalone drive session | `drive1541/drive-session-manager.ts` | yes | **dropped** `opts.diskPath` | configurable | no | no |
| scenario runner | `scenario/dsl.ts` → ingress/mount | via above | via above | via above | no | via above |
| snapshot undump | `kernel/snapshot-persistence.ts` | embedded baseline | none (restore) | n/a | no | n/a |
| project_init media | register-only (no attach) | — | — | — | — | — |

Why prior gates missed it: every disk-write test asserted on RAM `media.bytes` /
a checkpoint blob / a `_session.g64` side-file; none mounted by path, wrote, and
re-read the **host file** (bytes + mtime). See BUG-023 doctrine.

### Shipped

- **One central attach** `src/runtime/headless/media/mount-disk-media.ts`:
  `mountDiskMedia(target, { kind, name, bytes, backingPath?, readOnly?, source })`
  + `persistDriveToFile(drive, path)`. It threads `backingPath` (write-through
  identity), treats a disk change as an implicit eject (persist + detach the
  outgoing disk), and records the path identity on the session/target.
- **All disk attach paths routed through it**: `media/mount.ts` (mount tool /
  session-start), `media/ingress.ts` (UI picker + drag&drop), `drive-session-
  manager.ts` (standalone). `v3-ws-server.ts` now forwards the picker's
  server-resolvable `p.path` as `backingPath`; uploaded bytes (no path) stay
  RAM-only.
- **VICE-faithful write-through** (BUG-023): `fsimage_dxx/gcr_write_half_track`
  call `fsimage.hostFlush()` at the `util_fpwrite` commit; the facade installs it
  for writable path-backed media → the host `.d64`/`.g64` changes at the writeback
  (no unmount/snapshot). Boundary persist is a safety flush only.
- **Read-only** media installs no write-through hook and is never written.

### Gates

- `npm run smoke:742` (9/9) — central `mountDiskMedia` threads backing-path
  identity, write-through to the host file, disk-change persists the outgoing
  disk, uploaded bytes RAM-only.
- `npm run smoke:023-write-through` (7/7), `smoke:023-host-file` (8/8),
  `smoke:023-via` (6/6), `smoke:023-snapshot-flush` (4/4), `smoke:023`,
  `probe-single-path` (25/25), `check:mcp-product-surface` (all green).

### Slice 2 (shipped 2026-05-31) — EasyFlash CRT write-through

Same RFL class for cartridges (BUG-023-cart). `parseCrt` keeps `rawBytes`;
`EasyFlashMapper.getCrtImage()` re-packs the live flash into the original `.crt`
(CHIP packets overwritten in place); `media/persist-cartridge.ts`
`persistCartridgeToFile` writes the host `.crt`; `ingress.ts` stores
`session.cartPath` on mount and writes the programmed flash back on eject (VICE
saves on detach); `v3-ws-server` forwards `p.path`. Gate `npm run smoke:023-cart`
(7/7); Spec 714.5 stays green (33/33).

### Remaining (next slices)

- Full `MediaRef` / `MediaLibrary` ownership (§4–§5); working-copy creation.
- Scenario media + snapshot-restore path identity through the same model.
- Other writable cart families (MegaByter/flash800, GMOD2 m93c86 EEPROM,
  spi-flash) get `getCrtImage`; real EF boot→program→eject runtime gate.
- Atomicity policy (in-place vs temp+rename) decision in `DiskImageBackend`.
