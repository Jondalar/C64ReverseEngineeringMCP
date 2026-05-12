# Spec 512 — VSF-Inspired Snapshot Contract

**Status:** PROPOSED  
**Phase:** after VIC-FIX  
**Applies first to:** TypeScript headless core  
**Applies later to:** Rust native core  
**Depends on:** stable VIC-II state model, deterministic run control,
1541/VIA/IEC snapshot completeness

## Goal

Define the C64RE machine snapshot contract using VICE `.vsf` as the
reference architecture, without requiring C64RE snapshots to be VICE
snapshot files.

The goal is a complete, versioned, binary snapshot format that supports:

- deterministic save and restore
- rewind keyframes
- branch/fork execution after restore
- DuckDB-backed timeline persistence
- VICE comparison at module and state-field granularity
- future reuse by both the TypeScript and Rust emulator cores

## Non-Goal

This spec does not implement rewind itself. Rewind is built from:

1. keyframe snapshots
2. deterministic forward replay from a keyframe
3. event/chunk indices for query and navigation

This spec only defines the keyframe snapshot layer.

## What VICE `.vsf` Is

VICE `.vsf` is a complete machine-state snapshot file.

It is a binary container with:

- a fixed file header
- a machine identifier
- a VICE version marker
- a sequence of named, versioned modules
- little-endian primitive values
- explicit byte-array payloads
- module-local compatibility versions

The relevant implementation is in the local VICE tree:

- `vice/src/snapshot.c`
- `vice/src/snapshot.h`
- `vice/src/c64/c64-snapshot.c`
- `vice/src/c64/c64memsnapshot.c`
- `vice/src/mainc64cpu.c`
- `vice/src/drive/drive-snapshot.c`
- `vice/src/drive/drivecpu.c`
- `vice/src/core/ciacore.c`
- `vice/src/core/viacore.c`
- `vice/src/vicii/vicii-snapshot.c`

### VSF Container Shape

The file begins with:

```text
magic                19 bytes   "VICE Snapshot File\\x1a"
snapshot_major        1 byte
snapshot_minor        1 byte
machine_name         16 bytes
version_magic        13 bytes   "VICE Version\\x1a"
vice_version          4 bytes
vice_revision         4 bytes   little-endian
modules              repeated until EOF
```

Each module begins with:

```text
module_name          16 bytes   NUL-padded ASCII
module_major          1 byte
module_minor          1 byte
module_size           4 bytes   little-endian, includes module header
module_payload        variable
```

VICE writes the module header with size `0`, writes the payload, and
backpatches `module_size` when the module closes. When loading, VICE
scans modules by name and uses the size field to skip unknown or
unwanted modules.

### VSF Is Module-Oriented

For C64, VICE writes the top-level snapshot through
`c64_snapshot_write(...)`.

The C64 save flow is:

1. create snapshot container
2. prepare sound
3. execute all drive CPUs up to `maincpu_clk`
4. write CPU module
5. write C64 memory/PLA/cartridge modules
6. write CIA1 and CIA2 modules
7. write SID module
8. write drive modules
9. write virtual filesystem drive module
10. write VIC-II module
11. write glue logic module
12. write event module
13. write tape, keyboard, joystick, and userport modules
14. close snapshot

The important architectural point is step 3: VICE synchronizes drive
CPUs before taking the snapshot. A C64RE snapshot must have the same
kind of boundary rule. A snapshot taken while the C64 CPU and 1541 CPU
are at unresolved clocks is not a valid deterministic keyframe.

### VSF Captures Hidden State

VICE modules do not only save user-visible registers.

They save hidden and timing state such as:

- CPU clock
- last opcode metadata
- jammed CPU state
- BA/bus state
- interrupt controller state
- CIA/VIA timer current values
- CIA/VIA latch values
- pending alarm offsets
- serial shift state
- TOD latch state
- VIC raster line and raster cycle
- VIC badline and fetch state
- VIC sprite DMA state
- color RAM
- drive clock
- drive CPU registers
- drive interrupt state
- drive RAM
- GCR head offset
- rotation state
- byte-ready state
- halftrack/head position
- disk image state when requested
- cartridge mapper state

For C64RE this is the main lesson: snapshot fidelity is mostly about
capturing internal chip state and pending scheduled work, not about
dumping RAM.

## What `.vsf` Is Not

VICE `.vsf` is not:

- a timeline database
- an event stream
- a trace format
- a reverse-execution log
- a diff format
- a stable cross-emulator interchange contract
- a good LLM-facing data format
- a DuckDB schema
- a replacement for C64RE event chunks

A `.vsf` file answers: "What was the complete emulator state at this
moment?"

It does not answer efficiently:

- "Which RAM writes happened between cycle X and Y?"
- "When did IEC DATA fall before this loader transition?"
- "Which instruction caused this screen change?"
- "Which state fields changed between two branches?"
- "Can I scrub this run like a video?"

C64RE must therefore treat snapshots as keyframes and keep separate
event/timeline structures for navigation and analysis.

## C64RE Snapshot Format

C64RE must not depend on VSF as its internal snapshot format.

Instead, define a C64RE-native binary snapshot container with the same
principles:

- fixed magic
- schema version
- machine/profile metadata
- named modules
- per-module versioning
- payload size
- little-endian primitive encoding
- optional compression at the outer snapshot-blob level
- strict save/restore boundary rules

### Container Header

```text
magic                 8 bytes   "C64RESNP"
container_major       u16
container_minor       u16
flags                 u32
machine_kind          u16      C64, C128 later if needed
video_standard        u16      PAL, NTSC
snapshot_cycle        u64      C64 master CPU cycle
snapshot_frame        u64
module_count          u32
header_size           u32
metadata_size         u32
metadata_json         bytes    UTF-8 JSON, bounded
module_table          repeated module descriptors
module_payloads       bytes
```

`metadata_json` is for descriptive metadata only. It must not contain
authoritative machine state.

Examples:

```json
{
  "run_id": "run_2026_05_11_001",
  "branch_id": "main",
  "backend": "typescript",
  "core_version": "headless-ts-v2",
  "media": ["game.d64"],
  "created_by": "SnapshotRingBuffer",
  "reason": "rewind_keyframe"
}
```

### Module Descriptor

```text
module_name          16 bytes   NUL-padded ASCII
module_major          u16
module_minor          u16
module_flags          u32
payload_offset        u64      absolute offset in container
payload_size          u64
payload_hash          32 bytes BLAKE3 or zero when disabled
```

Module payloads are not self-describing. The module version defines the
field order exactly.

The loader must reject duplicate module names unless a module explicitly
declares indexed multiplicity, for example `CARTBANK` or `DRIVE8`.

## Required Modules for C64 + 1541

The first complete post-VIC-FIX snapshot must include these modules.

### META

Purpose: machine profile and reset/runtime mode.

Fields:

- machine model
- PAL/NTSC
- reset profile
- kernal profile
- truedrive enabled
- cartridge enabled
- tape enabled
- input profile
- emulator backend
- feature flags

### MAINCPU

Purpose: C64 6510 execution state.

Fields:

- main CPU cycle
- A, X, Y
- SP
- PC
- status register
- last opcode metadata
- jammed/halted state
- pending IRQ state
- pending NMI state
- IRQ/NMI line levels
- interrupt delay state
- bus/BA wait state if modeled
- current instruction boundary marker

Snapshot boundary rule:

- v1 snapshots are valid only at an instruction boundary unless the VIC
  fix explicitly makes mid-instruction bus state serializable.

### C64MEM

Purpose: C64 memory and PLA-visible state.

Fields:

- 64 KB RAM
- color RAM
- CPU port data
- CPU port direction
- CPU port output/readback/falloff state
- GAME line
- EXROM line
- current memory configuration
- ROM profile references or embedded ROM hash
- optional embedded ROM bytes if non-standard ROMs are active

### CART

Purpose: cartridge runtime state.

Fields:

- CRT type
- mapper id
- attached cartridge hash/path reference
- active bank numbers
- RAM/flash contents for writable carts
- freeze/NMI state
- GAME/EXROM contribution
- mapper-specific registers

Rule:

- every supported mapper must own a versioned submodule or typed payload
  inside `CART`; generic "current bank only" state is not enough.

### VICII

Purpose: VIC-II rendering, raster, IRQ, DMA, and hidden pipeline state.

Fields:

- raster line
- raster cycle
- VIC register file
- IRQ status and mask
- badline state
- allow-bad-lines state
- display enable timing state
- idle/display state
- memory counters
- video matrix buffer
- color buffer
- sprite DMA mask
- sprite expansion flip-flops
- sprite memory pointers
- sprite collision latches
- fetch event state
- border/background pipeline state
- framebuffer cache policy marker

Rule:

- this module is blocked until after the VIC-FIX because the snapshot
  must represent the real renderer/bus state, not an approximate screen
  dump.

### CIA1 and CIA2

Purpose: CIA timers, TOD, ports, serial, and interrupt state.

Fields per CIA:

- PRA/PRB
- DDRA/DDRB
- timer A current value
- timer B current value
- timer A latch
- timer B latch
- CRA/CRB
- ICR/IER
- IRQ output state
- TOD current state
- TOD latch state
- TOD alarm
- serial data register
- serial shift state
- pending serial alarm offset
- pending timer alarm offsets
- port readback/output state
- keyboard/joystick port integration state where applicable

Rule:

- pending alarm times must be stored relative to snapshot cycle, not as
  stale absolute JavaScript timer handles or closure state.

### SID

Purpose: software-visible SID state.

Required v1 fields:

- SID register file
- bus readback/open-bus state if modeled
- voice envelope visible state if modeled
- filter registers
- pot input state

Deferred:

- sample-exact audio phase is not required for first rewind keyframes
  unless audio rewind is enabled.

### IECBUS

Purpose: resolved IEC bus line state.

Fields:

- host ATN/DATA/CLOCK output intentions
- drive ATN/DATA/CLOCK output intentions
- resolved ATN/DATA/CLOCK levels
- cached port states used by CIA/VIA integration
- last edge cycle per line
- current talk/listen role if represented by runtime state

Rule:

- save both intentions and resolved lines. Resolved lines alone are not
  enough to resume correctly after restore.

### DRIVE8

Purpose: 1541 mechanical/GCR/media state.

Fields:

- drive enabled/type
- drive CPU clock
- true-drive enabled
- current halftrack
- head side
- motor state
- LED state if modeled
- write-protect state
- GCR head offset
- GCR read latch
- GCR write latch
- byte-ready level
- byte-ready edge/active state
- rotation accumulator/counters
- speed zone
- SYNC detection state
- last read/write data
- disk image identity
- mutable disk overlay state

Rule:

- if the disk has been modified since mount, either embed the modified
  media state or reference a content-addressed overlay stored with the
  run. A snapshot must never depend on an external mutable `.d64` path
  alone.

### DRIVECPU8

Purpose: 1541 6502 execution state.

Fields:

- drive CPU cycle
- A, X, Y
- SP
- PC
- status register
- last opcode metadata
- jammed/halted state
- interrupt state
- drive RAM
- CPU last data/open-bus state if modeled

### VIA1D1541 and VIA2D1541

Purpose: 1541 VIA state.

Fields per VIA:

- PRA/PRB
- DDRA/DDRB
- T1 current value
- T1 latch
- T2 current value
- T2 latch
- SR
- ACR
- PCR
- IFR
- IER
- CA1/CA2 state
- CB1/CB2 state
- shift state
- pending T1/T2 alarm offsets
- port output/readback integration state

### INPUT

Purpose: deterministic external input state.

Fields:

- keyboard matrix
- joystick states
- pending key events if the runtime queues input
- input macro position if active

### SCHED

Purpose: deterministic runtime scheduler state.

Fields:

- global cycle
- frame counter
- pending alarm queue entries
- alarm owner/module id
- alarm relative due cycle
- deterministic tie-break order
- run mode flags

Rule:

- any delayed behavior implemented outside chip modules must appear here
  or inside the owning module. Hidden closures are forbidden for
  snapshot-restorable behavior.

## Save Contract

The runtime must expose:

```ts
type SnapshotReason =
  | "manual"
  | "rewind_keyframe"
  | "branch_base"
  | "test_fixture"
  | "pre_patch";

interface SaveSnapshotOptions {
  reason: SnapshotReason;
  includeMedia?: "reference" | "overlay" | "embedded";
  includeRoms?: "hash" | "embedded";
  compression?: "none" | "zstd";
  validateHash?: boolean;
}

interface MachineSnapshotBlob {
  schema: "c64re.snapshot";
  major: number;
  minor: number;
  cycle: bigint;
  frame: bigint;
  byteLength: number;
  compression: "none" | "zstd";
  hash: string;
  bytes: Uint8Array;
}
```

Before saving:

1. finish the current instruction or enter an explicitly supported
   mid-instruction snapshot mode
2. run pending chip alarms due at or before the snapshot cycle
3. synchronize the 1541 CPU to the C64 snapshot boundary
4. flush GCR/media writeback state into snapshot-visible media state
5. freeze input queues at a deterministic boundary
6. write modules in canonical order
7. compute module hashes when enabled
8. compute container hash

Canonical module order:

```text
META
MAINCPU
C64MEM
CART
VICII
CIA1
CIA2
SID
IECBUS
DRIVE8
DRIVECPU8
VIA1D1541
VIA2D1541
INPUT
SCHED
```

The writer may omit optional modules only if `META.feature_flags`
declares the omission and the loader can restore a valid equivalent
state. Required modules may not be omitted.

## Load Contract

The runtime must expose:

```ts
interface LoadSnapshotOptions {
  allowOlderMinor?: boolean;
  requireHash?: boolean;
  branchId?: string;
  mode?: "replace_session" | "fork_branch";
}

interface LoadSnapshotResult {
  cycle: bigint;
  frame: bigint;
  branchId: string;
  modulesLoaded: string[];
  warnings: string[];
}
```

When loading:

1. validate magic and container version
2. validate machine kind and video standard
3. build module table
4. reject duplicate unexpected modules
5. validate required module presence
6. validate module versions
7. validate hashes if requested
8. reset runtime to a blank deterministic baseline
9. load modules in canonical dependency order
10. rebuild derived lookup tables from authoritative state
11. reattach media from embedded bytes, content-addressed overlay, or
    immutable media reference
12. restore pending alarms from relative cycle offsets
13. restore CPU clocks and global cycle
14. run no emulated cycles during restore unless an explicit module
    post-load hook requires deterministic normalization
15. verify post-load invariant hash when enabled

Loading a snapshot must not:

- call power-on reset after module load
- silently reinitialize CIA/VIA timers
- silently remount mutable disk paths
- discard cartridge mapper state
- infer drive/VIA/IEC intentions from resolved bus lines only
- advance emulation as a side effect of readback APIs

## DuckDB Storage

C64RE should store snapshots as compressed BLOBs by default.

```sql
CREATE TABLE snapshot_keyframes (
  run_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  cycle UBIGINT NOT NULL,
  frame UBIGINT NOT NULL,
  backend TEXT NOT NULL,
  schema_major UINTEGER NOT NULL,
  schema_minor UINTEGER NOT NULL,
  compression TEXT NOT NULL,
  byte_size UINTEGER NOT NULL,
  uncompressed_byte_size UINTEGER NOT NULL,
  hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  snapshot BLOB NOT NULL,
  PRIMARY KEY (run_id, branch_id, snapshot_id)
);
```

Optional module index:

```sql
CREATE TABLE snapshot_modules (
  run_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  module_major UINTEGER NOT NULL,
  module_minor UINTEGER NOT NULL,
  payload_size UINTEGER NOT NULL,
  payload_hash TEXT,
  PRIMARY KEY (run_id, branch_id, snapshot_id, module_name)
);
```

DuckDB owns discovery and retention metadata. The snapshot BLOB remains
the authoritative keyframe payload.

## Ring Buffer Storage

Live rewind should use an in-memory bounded ring first.

```text
SnapshotRingBuffer
  capacity_bytes
  capacity_seconds
  keyframe_interval_cycles
  entries[]
```

Each entry contains:

- cycle
- frame
- branch id
- snapshot hash
- compressed snapshot bytes
- rough byte cost
- retention pin flag

Eviction policy:

1. never evict pinned snapshots
2. prefer old snapshots from abandoned branches
3. preserve at least one keyframe before every retained event window
4. preserve the newest snapshot for each live branch

DuckDB persistence is a promotion step:

```text
ring keyframe -> DuckDB snapshot_keyframes row
```

It must not block the hot emulation path.

## VICE Interop

C64RE does not need to read or write `.vsf` for its own rewind system.

Supported VICE interop after this spec:

- ask VICE Binary Monitor to dump `.vsf`
- ask VICE Binary Monitor to undump `.vsf`
- store `.vsf` as an external oracle artifact
- parse enough `.vsf` module headers to list modules and versions
- compare C64RE module hashes/fields against VICE-derived normalized
  state where practical

Unsupported unless explicitly added later:

- loading VICE `.vsf` directly into the TS core
- writing a `.vsf` that VICE can load
- treating `.vsf` as the C64RE persistent timeline format

Reason:

`.vsf` is GPL VICE implementation detail and not a stable neutral
contract. C64RE should learn from the architecture, not couple its
runtime to it.

## Acceptance

This spec is done when, after the VIC-FIX:

- `MachineKernel.snapshotBinary()` returns a C64RE snapshot BLOB with
  all required modules.
- `MachineKernel.restoreBinary(blob)` restores the same state.
- Snapshot roundtrip test passes:
  snapshot A -> run N cycles -> restore A -> snapshot B -> A hash equals
  B hash, excluding declared volatile metadata.
- Replay determinism test passes:
  snapshot A -> run N cycles -> hash C; restore A -> run N cycles ->
  hash C again.
- Drive sync test passes:
  snapshot during active IEC/1541 run -> restore -> next 10,000 cycles
  produce the same CPU, drive CPU, VIA, and IEC trace hashes.
- VIC test passes:
  snapshot mid-frame at an allowed boundary -> restore -> next frame
  framebuffer hash matches.
- Cartridge test passes for at least one bank-switching CRT.
- Mutable disk overlay test passes for a write-enabled D64 session.
- DuckDB can store and load snapshot BLOBs without filesystem sidecar
  files.
- VICE wrapper can dump/undump `.vsf` as oracle artifacts, but C64RE
  rewind does not depend on `.vsf`.

## Implementation Notes

- Start with binary `Uint8Array` writers/readers, not JSON.
- Keep module encoders small and local to owning subsystems.
- Use exact integer widths in writer helpers.
- Avoid JavaScript object graphs in the hot save path.
- Keep `snapshotToDebugJson()` as a diagnostic projection, not the
  storage format.
- Add a field-level dump tool for one module at a time; full snapshots
  are for machines, not LLM context.
- Every module must define an explicit `stableHash()` projection so
  volatile metadata never poisons determinism tests.

## Open Questions

- Compression: use zstd immediately, or start uncompressed in ringbuffer
  and compress only for DuckDB promotion?
- Hashing: BLAKE3 preferred, but decide based on available dependency
  footprint.
- Mid-instruction snapshots: forbid in v1, or support only after
  CPU/VIC bus-stealing state is complete?
- Audio rewind: should SID phase/audio buffers be part of v1, or a
  separate audio-cache layer?
- Media overlays: store as a snapshot module, DuckDB BLOB, or
  content-addressed artifact referenced by snapshot metadata?
