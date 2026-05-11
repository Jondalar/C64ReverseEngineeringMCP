# Spec 415 — 1541 Phase I: Validation

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 407-414
**Doctrine:** 1:1 VICE TDE port.

## Goal

Validate the full 1541 drive port against VICE per
`docs/vice-1541-arch.md §13 Phase I` (steps 35–40).

## Doc anchor

- §13 Phase I (steps 35–40)
- §14 critical invariants (all 12)

## Canonical content (verbatim §13 Phase I)

35. Boot test: with no disk, drive should idle at $EBFF.
36. Format test: attach blank D64, do
    `OPEN 15,8,15,"N0:TEST,01"`.
37. Read test: known-good D64, `LOAD"$",8` then `LIST`.
38. Fastloader test: load via Krill / Bitfire / Sparkle / Hermes /
    Spindle / Booze / Bongo. These exercise tight ATN-handshake +
    custom serial bit-bang.
39. Copy-protection test: known-protected disks (Maniac Mansion
    G64, RoboCop G64). These exercise SYNC counting, RPM
    measurement, half-track reads.
40. Diff against VICE: same image, same input, dump drive CPU
    state every N cycles.

## VICE source cite

- VICE drive testprogs: vendored under
  `samples/vice-testprogs/` per memos.

## Audit — current TS state

- Lorenz Disk1 CPU tests: 100% PASS.
- VICE drive testprogs: 4/4 PASS (per memo `feedback_truedrive_101`).
- motm (G64 fastloader, AB-fastloader at $4278): boots
  (memo `motm-via1-ca1`).
- MM s1 (G64, copy-protected, half-track 35+): character select
  rendered.
- Scramble Infinity (D64, Krill loader): title rendered.

Gaps:

- Idle-at-$EBFF: not explicitly asserted; likely true if smoke
  passes but worth asserting.
- Format test: probably absent (read-only).
- LOAD"$",8 + LIST: probably absent as a smoke.
- Other fastloaders (Bitfire, Sparkle, Hermes, Spindle, Booze,
  Bongo): not in corpus.

## Producer changes

This spec adds smokes + corpus, no source changes.

1. `scripts/smoke-415-boot-idle.mjs`: no-disk reset, advance N
   cycles, assert drive PC == $EBFF.
2. `scripts/smoke-415-load-directory.mjs`: known D64, send
   `LOAD"$",8`, capture screen, assert directory listing visible.
3. `scripts/smoke-415-fastloaders.mjs`: corpus of fastloader-
   demos (Krill demo, Bitfire test, etc.). Verify load completes.
4. `scripts/smoke-415-drive-diff-trace.mjs`: per-cycle drive CPU
   state diff vs canned VICE trace for chosen canary (motm boot).
5. Format test deferred to write-support spec (post-arch-port).

## Acceptance

- Build clean.
- All existing smokes pass.
- New smokes 415-{boot-idle, load-directory, fastloaders,
  drive-diff-trace}: PASS.
- MM + Scramble titles rendered.

## Open Questions

- **OQ-415-1**: RESOLVED 2026-05-11 — user decision. Vendor a
  **curated subset**: Krill (already covered via
  `samples/scramble_infinity.d64`), Bitfire (vendor demo disk),
  covertbitops (vendor demo disk), and **Comaland** (= demo with
  horizontal scrolling, known cycle-exact stress test referenced in
  bmc64 TESTING.md). User downloads + places under
  `samples/fastloader-tests/` (Bitfire, covertbitops, Comaland).
  Other loaders (Sparkle, Hermes, Spindle, Booze, Bongo) skipped —
  covered by motm AB-fastloader + the chosen 4 for ATN-handshake +
  custom-serial breadth + scroll-stress.
- **OQ-415-2**: RESOLVED 2026-05-11 — doc §17, §9. Format/write
  test correctly deferred. VICE has the write-back path
  (`drive_gcr_data_writeback`, `fsimage-create.c:516,567`,
  `driveimage.c:230`) but our TS port is read-only (memo
  `drive-write-support.md` archived). Phase I step 36 deferred to
  a post-arch-port write-support spec.
- **OQ-415-3**: RESOLVED 2026-05-11 — user decision. No GitHub CI.
  Tests run locally. **Per-spec budget** (= spec 406 decision):
  this Phase I validation spec runs **10M drive cycles** for the
  drive-diff-trace canary (~10 sec wall-time). Other 1541 specs
  use 100k (core) / 1M (rotation, VIA) per their own acceptance.

## Files touched

- 4 new smokes under `scripts/smoke-415-*.mjs`.
- vendored fastloader test corpus under
  `samples/fastloader-tests/` (new dir).
- `specs/415-1541-phase-i-validation.md` (this)

## Next spec

Spec 416 — IEC Phase A: IEC bus shared state.
