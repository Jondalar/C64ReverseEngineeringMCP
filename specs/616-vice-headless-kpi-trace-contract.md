# Spec 616 — VICE / Headless KPI Trace Contract

**Status:** DRAFT (2026-05-16)  
**Scope:** Diagnostic trace contract only. No runtime implementation in
this spec.  
**Related:** Spec 600/601 runtime proof gates, Spec 610/611 VICE1541
side-by-side rebuild, Spec 217 DuckDB trace store, Spec 234
transaction swimlane, Spec 427/429 IEC divergence work.

## Problem

Full VICE/headless traces are too large for routine debugging. A
120-second boot can produce many gigabytes when every CPU instruction,
register set, chip event, and bus access is logged as text.

That is useful as a last resort, but it is the wrong default. For
1541/C64 parity work we usually need to know **which boundary diverged
first**, not every internal instruction.

This spec defines compact **KPI traces**: small, stable, comparable
signals emitted by both VICE capture tooling and Headless runtime
capture tooling. They are designed for:

- first-divergence search,
- DuckDB import,
- LLM-readable summaries,
- transaction swimlanes,
- focused zoom into full traces only after a KPI mismatch is found.

## Goals

1. Define one shared schema for VICE and Headless KPI captures.
2. Capture the C64/IEC/1541 boundaries that matter for custom loaders:
   `$DD00`, IEC lines, VIA1 `$1800/$1801`, VIA2 `$1C00/$1C01`,
   BYTE-READY/SO, head position, track/sector/header/data decode.
3. Keep routine captures small enough for multi-minute game boots.
4. Make first-divergence queries trivial in DuckDB.
5. Feed the trace UI / swimlane view with meaningful transaction rows.

## Non-Goals

- No replacement for Runtime Proof Gates. Spec 600/601 remain the
  acceptance source of truth.
- No full CPU history by default.
- No per-cycle text trace by default.
- No runtime fix, 1541 implementation work, or VICE1541 porting work in
  this spec.
- No VICE source patching as a required workflow. VICE instrumentation
  may be used when available, but the contract must also support
  binmon/post-processing sources.

## Capture Principle

KPI traces capture **boundary transactions**, not every cycle.

Record an event when one of these changes or is accessed:

- C64 `$DD00/$DD02` read/write or effective IEC output changes.
- Combined IEC ATN/CLK/DATA changes.
- Drive VIA1 `$1800/$1801/$1802/$1803` read/write or CA1 IRQ edge.
- Drive VIA2 `$1C00/$1C01/$1C02/$1C03` read/write or BYTE-READY/SO edge.
- Drive head/motor/density/write-protect changes.
- Disk sync/header/data-block decode occurs.
- KERNAL or fastloader phase marker is reached.

Do **not** emit rows just because a CPU instruction executed.

## Global Event Envelope

Every KPI event uses this envelope. Channel-specific payload goes into
typed columns first; `extra_json` is only for rare, versioned additions.

```ts
interface KpiEventBase {
  run_id: string;
  source: "vice" | "headless";
  scenario: string;
  seq: number;
  master_clock: number;
  c64_clock: number | null;
  drive_clock: number | null;
  side: "c64" | "drive" | "bus" | "disk" | "derived";
  channel: KpiChannel;
  kind: string;
  pc: number | null;
  addr: number | null;
  value: number | null;
  note: string | null;
  extra_json?: string;
}
```

Clock rules:

- `master_clock` is the comparison clock. For C64-side events it equals
  C64 clock. For drive-side events it is drive clock mapped to C64 time
  with the run's stored ratio and offset.
- Each run stores `drive_to_c64_ratio` and `drive_to_c64_offset`.
- `seq` is monotonic within a run and breaks ties for same-clock events.

## Channels

### 1. `c64_iec`

Purpose: what the C64 asks the serial bus to do.

Emit on:

- `$DD00` read/write,
- `$DD02` DDR write,
- effective C64 ATN/CLK/DATA output change,
- CIA2 PA value used by serial code.

Typed payload:

| Column | Meaning |
|--------|---------|
| `pc` | C64 PC at access |
| `addr` | `$DD00` or `$DD02` |
| `value` | read/written byte |
| `ddr` | CIA2 PA DDR |
| `pa_or` | CIA2 PA output register |
| `atn` / `clk` / `data` | effective line state, `1` released, `0` pulled low |
| `rw` | `read` / `write` |

Example:

```json
{"channel":"c64_iec","kind":"dd00_write","side":"c64","pc":62421,"addr":56576,"value":23,"ddr":63,"atn":0,"clk":1,"data":1}
```

### 2. `iec_bus`

Purpose: shared bus truth after wired-OR combination.

Emit on:

- ATN/CLK/DATA combined line transition,
- C64 pull transition,
- drive pull transition,
- ATNA transition.

Typed payload:

| Column | Meaning |
|--------|---------|
| `atn` / `clk` / `data` | combined bus state, `1` released |
| `c64_atn_pull` / `c64_clk_pull` / `c64_data_pull` | active-low pulls |
| `drv_clk_pull` / `drv_data_pull` / `drv_atna_pull` | drive-side pulls |
| `edge` | changed line name |

This is the most important channel for answering: “Did the C64 or the
drive see the IEC transition first?”

### 3. `drive_via1`

Purpose: 1541 IEC-side VIA behavior.

Emit on:

- `$1800` PRB read/write,
- `$1801` PRA read/write,
- `$1802/$1803` DDR read/write,
- PCR writes affecting CA1,
- CA1 edge,
- VIA1 IRQ assert/ack.

Typed payload:

| Column | Meaning |
|--------|---------|
| `pc` | drive PC at access |
| `addr` | `$1800-$180f` mirrored register |
| `value` | CPU-visible value |
| `or_value` | VIA output register latch |
| `ddr` | VIA DDR |
| `pins` | final pin value after DDR/input merge |
| `ifr` / `ier` | interrupt flags/enables |
| `ca1` | CA1 pin level |
| `irq` | VIA IRQ line level |
| `rw` | `read` / `write` |

Important addresses:

- `$1800`: VIA1 PRB, IEC port.
- `$1801`: VIA1 PRA, parallel cable/open-bus path.
- `$180c`: PCR, CA1 edge control.
- `$180d/$180e`: IFR/IER.

### 4. `drive_via2`

Purpose: 1541 disk-controller VIA behavior.

Emit on:

- `$1C00` PRA read/write: GCR byte bus,
- `$1C01` PRB read/write: SYNC/WP/motor/stepper/density,
- `$1C02/$1C03` DDR read/write,
- PCR writes affecting BYTE-READY,
- BYTE-READY edge,
- SO/V flag edge into drive CPU,
- VIA2 IRQ assert/ack.

Typed payload:

| Column | Meaning |
|--------|---------|
| `pc` | drive PC at access |
| `addr` | `$1c00-$1c0f` mirrored register |
| `value` | CPU-visible value |
| `or_value` | VIA output register latch |
| `ddr` | VIA DDR |
| `pins` | final pin value after DDR/input merge |
| `gcr_byte` | current/latching GCR byte when known |
| `sync` | SYNC line, `1` no sync, `0` sync active |
| `wp` | write-protect sense |
| `byte_ready` | BYTE-READY level/edge |
| `so` | drive CPU SO/V line level |
| `motor` | motor on/off |
| `stepper` | stepper phase bits |
| `density` | density zone |
| `rw` | `read` / `write` |

### 5. `disk_position`

Purpose: where the drive thinks it is on disk.

Emit on:

- motor on/off,
- head halftrack change,
- density zone change,
- sync found/lost,
- sector header decode,
- sector data block decode,
- checksum result.

Typed payload:

| Column | Meaning |
|--------|---------|
| `halftrack` | 1-based or VICE-equivalent halftrack coordinate |
| `track` | decoded track where known |
| `sector` | decoded sector where known |
| `zone` | density zone |
| `sync` | sync found/lost |
| `header_track` / `header_sector` | decoded header |
| `header_id1` / `header_id2` | disk id bytes |
| `checksum_ok` | header/data checksum result |
| `block` | `header` / `data` / `gap` |

This channel is the normal answer to: “Are we on the same track/sector
as VICE?”

### 6. `load_markers`

Purpose: coarse progress markers across KERNAL and common loader paths.

Emit on:

- C64 KERNAL serial routine entry/exit,
- drive DOS command parser entry,
- filename parsed,
- file open/listen/secondary/unlisten,
- load start/end,
- bytes loaded rollup,
- first custom fastloader handoff.

Typed payload:

| Column | Meaning |
|--------|---------|
| `phase` | `open`, `listen`, `second`, `ciout`, `acptr`, `unlisten`, `kernal_load`, `fastloader_handoff`, etc. |
| `filename` | normalized filename if known |
| `device` | IEC device number |
| `secondary` | secondary address |
| `load_addr` | current/initial load address |
| `bytes_loaded` | cumulative bytes |
| `last_byte` | last byte transferred |

### 7. `derived_first_divergence`

Purpose: output from a comparer, not a runtime emitter.

One row per comparison verdict:

| Column | Meaning |
|--------|---------|
| `compare_id` | VICE vs Headless pair |
| `channel` | channel that diverged |
| `master_clock` | first mismatching clock |
| `vice_seq` / `headless_seq` | row ids |
| `field` | mismatching field |
| `vice_value` / `headless_value` | values |
| `classification` | `missing_event`, `extra_event`, `value_mismatch`, `timing_delta`, `phase_mismatch` |
| `window_before` / `window_after` | suggested zoom window |

## Minimum DuckDB Tables

Implementers may store channel-specific columns in separate tables, but
the following logical tables are required:

```sql
CREATE TABLE kpi_events (
  run_id TEXT,
  source TEXT,
  scenario TEXT,
  seq BIGINT,
  master_clock BIGINT,
  c64_clock BIGINT,
  drive_clock BIGINT,
  side TEXT,
  channel TEXT,
  kind TEXT,
  pc INTEGER,
  addr INTEGER,
  value INTEGER,
  note TEXT,
  extra_json JSON
);

CREATE TABLE kpi_iec (
  run_id TEXT,
  seq BIGINT,
  atn INTEGER,
  clk INTEGER,
  data INTEGER,
  c64_atn_pull INTEGER,
  c64_clk_pull INTEGER,
  c64_data_pull INTEGER,
  drv_clk_pull INTEGER,
  drv_data_pull INTEGER,
  drv_atna_pull INTEGER,
  edge TEXT
);

CREATE TABLE kpi_via (
  run_id TEXT,
  seq BIGINT,
  chip TEXT,
  reg TEXT,
  rw TEXT,
  or_value INTEGER,
  ddr INTEGER,
  pins INTEGER,
  ifr INTEGER,
  ier INTEGER,
  ca1 INTEGER,
  irq INTEGER
);

CREATE TABLE kpi_disk (
  run_id TEXT,
  seq BIGINT,
  halftrack DOUBLE,
  track INTEGER,
  sector INTEGER,
  zone INTEGER,
  block TEXT,
  sync INTEGER,
  checksum_ok INTEGER
);

CREATE TABLE kpi_first_divergence (
  compare_id TEXT,
  channel TEXT,
  master_clock BIGINT,
  vice_seq BIGINT,
  headless_seq BIGINT,
  field TEXT,
  vice_value TEXT,
  headless_value TEXT,
  classification TEXT,
  window_before BIGINT,
  window_after BIGINT
);
```

## Comparer Rules

The KPI comparer aligns by:

1. scenario id,
2. channel,
3. ordered event key,
4. master clock tolerance where explicitly allowed.

Default tolerance:

- `$DD00`, VIA register read/write: exact event order, exact value.
- IEC transitions: exact order, `±1 C64 cycle` configurable tolerance.
- BYTE-READY/SO: exact drive event order, `±1 drive cycle` configurable
  tolerance while porting; final tolerance should be zero unless VICE
  capture source cannot provide exact cycle.
- disk position/header/data decode: exact order and values.

The comparer must report the **first** mismatch, then emit a suggested
zoom window. It must not dump the whole trace by default.

## Existing Trace Inventory (2026-05-16)

This spec does **not** start from an empty repository. Existing trace
stores and scripts already cover large parts of the Headless side. The
missing part is a clean, repeatable VICE KPI capture that produces the
same boundary channels.

### Reusable infrastructure

| Asset | Reuse |
|-------|-------|
| `scripts/trace-store-query.mjs` | Query existing DuckDB trace stores (`info`, `bus-find`, `sql`, anchors). Keep and extend if needed. |
| `scripts/trace-store-iec-line-diff.mjs` | Already replays C64 `$DD00` writes and drive `$1800` writes through `IecBusCore` to compare IEC line-state timelines. Useful as a model for KPI line-state derivation. |
| DuckDB trace schema v2 | Existing tables `instructions`, `bus_events`, `chip_events`, `anchors`, `rollups` are good enough for Headless KPI extraction. Do not replace them for the first spike. |
| Old MotM JSONL probes under `traces/probe_motm_*` | Historical reference only. They prove that VICE `$DD00/$1800` probe capture was possible, but they are not the new standard oracle format. |

### Existing Headless DuckDB coverage

These stores already contain the boundary events this spec cares about:

| Store | Coverage observed |
|-------|-------------------|
| `samples/traces/v2-baseline/im2-headless-store-2026-05-12/trace.duckdb` | `instructions=20,813,372`, `bus_events=3,763,866`, `chip_events=880,778`; includes `$DD00` and drive `$1800`. |
| `samples/traces/v2-baseline/lnr-headless-micro-headless-store-2026-05-12/trace.duckdb` | `bus_events=13,652,597`, `chip_events=13,678,330`; includes millions of `$DD00/$1800` events. |
| `samples/traces/v2-baseline/perf441-headless-store-2026-05-14/trace.duckdb` | MotM/perf-style Headless store with `$DD00`, `$1800`, GCR `byte_ready`, `sync_edge`, VIA IRQ events. |
| `samples/traces/spec-430/{motm,mm-s1,im2,scramble,lnr-s1}/headless-3155b795be/trace.duckdb` | Later Headless regression stores for the main game corpus; usable for Headless-side KPI extraction. |

Observed example counts:

| Store | `$DD00` C64 reads | `$DD00` C64 writes | `$1800` drive reads | `$1800` drive writes |
|-------|------------------:|-------------------:|--------------------:|---------------------:|
| `im2-headless-store-2026-05-12` | 1,476,619 | 8,616 | 1,922,080 | 199,984 |
| `lnr-headless-micro-headless-store-2026-05-12` | 8,793,375 | 102,952 | 2,438,874 | 1,226,825 |
| `perf441-headless-store-2026-05-14` | 581,827 | 3,338 | 87,445 | 44,063 |

Headless `chip_events` already include useful GCR/VIA markers such as
`byte_ready`, `sync_edge`, `head_step`, `density`, `motor`,
`irq_assert`, and `irq_clear`. First implementation work should reuse
these stores to validate KPI queries before adding new emitters.

### Existing VICE DuckDB limitation

The existing VICE DuckDB stores are useful for CPU/PC history, but they
do **not** contain the boundary KPI channels needed here:

| Store | Finding |
|-------|---------|
| `samples/traces/v2-baseline/im2-vice-store-2026-05-12/trace.duckdb` | `instructions=92,595,300`, but `bus_events=0`, `chip_events=0`. |
| `samples/traces/v2-baseline/lnr-vice-fulltrace-vice-store-2026-05-12/trace.duckdb` | `instructions=138,672,060`, but `bus_events=0`, `chip_events=0`. |
| `samples/traces/v2-baseline/lnr-vice-game-2026-05-13/trace.duckdb` | VICE CPU-history store; `bus_events=0`, `chip_events=0`. |

The summary files explicitly describe these VICE stores as binmon /
cpuhistory captures where bus watches were sampled only opportunistically
or not imported into `bus_events`, and VICE `chip_events` were deferred.

### Existing VICE JSONL references

MotM has old VICE JSONL probes with the right kinds of rows:

| File | Observed content |
|------|------------------|
| `traces/probe_motm_2026-05-06T17-18-32-223Z/vice.jsonl` | 1,000 rows; 711 `$DD00`, 290 `$1800`, IEC state present, partial VIA state present. |
| `traces/swimlane_motm_2026-05-06T13-18-48-312Z/vice.jsonl` | 1,000 rows; `$DD00`, `$1800`, `$1C00`, IEC, VIA, C64 and drive register snapshots. |
| `samples/analysis/runtime/ab-vice-step-2026-05-08T0848/vice-step.jsonl` | Step-style AB-fastloader probe with C64/drive CPU state and `$DD00/$1800` mentions. |

Use these only as examples for event shape and expected diagnostic
value. They are too ad-hoc to become the new oracle basis.

### Inventory conclusion

1. **Do not rebuild Headless trace storage first.** Existing DuckDB
   stores and query scripts are sufficient for the first KPI spike.
2. **Do build a VICE KPI capture/import spike.** Current VICE DuckDBs
   lack `bus_events` and `chip_events`, so they cannot answer `$DD00` /
   `$1800` / VIA / GCR parity questions by themselves.
3. **Do not use full traces as the default.** The first VICE KPI spike
   should emit only boundary events and row-count summaries.
4. **Use MotM as the first spike target.** Existing MotM JSONL probes
   provide historical examples, while the new output must be DuckDB or
   KPI JSONL following this spec.

## Standard Scenarios

### Spike A — one-game VICE oracle capture

First implementation work after this spec is a **single-game spike**,
not the full matrix. The spike proves that VICE can be launched,
driven, observed, and reduced into KPI rows with predictable size.

Recommended first target:

| Candidate | Why |
|-----------|-----|
| `motm_g64_boot_to_fastloader` | Exercises normal KERNAL load, G64 track/sector behavior, and oldschool `$DD00` fastloader handoff. Good first oracle because it spans both categories without requiring LNR-level tight timing first. |

Fallback target:

| Candidate | Why |
|-----------|-----|
| `mm_s1_kernal_load_to_menu` | Cleaner oldschool KERNAL-load + later game path. Useful if MotM capture setup is blocked by media naming or run duration. |

Spike must define, in executable form:

- exact VICE binary path/config lookup,
- exact VICE launch command,
- no warp for oracle capture unless a later spec explicitly allows it,
- monitor/binmon startup mode,
- how commands are injected (`LOAD"*",8,1`, `RUN`, optional key input),
- media attach syntax,
- capture duration as a parameter (`--seconds N`, default 120),
- output path convention,
- scenario metadata file with media hash, VICE version, ROM hashes, and
  command sequence,
- KPI JSONL or DuckDB output,
- compact summary with row counts per channel and first/last marker.

VICE launch requirements:

- PAL C64 unless scenario says otherwise.
- True drive emulation enabled.
- No warp during oracle capture.
- Deterministic input timing: commands and key presses use explicit
  cycle/time offsets.
- VICE version recorded from the binary, not assumed.
- If binmon/cpuhistory cannot expose a KPI, mark the field unavailable
  in `capture_capability`; do not synthesize it.

The spike is DONE only when it produces:

1. one raw VICE capture artifact,
2. one reduced KPI artifact,
3. one summary markdown,
4. one importable DuckDB file or JSONL file,
5. one first-divergence-compatible event ordering, even if no Headless
   comparison is run yet.

Initial required KPI scenarios:

| Scenario | Purpose |
|----------|---------|
| `bare_boot_no_disk_5s` | drive reset, no media, IEC idle, DOS idle |
| `kernal_load_directory_d64` | `$DD00` + VIA1 + directory transfer |
| `mm_s1_kernal_load_to_menu` | oldschool KERNAL load + menu reachability |
| `motm_g64_boot_to_fastloader` | G64, head/sector, fastloader handoff |
| `scramble_krill_loader_start` | KRILL loader handoff, SPACE/fire scenario later |
| `lnr_s1_load_failure_window` | known failing baseline, used after VICE1541 matures |
| `pawn_load_wildcard_failure_window` | known failing wildcard LOAD baseline |

Scenario definitions must include:

- media path/hash,
- command sequence (`LOAD"*",8,1`, `RUN`, key presses),
- max C64 cycles / wall timeout,
- expected coarse phase,
- whether the game is expected GREEN or RED under Spec 601.

## Oracle Coverage Classes

KPI scenarios are grouped by the behavior they prove. A scenario may
belong to more than one class.

### A. KERNAL LOAD must work

Goal: prove generic Commodore serial loading and disk-directory/file
resolution against real 1541 DOS behavior.

| Class | Required scenario | Notes |
|-------|-------------------|-------|
| A.1 BAM / directory oddities | `pawn_load_wildcard_failure_window` | The Pawn currently fails on wildcard load; KPI oracle must expose filename/BAM/directory decision points instead of only final `?FILE NOT FOUND`. |
| A.2 GCR/media oddities | `motm_g64_boot_to_fastloader` | G64 track geometry, header/data sync, checksum, head stepping. |
| A.3 Generic load | `kernal_load_directory_d64`, `mm_s1_kernal_load_to_menu` | Baseline serial protocol and normal file transfer. |

### B. `$DD00` bit-banging must work

Goal: prove C64-side serial pin driving and drive-side response timing
for custom loaders.

| Class | Required scenario | Notes |
|-------|-------------------|-------|
| B.1 Modern loaders | `scramble_krill_loader_start`, `polarbear_loader_window` | KRILL/modern loaders; include key press such as SPACE/fire where the game requires it. |
| B.2 Oldschool loaders | `motm_g64_boot_to_fastloader`, `mm_s1_kernal_load_to_menu`, `im2_loader_window` | Older custom/secondary loaders, often after successful KERNAL bootstrap. |
| B.3 Tight timing windows | `lnr_s1_load_failure_window` | LNR stays a later oracle because it is timing-sensitive and currently RED in Spec 601. |

The first spike does **not** need to cover every class. It must choose
one target, document which classes it covers, and make adding the next
scenario a data/config task rather than a new tracing architecture.

## Swimlane Output

KPI traces must support a compact swimlane export:

| Cycle | C64 `$DD00` / PC | IEC Bus | Drive VIA1 | Drive VIA2 | Disk |
|-------|------------------|---------|------------|------------|------|
| 1000  | `PC=$F3D5 W $DD00=$17` | `ATN↓ DATA=1 CLK=1` | `CA1↑ IRQ` | | |
| 1020  | | `DATA↓ by drive` | `R $1800 pins=$85` | | |
| 2040  | | | | `BYTE_READY SO↑` | `sync found T18` |

Rules:

- Default window is `first_divergence ± 2000 cycles`.
- For LLM output, collapse repeated idle rows.
- Never include full register dumps unless explicitly requested.

## VICE Capture Sources

Allowed sources:

1. VICE binmon/cpuhistory post-processing.
2. VICE monitor/bus instrumentation if locally available.
3. Small VICE patch/instrumented build only when necessary.

The schema is independent of source. If a VICE source cannot provide a
field, set it to `NULL` and record `capture_capability` metadata for
the run. Do not invent values.

## Headless Capture Sources

Headless emitters should hook the existing narrow points:

- CIA2 `$DD00/$DD02` bus access path,
- IEC bus state recomputation,
- VIA1/VIA2 register read/write backends,
- byte-ready/SO edge,
- GCR/disk parser sync/header/data decode,
- KERNAL/loader marker helpers.

The capture path must be gated by explicit config and must not add
overhead to normal runtime when disabled.

## Acceptance For This Spec

This spec is DONE when:

1. The file exists as `specs/616-vice-headless-kpi-trace-contract.md`.
2. No runtime source code is changed in the same commit.
3. It is referenced from the active roadmap or from a future
   implementation spec.

Implementation is a follow-up spec. Suggested split:

- `617` Headless KPI emitters + JSONL writer.
- `618` VICE KPI capture/import.
- `619` DuckDB importer + first-divergence query.
- `620` Swimlane UI/query integration.

## DO NOT

- Do not use KPI trace green as Runtime Proof Gate green.
- Do not capture every CPU instruction by default.
- Do not write per-cycle JSONL for routine scenarios.
- Do not add fake loader markers that bypass actual runtime state.
- Do not patch VICE as the first move if binmon/post-processing can
  supply the required KPI.
- Do not mix KPI trace implementation into Spec 611 phases unless the
  user explicitly opens that follow-up work.
