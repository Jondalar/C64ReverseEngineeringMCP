# Spec 423 — IEC Phase H: Validation

**Status:** GREEN (2026-05-12)
**Branch:** `vice-arch-port`
**Depends on:** 416-422 (all IEC phases)
**Doctrine:** 1:1 VICE IEC port.

## Status note (2026-05-12)

All 5 smokes implemented and passing:

- `smoke-423-bare-boot`: 9/9 PASS. Drive idles in $EBFD..$ECC0 window
  (16/16 samples). Bus: ATN released, DATA released. Doc-strict
  `cpu_port=0xFF / drv_port=0xFF` informational; observed cold-idle
  is `cpu_port=$80 / drv_port=$81` (= drive transiently holding CLK
  during $EBFF wait-for-disk debounce; matches VICE init `drv_port=0x85`
  per `src/iecbus/iecbus.c:199-203`). Frozen as golden.
- `smoke-423-load-directory`: 4/4 PASS. Blank D64. "BLOCKS FREE" +
  quoted disk-header rendered. ATN released post-UNTALK.
- `smoke-423-motm-canary`: 5/5 PASS. Final PC=$B7BF (= motm main
  loop, NOT KERNAL RX, NOT $042F stall).
- `smoke-423-krill-loader`: 5/5 PASS. Final PC=$93D4 (= Scramble
  Infinity game code).
- `smoke-423-fastloader-corpus`: 0/4 PASS, 4/4 SKIP-with-reason
  (= per OQ-423-1 resolution; user vendoring pending for Bitfire,
  Covert ×2, Comaland). Verdict PASS (= absent images = expected).

Golden masters under `samples/golden-master/spec-423/`: bare-boot,
load-directory, motm-canary, krill-loader (.golden.json + .screenram.bin
+ .png each). Capture-on-first-green per OQ-423-2.

MM s1 boot remains broken pre-existing (PC=$EEB2 KERNAL RX) — not
addressed by this validation spec; tracked separately.

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

- **OQ-423-1**: RESOLVED 2026-05-11 — user decision. **Curated
  subset** (= aligned with OQ-415-1):
  - Krill (covered via Scramble Infinity)
  - Bitfire (user-vendored demo disk)
  - Covert Bitops: `c64loader` (MIT) + `c64gameframework` (source
    builds → own deterministic test disk)
  - Comaland (scroll-stress demo)
  Other loaders skipped.
- **OQ-423-2**: RESOLVED 2026-05-11 — user decision.
  **Capture-on-first-green** strategy: on the first successful
  boot of each loader, record final PC + screen RAM hash + PNG
  as golden master under `samples/golden-master/<loader>/`. Future
  runs regression-check against frozen golden. User may later
  capture manual VICE x64sc reference (PC + VSF snapshot) once
  test images are vendored, replacing the auto-captured golden
  with a VICE-verified one.

## Files touched

- 5 new smokes under `scripts/smoke-423-*.mjs`.
- vendored fastloader test images.
- `specs/423-iec-phase-h-validation.md` (this)

## Next spec

None. Spec 423 = final phase of arch-port spec series. After 423
GREEN: branch is ready for merge or for picking up post-arch-port
features (write support, datasette, cartridges, NTSC, JiffyDOS,
multi-drive).
