# Spec 423 — IEC Phase H: Validation

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 416-422 (all IEC phases)
**Doctrine:** 1:1 VICE IEC port.

## Goal

Validate full C64 ↔ 1541 IEC path per
`docs/vice-iec-arc42.md §15 Phase H` (steps 18–21).

## Doc anchor

- §15 Phase H (steps 18–21)
- §10 quality tree (cross-cutting concerns)
- §16 cross-doc invariant index

## Canonical content (verbatim §15 Phase H)

18. Test 1: bare boot. C64 boots, drive idles at $EBFF. Bus is at
    `cpu_port = 0xFF`, `drv_port = 0xFF` (all released).
19. Test 2: `LOAD"$",8`. Triggers full ATN handshake, LISTEN,
    SECOND, UNLISTEN, TALK byte-receive, UNTALK. Drive responds
    with directory.
20. Test 3: motm-class fastloader (24-bit serial receive at $042F).
    This is the canary; if push-flush, ATN-IRQ, and CA1 stamping
    are all correct, motm boots. If any one is wrong, motm hangs
    at the receive loop.
21. Test 4: copy-protected loader (Krill, Bitfire, Sparkle,
    Spindle, Booze, Hermes). Each exercises ATN-handshake +
    custom serial + occasionally RPM measurement.

## VICE source cite

- Per-test setup: not VICE-source, but VICE testprogs / sample
  disks should be vendored.

## Audit — current TS state

Status (per memos + current branch):

- Test 1 (bare boot): drive idles correctly (verified at MM s1
  test cold reset).
- Test 2 (LOAD"$",8): KERNAL LOAD path works (= part of MM/Scramble
  boot which uses LOAD"*",8,1).
- Test 3 (motm 24-bit serial): motm boots (memo `motm-via1-ca1` =
  FIXED 2026-05-08).
- Test 4 (Krill): Scramble Infinity boots (= Krill loader per
  memos).

## Producer changes

This spec adds smokes, no source.

1. `scripts/smoke-423-bare-boot.mjs`: cold reset, no disk,
   advance 5M cycles, assert `iecbus.cpu_port == 0xFF` and
   drive idle at $EBFF.
2. `scripts/smoke-423-load-directory.mjs`: blank D64 attach,
   `LOAD"$",8`, capture screen, assert directory header visible.
3. `scripts/smoke-423-motm-canary.mjs`: motm G64 attach, boot,
   advance to title; check PC inside motm code area (= not stuck
   in KERNAL receive loop).
4. `scripts/smoke-423-krill-loader.mjs`: Scramble Infinity D64
   attach, boot, advance to "Loader music" credit; check PC in
   game code.
5. `scripts/smoke-423-fastloader-corpus.mjs`: extension corpus
   (Bitfire, Sparkle, Hermes, Spindle, Booze, Bongo demos when
   vendored). Each completes boot.

## Acceptance

- Build clean.
- All existing smokes pass.
- New 423-* smokes pass.
- MM s1 (= copy-protected G64) + Scramble Infinity (= Krill D64) +
  motm (= AB-fastloader) all boot to expected stage.

## Open Questions

- **OQ-423-1**: Fastloader test corpus availability — vendor under
  `samples/fastloader-tests/`.
- **OQ-423-2**: Per-test PC checkpoints — pin known-good PC values
  for each fastloader (= regression guard).

## Files touched

- 5 new smokes under `scripts/smoke-423-*.mjs`.
- vendored fastloader test images.
- `specs/423-iec-phase-h-validation.md` (this)

## Next spec

None. Spec 423 = final phase of arch-port spec series. After 423
GREEN: branch is ready for merge or for picking up post-arch-port
features (write support, datasette, cartridges, NTSC, JiffyDOS,
multi-drive).
