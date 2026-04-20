# TODO

Backlog for the c64-re MCP. Bigger items first.

## Disk file-layer abstraction — standard + custom

**Motivation.** In the Lykia project (2026-04-20) we encountered a disk
where the BAM/DOS directory is decorative — only one "real" PRG is
visible (the loader `entrance`), but 40+ additional logical files live
in non-directoried sectors indexed by a custom LUT the drive reads
from a fixed T/S (here: T18S18). We had to add these files to the
per-disk `manifest.json` with a throw-away Python script
(`Lykia/tools/disk_manifest_merge.py`). That's downstream of what the
MCP itself should cover.

### Proposed model

Introduce a `DiskFileOrigin` field on every file descriptor in
`manifest.json`:

- `"kernal"` — discovered via the standard 1541 DOS directory chain
  starting at T18S1. Existing `extract_disk` path already handles this.
- `"custom"` — discovered via a custom directory/LUT sector (not the
  DOS dir) or direct T/S references. The MCP should accept a
  declarative description of a custom LUT, extract the files it
  indexes, and include them in the unified manifest.

Suggested file-descriptor schema (superset of what `extract_disk`
already writes):

```ts
interface DiskFileEntry {
  index: number;
  origin: "kernal" | "custom";
  name: string;
  type: "PRG" | "SEQ" | ...;   // "BIN" for origin=custom when unknown
  track: number;                // first T/S
  sector: number;
  sizeSectors: number;
  sizeBytes: number;
  loadAddress?: number;
  sectorChain: DiskFileSectorLink[];
  relativePath: string;
  md5?: string;
  first16?: string;             // NEW — hex of first 16 bytes
  last16?: string;              // NEW — hex of last 16 bytes
  kindGuess?: string;           // NEW — heuristic ("exomizer_shared?", "prg_code?", ...)
  origin_detail?: {
    // origin="kernal": directory T/S the entry was parsed from
    // origin="custom": which LUT sector, entry index, raw 6-byte payload
  };
}
```

### New MCP tools

1. **`extract_disk_custom_lut`** — parameters:
   - `image_path`
   - `lut_track`, `lut_sector`
   - `entry_offset` (default 0), `entry_stride` (default 6),
     `entry_count` (default 42)
   - `payload_format` — one of:
     - `ts_size_load`  — `(track, sector, size_lo, size_hi, load_lo, load_hi)` (Lykia disk format)
     - `ts_load_size`  — `(track, sector, load_lo, load_hi, size_lo, size_hi)` (Lykia cart LUT)
     - `chained`       — first T/S, follow link chain like a DOS file
     - `raw`           — only `(track, sector)` + optional fixed `size`
   - `sentinel_payload` (optional hex) — payload that indicates an
     empty/deleted slot (for Lykia disk: `fefc0000`)
   - `output_dir`, merges into existing `manifest.json`

2. **`disk_sector_allocation`** — parameters:
   - `image_path`
   - Produces `{ "T/S": {owner, role, ...} }` map just like the Python
     tool currently does, using the combined `files` array in the
     manifest. Distinguishes `system` (BAM/dir/LUT sector),
     `kernal_file`, `custom_file`, `unclaimed_padding`, `orphan_data`.
     Marks overlaps as `overlaps: [...]`.

3. **`suggest_disk_lut_sector`** — heuristic scan across the whole
   image looking for sectors whose content matches plausible
   fixed-stride entry tables (valid T/S pairs, consistent stride,
   sentinel markers). Reports candidate `(T, S, stride, count)` tuples
   ranked by confidence. Analogue of the LUT-shape scan we ran on
   Lykia disk1.

### LLM role

The analysis + annotation LLM step should then be able to call
`extract_disk_custom_lut` once the drive-side loader has been RE'd,
or via heuristic suggestion from `suggest_disk_lut_sector` before
the loader code is fully decoded. It should also be able to set the
`kindGuess` / `origin_detail` fields from the current RE state, and
mark suspected secondary LUTs for follow-up extraction.

### Migration path

- Add the new fields (`origin`, `first16`, `last16`, `kindGuess`,
  `md5`) to the existing `ExtractedDiskFile` type and fill them from
  `extract_disk` too so KERNAL-side and custom-side descriptors have
  matching shape.
- Update `project-knowledge/view-builders.ts` disk-layout view to
  consume `origin` and colour-code in the UI. Current view is
  agnostic and works but doesn't distinguish KERNAL vs custom.
- Keep backwards-compat: if `origin` is missing, assume `"kernal"`.

## Other backlog

### `headless_runtime` trace speed

- `trace/runtime-trace.jsonl` is written one record per instruction.
  At ~700k instructions for an Exomizer-SFX depack the trace file
  bloats to tens of megabytes and write-I/O dominates the emulator
  step. Options:
  - Batch writes (buffer N records, flush periodically).
  - Switch to binary frame format.
  - Offer a `trace=off` or sampled mode for cases where only end-state
    memory matters.

### Stdio-server crash surface

- `src/cli.ts` now catches `uncaughtException` + `unhandledRejection`
  (commit 91c86f8). Still worth going through each `server-tools/*.ts`
  and wrapping long-running handlers so errors become proper tool
  errors instead of unhandled rejections.

### `inspect_disk` parity with `extract_disk` cycle-guard fix

- `extract_disk` now has a cycle guard (commit ff67f11). Verify
  `inspect_disk` and the disk-parser paths used by view-builders
  also terminate on self-referential T/S chains. The `parseDirectory`
  function already checks `(t,s) !== (0,0)` but doesn't maintain a
  visited set — an adversarial dir chain could still loop.

### Recognise more packer variants in `suggest_depacker`

- Current suggest_depacker doesn't recognise Lykia-disk packed files
  (streams with `00 XX` 2-byte prefix, Exomizer shared-encoding sets).
  Add heuristics for the common Lykia shared-encoding prefix
  `00 0C 40 3F ...` and similar.

### Undocumented-opcode emulation in `depack_exomizer_sfx`

- The TS 6502 emulator used by `depack_exomizer_sfx` fails with
  "Unimplemented opcode $3F" when a decruncher wrapper uses
  undocumented opcodes for size. Observed on Lykia disk1 file 01
  (the game main `$4000` self-extractor), which uses `$3F` RLA and
  several other undoc opcodes (ANC `$0B`, ISC `$FF`, RRA `$7B`,
  NOP-imm `$E2/$04`) inside its decrunch body.
- Extending the emulator to support the standard set of undoc 6502
  opcodes would let the MCP execute these custom wrappers.
