# Spec 755 — VICE `.vsf` snapshot interop (native codec)

**Status:** PROPOSED (2026-06-03) — split out of Spec 754 Block G (the monitor
`dump`/`undump` commands dispatch by extension; this is the `.vsf` codec they call).
**Owner:** runtime snapshot layer (`src/runtime/headless/snapshot.ts` + a new
`vsf/` codec)
**Reference:** VICE `src/snapshot.{c,h}` (container) + `src/c64/c64.c:1372`
`machine_write_snapshot` (the module list) + each device's
`*_snapshot_write_module` / `*_snapshot_read_module`.
**Cross-links:** Spec 707 (our `.c64re` snapshot — the sibling format `snap`/`unsnap`
writes), Spec 754 §3.3g (the `dump`/`undump` command surface), the VICE-oracle tools
(`vice_*`, the binmon we already drive).

## 0. Why
The user wants the monitor `dump`/`undump` to interoperate with VICE's snapshot
format, not only our `.c64re`:
- **`undump foo.vsf`** → load a VICE-captured state into OUR runtime (e.g. the
  `EF_Version_C/*.vsf` reference states from the Wasteland work — start our runtime
  exactly where VICE was).
- **`dump foo.vsf`** → write our state as a VICE-loadable snapshot → hand a precise
  moment to VICE for an oracle cross-check (fidelity work).

This is the natural interop point between our runtime and the VICE oracle.

## 1. The format (VICE)
`.vsf` = a module container (`snapshot.c`):
- Header: magic `"VICE Snapshot File\032"`, major/minor version, machine name
  (`"C64"`), optional VICE version string.
- Then N **modules**, each: name (16 bytes), major/minor module version, byte length,
  then the module's data. Readers skip unknown modules by length (forward-compat).
- C64 module set (`machine_write_snapshot` → each device): `C64MEM`, `CIA1`, `CIA2`,
  `VIC-II`, `SID`, `MAINCPU`, drive modules (`DRIVE`, `1541`, VIA/CPU/GCR), cartridge
  modules, optional `C64ROM` (when `save_roms`). Each module's exact byte layout is
  defined by its `*_snapshot_write_module` and is **version-stamped** — a reader must
  match the module version (or migrate).

## 2. Design
A native `vsf/` codec, two directions, mapping VICE modules ↔ our runtime state
(the same state `snap`/`unsnap` already serialize for `.c64re`, just a different
on-disk layout):
- **Reader** (`undump`): parse the container, dispatch each module to a
  `read<Module>` that writes our `Cpu65xxVice` / VIC literal port / CIA / SID /
  memory / 1541 state. Unknown/optional modules skipped by length.
- **Writer** (`dump`): emit the container + each module from our state, matching the
  VICE module version VICE expects to load. ROMs excluded by default (as VICE's
  `dump` does — "No ROM images are included").

Reuse the Spec 707 state-capture (our checkpoint already snapshots CPU/VIC/CIA/SID/
memory/drive) as the source/sink — only the byte layout differs.

## 3. Risks
- **Version fragility (the big one):** each VICE module has its own version; the
  vendored VICE tree (`tools/vice/…`) pins the versions we target. A VICE built
  elsewhere with newer module versions may not load our `dump` (and vice-versa).
  Pin + assert the module versions; surface a clear error on mismatch rather than a
  silent bad load.
- **Coverage:** some internal chip state we do not model identically to VICE
  (sub-cycle latches, exact pipeline) may have no clean mapping — document the lossy
  modules; round-trip-test what we can.
- **Drive:** VICE's drive modules are detailed; our VICE1541 port (Spec 612) is
  close, but the snapshot layout still needs explicit mapping.

## 4. Alternative (rejected as the primary)
**VICE-oracle bridge:** use a VICE process as the (de)serializer (push/pull our state
via the binmon, let VICE write/read the `.vsf`). Lighter (no native codec) but lossy
(binmon exposes RAM/regs/some chip state, not every internal) and needs a live VICE
process. Keep as a possible fallback for the WRITE direction; the native codec is the
faithful path.

## 5. Phases
- **P1 — reader (`undump foo.vsf`):** container parse + the core modules
  (`C64MEM`, `MAINCPU`, `CIA1/2`, `VIC-II`, `SID`) → our state. Acceptance: load a
  known VICE `.vsf` (e.g. an `EF_Version_C/*.vsf`) and our runtime renders/continues
  from that exact state.
- **P2 — writer (`dump foo.vsf`):** emit the same modules; round-trip
  (our state → `.vsf` → VICE loads it → screenshot matches).
- **P3 — drive + cartridge modules** (the 1541 + EF/cart state).

## 6. Non-goals
- Not a general all-machine VSF (C64 only first).
- Not bit-exact internal-pipeline fidelity where we don't model it — documented lossy.
- Not the `.c64re` format (that stays `snap`/`unsnap`, Spec 707).
