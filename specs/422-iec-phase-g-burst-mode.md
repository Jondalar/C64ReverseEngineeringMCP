# Spec 422 — IEC Phase G: Burst mode (optional)

**Status:** PROPOSED (optional within arch-port; required for
JiffyDOS)
**Branch:** `vice-arch-port`
**Depends on:** 421
**Doctrine:** 1:1 VICE IEC port.

## Goal

Implement burst-mode parallel path per
`docs/vice-iec-arc42.md §15 Phase G` (step 17) and §5.8.

## Doc anchor

- §15 Phase G
- §5.8 burst mode
- §13 out-of-scope notes

## Canonical content (verbatim §15 Phase G)

17. Implement `c64fastiec_fast_cpu_write` for CIA SDR rerouting per
    §5.8. Burst is a parallel path; bit-bang IEC stays active for
    ATN handshake.

## VICE source cite

- `c64fastiec_fast_cpu_write`: `src/c64/c64fastiec.c`.

## Audit — current TS state

Status:

- Burst mode: not implemented. No JiffyDOS support.
- Game corpus in scope (MM, Scramble, motm, IM2, LNR) uses bit-bang
  IEC + custom fastloaders, not burst.

## TS extras to DELETE

- None (burst not present).

## NTSC stub

- None.

## Producer changes

This spec is **optional**. Recommended deferral:

- Mark burst as "post-arch-port" follow-up.
- Stub `c64fastiec_fast_cpu_write` with `// not implemented;
  JiffyDOS not in scope` so call sites compile.

## Consumer changes

- CIA SDR write callback can be a no-op stub.

## Acceptance

- Build clean (= stub satisfies type contract).
- No new smoke required.
- MM + Scramble unchanged (don't use burst).

## Open Questions

- **OQ-422-1**: Is JiffyDOS in scope? Currently no game in corpus
  uses it. Decision: defer.

## Files touched

- `src/runtime/headless/iec/iec-fast.ts` (new stub)
- `specs/422-iec-phase-g-burst-mode.md` (this)

## Next spec

Spec 423 — IEC Phase H: Validation.
